#!/usr/bin/env node
/* 实时对战 · 开盅结算链路回归（零 token、不触网、不碰任何模型端点）
 *
 * 为什么单独有它：这一轮修掉的三个 bug 全在同一条链上 ——
 *   ① 开盅时「谁喊的 / 谁开的」归属错（页面印成同一个人）
 *   ② 「够 / 不够」的判负方向写反（够数其实是开的人输）
 *   ③ 开盅之后下一手不再问玩家（前端把按钮抹掉了，只能干等到超时）
 * 跑批层的 test-rules 只验引擎数值，房间层的事件归属与前端渲染都在它之外，
 * 所以这里把「事件归属 → 结算方向 → 结算后一定再次问到人」三段不变式钉住；
 * 前端渲染与文案同源由 tests/ui-round-cycle.js（真浏览器）加本文件的 [5] 静态断言负责。
 *
 * 覆盖清单：
 *  [1] 开盅事件归属：bidBy == 这一轮最后一手喊价的座位（按 plan 换算），openedBy == 行动者；
 *      并与事件流里最后一条 bid 对齐（plan / 个数 / 点数三项都要一致）
 *  [2] 结算方向不变式：够数(truth) → 输家是开盅人；不够 → 输家是喊价人；
 *      两个分支都必须真被打到，否则算覆盖不足（防止只对一半）
 *  [3] 结算后不再静默：整局在远小于思考时限内打完、全程没有超时自动接手，
 *      且座位收到的 ask 次数与它实际落过的手数一致（不多不少，最多多一次未答的收尾 ask）
 *  [4] 复式换座：归属按「人」不按「椅子」，第二把换座后仍按 plan 换算
 *  [5] 文案与规则表同源：判定文本与 src/dice-rulesets.js 一致；渲染必须取 bidBy/openedBy
 */
'use strict';
process.env.DICE_BOT_DELAY_MS = '0';         // 人机别装思考延迟，测试才不会被拖慢
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.dirname(__dirname);
const { Registry } = require(ROOT + '/src/rooms.js');
const { Vault } = require(ROOT + '/src/secrets.js');
const { Accounts } = require(ROOT + '/src/accounts.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra).slice(0, 400))); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// SSE 汇：按 wire 格式解回事件（与 test-live-pvp 同一口径，顺便验线上格式真能解析）
function mkSink() {
  const buf = [];
  return {
    write(s) { buf.push(String(s)); return true; },
    end() { }, removeListener() { }, on() { }, once() { }, destroy() { },
    events() {
      const out = [];
      for (const chunk of buf) {
        const m = chunk.match(/^id: (\d+)\nevent: (\w+)\ndata: ([\s\S]*)\n\n$/);
        if (m) out.push({ id: +m[1], type: m[2], data: JSON.parse(m[3]) });
      }
      return out;
    },
  };
}
function makeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dice-settle-'));
  const vault = new Vault(dir), accounts = new Accounts(dir, vault);
  const reg = new Registry({
    vault, accounts, policy: { localPorts: [9], allowHosts: [] },
    presets: () => ({ list: [], ruleSets: [] }),
    recordFile: path.join(dir, 'matches-live.jsonl'),
  });
  reg.dir = dir;
  reg.owner = accounts.signup('settle' + Math.random().toString(36).slice(2, 7), 'pass1234').user;
  return reg;
}

/* 打一整桌：A 座真人（收到 ask 就立刻走），B 座内置人机。
 * 返回座位 A 收到的事件、观战全知的事件、以及整局耗时与有没有被超时接手。 */
async function playTable(opts = {}) {
  const reg = makeRegistry();
  const room = reg.create({
    seats: { A: { kind: 'me', nick: '甲玩家' }, B: { kind: 'bot', bot: opts.bot || 'oracle' } },
    rules: 'flex', hpMax: opts.hpMax || 5, turnMs: 60000, maxRounds: opts.maxRounds || 20,
    duplicate: !!opts.duplicate, deals: opts.duplicate ? 2 : 1,
  }, reg.owner);
  const sinkA = mkSink(), sinkSpec = mkSink();
  reg.subscribe(room, sinkA, 'A', null);
  reg.subscribe(room, sinkSpec, 'spec', null);
  room.seats.A.ready = true; room.seats.B.ready = true;
  const t0 = Date.now();
  const started = await reg.start(room.code, { token: room.seats.A.token });
  if (!started.ok) return { started };
  let guard = 4000;
  while (guard-- > 0 && room.state === 'playing') {
    const actor = reg.actorOfPlan(room, 'A');
    if (actor && actor.waiting && actor.waiting()) {
      const asks = sinkA.events().filter(e => e.type === 'ask');
      const last = asks.filter(e => e.type === 'ask').pop();
      if (last) {
        const legal = (last.data.view || {}).legal || [];
        // 一半概率开盅：让「开盅」这条路径被真打到，而不是只喊价
        const pick = (Math.random() < 0.5 && legal.find(a => a.type === 'open')) || legal.find(a => a.type === 'bid') || legal.find(a => a.type === 'open');
        if (pick) actor.submit(pick);
      }
    }
    await sleep(4);
  }
  const ms = Date.now() - t0;
  let g2 = 1000;
  while (g2-- > 0 && room.state !== 'finished' && room.state !== 'aborted') await sleep(5);
  return { reg, room, ms, A: sinkA.events(), S: sinkSpec.events(), started };
}

(async () => {
  console.log('[1] 开盅事件归属 + [2] 结算方向');
  let opens = 0, truthSeen = 0, lieSeen = 0, attrBad = 0, dirBad = 0, mismatch = null;
  for (const seed of [1, 2, 3]) {
    const r = await playTable({ bot: seed === 2 ? 'reader' : 'oracle', hpMax: 5 });
    ok(r.started && r.started.ok, '桌 ' + seed + ' 开局成功', r.started);
    if (!r.started || !r.started.ok) continue;
    // 每条 open 之前，事件流里最后一条 bid 必须就是被开的那一手
    let lastBid = null;
    for (const e of r.S) {
      if (e.type === 'bid') { lastBid = e.data; continue; }
      if (e.type !== 'open') continue;
      const d = e.data; opens++;
      if (!d.bidBy || !d.openedBy || !d.loser) { attrBad++; mismatch = mismatch || { why: '缺字段', d }; continue; }
      if (d.truth) truthSeen++; else lieSeen++;
      // 归属：开盅人不能是被开那手的喊价人（引擎不允许自己开自己喊的价），且与流里的最后一条 bid 对齐
      const bidSeat = lastBid && (lastBid.seat || lastBid.who || lastBid.plan);   // 事件里座位字段叫 seat / who（plan 是旧名）
      if (lastBid && (bidSeat !== d.bidBy || lastBid.count !== d.bid.count || lastBid.face !== d.bid.face)) {
        attrBad++; mismatch = mismatch || { why: '与 bid 事件不一致', lastBid, open: { bidBy: d.bidBy, openedBy: d.openedBy, bid: d.bid } };
      }
      if (d.seat && d.seat !== d.openedBy) { attrBad++; mismatch = mismatch || { why: 'seat 应当是开盅这一手的行动者', d }; }
      if (d.bidBy === d.openedBy) { attrBad++; mismatch = mismatch || { why: '喊价人与开盅人同一座', d }; }
      // 方向：够数 → 开的人输；不够 → 喊的人输
      const wantLoser = d.truth ? d.openedBy : d.bidBy;
      if (d.loser !== wantLoser) { dirBad++; mismatch = mismatch || { why: '判负方向不对', d, wantLoser }; }
    }
  }
  ok(opens >= 6, '开盅样本足够多（' + opens + ' 次）', opens);
  ok(attrBad === 0, '每一条开盅的「谁喊 / 谁开」都对得上（错 ' + attrBad + ' 条）', mismatch);
  ok(dirBad === 0, '判负方向与规则一致：够数→开的人输，不够→喊的人输（错 ' + dirBad + ' 条）', mismatch);
  ok(truthSeen > 0 && lieSeen > 0, '两个分支都被真打到（够数 ' + truthSeen + ' 次 / 不够 ' + lieSeen + ' 次）', { truthSeen, lieSeen });

  console.log('[3] 结算后一定再次问到人（不许静默）');
  {
    const r = await playTable({ bot: 'reader', hpMax: 4, maxRounds: 12 });
    const asks = r.A.filter(e => e.type === 'ask').length;
    const bidsA = r.S.filter(e => e.type === 'bid' && (e.data.seat || e.data.who) === 'A').length;
    const opensA = r.S.filter(e => e.type === 'open' && (e.data.openedBy || e.data.seat || e.data.who) === 'A').length;
    const timeouts = r.A.filter(e => e.type === 'notice' && e.data.kind === 'timeout');
    const acts = bidsA + opensA;
    ok(acts > 0, '这一桌 A 座真落过子（喊 ' + bidsA + ' 手 + 开 ' + opensA + ' 次）', { bidsA, opensA });
    ok(asks >= acts && asks - acts <= 1, 'ask 次数与落子次数一致（ask ' + asks + ' vs 落子 ' + acts + '）', { asks, bidsA, opensA });
    ok(timeouts.length === 0, '全程没有一次超时自动接手（说明没有哪一手被卡住）', timeouts.slice(0, 2));
    ok(r.ms < 15000, '整桌在思考时限（60s）之前打完（' + r.ms + 'ms）—— 卡住的话这里必然超时', r.ms);
    const opens2 = r.S.filter(e => e.type === 'open');
    let dangling = null;
    for (const o of opens2) {
      const idx = r.S.indexOf(o);
      const after = r.S.slice(idx + 1);
      if (!after.some(e => ['ask', 'round', 'bid', 'gameover', 'matchover'].includes(e.type))) dangling = dangling || o;
    }
    ok(!dangling, '每一次开盅之后事件流都继续动（没有哪次开完就静默）', dangling);
  }

  console.log('[4] 复式换座：归属按人，不按椅子');
  {
    const r = await playTable({ bot: 'oracle', hpMax: 4, maxRounds: 10, duplicate: true });
    const games = r.S.filter(e => e.type === 'game').length;
    ok(games === 2, '复式打了两把（换座位）', games);
    let bad = null, n = 0;
    let lastBid = null;
    for (const e of r.S) {
      if (e.type === 'bid') { lastBid = e.data; continue; }
      if (e.type !== 'open') continue;
      n++;
      const bs = lastBid && (lastBid.seat || lastBid.who || lastBid.plan);
      if (bs && bs !== e.data.bidBy) bad = bad || { lastBid, open: e.data };
      if (e.data.bidBy === e.data.openedBy) bad = bad || { why: '同一座', open: e.data };
    }
    ok(!bad && n > 0, '换座后每条开盅仍按「人」归属（查 ' + n + ' 条）', bad);
  }

  console.log('[5] 文案与规则表同源（防漂回旧口径）');
  {
    const rulesTxt = fs.readFileSync(path.join(ROOT, 'src/dice-rulesets.js'), 'utf8');
    const playTxt = fs.readFileSync(path.join(ROOT, 'web/play.js'), 'utf8');
    ok(/够数 → 开的人输；不够 → 喊的人输/.test(rulesTxt), '规则表文本是「够数→开的人输；不够→喊的人输」');
    ok(/够数：开的人输/.test(playTxt) && /不够：喊的人输/.test(playTxt), '玩家页用的判定文本与规则表一致');
    ok(!/喊的人赢/.test(playTxt), '玩家页不再有「喊的人赢」这类反向文案');
    ok(!/够（喊的人输）|(?<!不)够：喊的人输/.test(playTxt), '玩家页不再有「够：喊的人输」这类反向文案');
    ok((playTxt.match(/nm\(bidByOf\(d\), d\)/g) || []).length >= 2, '开盅记录与亮牌块都取 bidBy 当喊价人');
    ok((playTxt.match(/nm\(openByOf\(d\), d\)/g) || []).length >= 2, '开盅记录与亮牌块都取 openedBy 当开盅人');
    ok(!/seatName\(d\.seat\)\)? 喊/.test(playTxt), '不再拿事件里的 seat 当喊价人（旧写法会让两个名字印成同一个）');
    // 提交回调不许无条件覆盖出价区：必须先看有没有收到过新的 ask
    ok(/const seq = S\.askSeq;[\s\S]{0,600}if \(S\.askSeq !== seq\)/.test(playTxt),
      '提交开盅/喊价的回调按 askSeq 让路（ask 已把下一手推进来时不得抹掉按钮）');
    // 全场流水是玩家最常回看的一栏：开盅那一行必须把两边骰子带出来（数据来自 reveal.dice，未开盅不下发）
    ok(/revealDiceHtml\(d\)\s*\)/.test(playTxt) && /r\.dice\[k\]/.test(playTxt) && /lg-dice/.test(playTxt),
      '全场流水的开盅行带双方骰子（revealDiceHtml）');
  }

  /* 事故：换桌后右座挂着上一局的「人机 0 血 · 倒下」，中间喊价卡是「4 个 3」，
     本轮序列却是「2 个 6」——观战全知快照 S.omni 一旦赋值就不再作废，
     坐进座位后它还在压着实时数据。这几条钉住「omni 只喂观战视角 + 换桌换局必须清残留」。 */
  console.log('[6] 观战快照不许串到自己桌上');
  {
    const playTxt = fs.readFileSync(path.join(ROOT, 'web/play.js'), 'utf8');
    const roomTxt = fs.readFileSync(path.join(ROOT, 'src/rooms.js'), 'utf8');
    ok(!/const hp = \(S\.omni && S\.omni\.hp\)/.test(playTxt), 'renderHp 不再无条件优先吃 S.omni');
    ok(/S\.plan === 'spec' && S\.omni && S\.omni\.hp/.test(playTxt), '血量只在观战时取 S.omni');
    ok(/S\.plan === 'spec' && S\.omni && S\.omni\.turn/.test(playTxt), '「轮到谁」只在观战时取 S\.omni');
    ok(/omni = watching \? S\.omni : null/.test(playTxt), 'renderView 的 omni 只对观战生效');
    ok(/if \(S\.plan !== 'spec'\) \{ S\.omni = null; return; \}/.test(playTxt), '坐进座位后收到 omni 直接丢弃');
    ok(/function resetTable\(/.test(playTxt), '有 resetTable：换桌/换局的残留清理入口');
    ok(/on\('game'[\s\S]{0,120}resetTable\(\)/.test(playTxt), '每开新一局先清残留（上一把的 0 血不许带进新局）');
    ok(/d\.room\.code !== oldCode\) resetTable\(\{ room: true \}\)/.test(playTxt), '换房间清残留（含全场流水）');
    // 服务端：开盅事件里的输家按 plan 给，别给椅子号（复式换座时「剩 X 血」会安到别人头上）
    ok(/clean\.loser = ev\.loser \? this\.planOfChair\(room, ev\.loser\) : null/.test(roomTxt), '开盅事件输家按 plan 归属');
  }

  console.log(fail ? '==> SETTLE REGRESSION FAIL ' + fail : '==> ALL PASS');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('自检炸了：', e && e.stack || e); process.exit(1); });
