/* 实时对战平台回归（零 token、不触网）
 * [1] 视角隐私：座位只拿得到自己那份；观战拿不到本轮骰子；广播不带 truth
 * [2] 人类座位：打完整局 / 非法拒收 / 超时自动接手 / 认输判负
 * [3] 房间：真人 vs 内置人机打完整局，事件按身份过滤、落盘战绩
 * [4] 复式：同骰两把换座位，净胜血按人累计
 * [5] 座位混排装配：me / llm / preset / bot 任意组合都能造出演员；出网策略拦内网
 * [6] Parity：平台路径与 src/pk.js 同种子逐手一致（评测口径不漂移）
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

const E = require('../src/dice-engine.js');
const B = require('../src/bots.js');
const C = require('../src/context.js');
const V = require('../src/view.js');
const { runMatch } = require('../src/runner.js');
const { makeHumanPlayer } = require('../src/human.js');
const { Vault } = require('../src/secrets.js');
const { Accounts } = require('../src/accounts.js');
const { Registry } = require('../src/rooms.js');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg, extra == null ? '' : '  ← ' + JSON.stringify(extra).slice(0, 260)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = tag => fs.mkdtempSync(path.join(os.tmpdir(), 'guidie-' + tag + '-'));

// SSE 汇：按 wire 格式解回事件（顺便验线上格式真的可解析）
function mkSink() {
  const buf = [];
  return {
    write(s) { buf.push(String(s)); return true; },
    end() { },
    events() {
      const out = [];
      for (const chunk of buf) {
        const m = chunk.match(/^id: (\d+)\nevent: (\w+)\ndata: ([\s\S]*)\n\n$/);
        if (m) out.push({ id: +m[1], type: m[2], data: JSON.parse(m[3]) });
      }
      return out;
    },
    text() { return buf.join(''); },
  };
}
function humanWithAsk(cfg) {
  let p = null;                      // io 回调闭包指向真正那个座位实例
  const io = {
    ask: (who, view, meta) => { if (p) { p.__view = view; p.__meta = meta; } },
    notice: (who, note) => { if (p) (p.__notices = p.__notices || []).push(Object.assign({ seat: who }, note || {})); },
  };
  p = makeHumanPlayer(Object.assign({}, cfg, { io }));
  return p;
}
// 后台驱动人类座位：每次轮到他就用「合法首选项」落子；可顺带试一次非法行动
async function driveHumans(matchPromise, humans, opt = {}) {
  let rejected = 0, steps = 0, guard = opt.guard || 6000;
  while (guard-- > 0) {
    const done = await Promise.race([matchPromise.then(() => 'done'), sleep(3).then(() => 'go')]);
    for (const h of humans) {
      if (!h.waiting() || !h.__view) continue;
      const legal = h.__view.legal || [];
      if (opt.tryIllegal) {
        const r = h.submit({ type: 'bid', count: 2, face: 1, mode: 'breakZhai' });
        if (!r.ok) rejected++; else if (r.ok && opt.tryIllegal === 'strict') { rejected = -1; }
      }
      const pick = opt.pick === 'open' ? legal.find(a => a.type === 'open') : (legal.find(a => a.type === 'bid') || legal.find(a => a.type === 'open'));
      if (pick) { if (h.submit(pick).ok) steps++; }
    }
    if (done === 'done') break;
  }
  return { rejected, steps };
}
async function waitFor(cond, ms, tag) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(10); }
  return false;
}
function makeRegistry(o = {}) {
  const dir = tmp('reg');
  const vault = new Vault(dir);
  const accounts = new Accounts(dir, vault);
  const reg = new Registry({
    vault, accounts,
    policy: { localPorts: [9], allowHosts: [] },
    presets: () => ({ list: [{ id: 'p-test', alias: '测试模型', base: 'http://127.0.0.1:9/v1', model: 'm-test', apiKey: 'SECRETPRESETKEY' }], ruleSets: [] }),
    recordFile: o.recordFile || path.join(dir, 'matches-live.jsonl'),
  });
  reg.dir = dir;
  reg.owner = accounts.signup('tester' + Math.random().toString(36).slice(2, 7), 'pass1234').user;
  return reg;
}

/* ---------------- [1] 视角隐私 ---------------- */
console.log('[1] 视角隐私');
{
  const m = E.newMatch({ hpMax: 8, firstBidder: 'A', rules: 'flex' });
  E.startRound(m, E.mulberry32(7));
  const vA = V.viewFor(m, 'A'), pub = V.publicView(m);
  ok(JSON.stringify(vA).indexOf(JSON.stringify(m.round.dice.B)) < 0, 'A 的视角里查不到 B 的骰子');
  ok(vA.dice.length === 5 && !('oppDice' in vA), 'A 只拿到自己 5 颗，没有 oppDice 字段');
  ok(JSON.stringify(pub).indexOf(JSON.stringify(m.round.dice.A)) < 0 && JSON.stringify(pub).indexOf(JSON.stringify(m.round.dice.B)) < 0, '观战视图不含本轮任何一方骰子');
  ok(vA.legal.length === E.legalActions(m.round).length && vA.legal.every(a => a.label), '合法行动与引擎同集合且带标签');
  const s = V.sanitizeEvent({ kind: 'bid', who: 'A', count: 3, face: 4, zhai: false, truth: true, asks: 2, attempts: [{ ms: 1 }] });
  ok(!('truth' in s) && !('asks' in s) && !('attempts' in s), '广播前剥掉 truth / asks / attempts', s);
  ok(s.count === 3 && s.face === 4 && s.kind === 'bid', '剥完仍保留落子事实');
  const hist = { no: 1, bid: { by: 'A', count: 3, face: 4 }, opener: 'B', actual: 2, truth: false, loser: 'A', winner: 'B', dice: { A: [1, 2, 3, 4, 5], B: [6, 6, 6, 6, 6] }, zhai: false, slash: false, stake: 1 };
  ok(V.historyView(hist, 'A').dice.opp.length === 5, '只有已结算轮次才带对方骰子');
}

/* ---------------- [2] 人类座位 ---------------- */
console.log('[2] 人类座位接进 runner');
(async () => {
  { // 2a 完整局
    const h = humanWithAsk({ nick: '小潘', timeoutMs: 60000 });
    const pr = runMatch({ A: h, B: B.makeBot('reader') }, E.mulberry32(1234), { hpMax: 6, maxRounds: 20, rules: 'flex', firstBidder: 'A' });
    const d = await driveHumans(pr, [h]);
    const res = await pr;
    ok(res.rounds > 0 && !res.ungraded, '人类 vs 内置人机 打到自然结束（' + res.rounds + ' 轮，胜者 ' + (res.winner || '平') + '）');
    ok(d.steps > 0 && d.steps === res.stats.A.steps, '人类提交的每一手都被采纳（' + d.steps + ' 手）', d);
  }
  { // 2b 非法拒收
    const h = humanWithAsk({ nick: '甲', timeoutMs: 60000 });
    const pr = runMatch({ A: h, B: B.makeBot('reader') }, E.mulberry32(99), { hpMax: 6, maxRounds: 20, rules: 'flex', firstBidder: 'A' });
    let tried = false, rejected = null;
    let guard = 4000;
    while (guard-- > 0 && !tried) {
      if (h.waiting() && h.__view) {
        rejected = h.submit({ type: 'bid', count: 99, face: 3 });
        const legal = h.__view.legal;
        const wrong = legal.find(a => a.type === 'bid') ? { type: 'bid', count: 2, face: 1, mode: 'breakZhai' } : null;
        const r2 = wrong ? h.submit(wrong) : null;
        tried = true;
        ok(rejected.ok === false && /范围|不合法/.test(rejected.reason), '越界行动被拒（' + rejected.reason + '）', rejected);
        if (r2) ok(r2.ok === false, '规则不允许的「破斋」被拒（服务端不猜玩家意图）', r2);
        ok(h.waiting(), '被拒之后仍然等他重新走，不替他落子');
      }
      await sleep(2);
    }
    // 收尾：正常打完
    const d = await driveHumans(pr, [h]);
    await pr;
    ok(tried, '非法拒收分支被覆盖到');
  }
  { // 2c 超时自动接手
    const h = humanWithAsk({ nick: '慢手', timeoutMs: 60, onTimeout: 'auto' });
    const pr = runMatch({ A: h, B: B.makeBot('reader') }, E.mulberry32(7), { hpMax: 2, maxRounds: 2, rules: 'flex', firstBidder: 'A' });
    const res = await pr;
    ok(!res.ungraded && res.rounds > 0, '人不提交也能靠自动接手打完（' + res.rounds + ' 轮）');
    ok((h.__notices || []).filter(n => n.kind === 'timeout').length > 0, '自动接手会广播 timeout 通知', (h.__notices || []).slice(0, 2));
  }
  { // 2d 认输（无头层口径：解开挂起的一手并记一次 forfeit；整局判负由房间层负责，见 [3b]）
    const h = humanWithAsk({ nick: '认输哥', timeoutMs: 60000 });
    const pr = runMatch({ A: h, B: B.makeBot('reader') }, E.mulberry32(55), { hpMax: 4, maxRounds: 8, rules: 'flex', firstBidder: 'A' });
    let guard = 3000, did = false;
    while (guard-- > 0 && !did) { if (h.waiting()) { ok(h.resign() === true, '认输解开了挂起的那一手'); did = true; } else await sleep(2); }
    await driveHumans(pr, [h]);
    const res = await pr;
    ok(res.stats.A.forfeits >= 1 && res.losses.A >= 1, '无头层认输 = 判负一手 + 掉血，对局继续（整局判负在房间层）',
      { f: res.stats.A.forfeits, losses: res.losses });
  }

  /* ---------------- [3] 房间：真人 vs 人机 ---------------- */
  console.log('[3] 房间：真人 vs 内置人机');
  {
    const reg = makeRegistry();
    const room = reg.create({
      seats: { A: { kind: 'me', nick: '甲玩家' }, B: { kind: 'bot', bot: 'reader' } },
      rules: 'flex', hpMax: 8, turnMs: 60000, maxRounds: 30, duplicate: false, deals: 1,
    });
    const sinkA = mkSink(), sinkSpec = mkSink();
    reg.subscribe(room, sinkA, 'A', null);
    reg.subscribe(room, sinkSpec, 'spec', null);
    const started = await reg.start(room.code, { token: room.seats.A.token });
    ok(started.ok, '房主凭座位令牌开局', started);
    const humanActor = reg.actorOfPlan(room, 'A');
    let guard = 6000;
    while (guard-- > 0 && room.state === 'playing') {
      if (humanActor && humanActor.waiting && humanActor.waiting()) {
        const evs = sinkA.events();
        const last = evs.filter(e => e.type === 'ask').pop();
        if (last) {
          const legal = last.data.view.legal || [];
          const pick = legal.find(a => a.type === 'bid') || legal.find(a => a.type === 'open');
          if (pick) humanActor.submit(pick);
        }
      }
      await sleep(5);
    }
    const done = await waitFor(() => room.state === 'finished' || room.state === 'aborted', 8000, 'finish');
    ok(done && room.state === 'finished', '真人 + 人机打到整桌结束', { state: room.state });

    const evA = sinkA.events(), evS = sinkSpec.events();
    const types = new Set(evS.map(e => e.type));
    ok(['game', 'round', 'bid', 'open', 'gameover', 'matchover'].every(t => types.has(t)), '房间层事件流齐全：' + [...types].join(','));
    const asks = evA.filter(e => e.type === 'ask');
    ok(asks.length > 0, '座位 A 收到 ask（' + asks.length + ' 次）');
    // 隐私：ask 里绝不含对手当轮骰子
    const hist = (evS.filter(e => e.type === 'gameover').pop() || { data: {} }).data.history || [];
    let leak = null;
    for (const a of asks) {
      const v = a.data.view;
      const r = hist.find(h => h.no === v.roundNo);
      if (r && r.dice && JSON.stringify(a.data).indexOf(JSON.stringify(r.dice.opp)) >= 0) { leak = { roundNo: v.roundNo }; break; }
      if (r && v.history.some(h => h.no === v.roundNo)) { leak = { round: '本局未结算却进了 history' }; break; }
    }
    ok(!leak, 'ask 视角里没有对手未结算骰子', leak);
    const bids = evS.filter(e => e.type === 'bid');
    ok(bids.length > 0 && bids.every(b => !('truth' in b.data)), '公开 bid 事件不带 truth');
    const opens = evS.filter(e => e.type === 'open');
    ok(opens.length > 0 && opens.every(o => o.data.reveal && o.data.reveal.dice), '开盅事件带亮牌（结算后才公布）');
    ok(!sinkSpec.text().includes('SECRETPRESETKEY'), '事件流里没有任何 Key 泄漏');
    const specAsks = evS.filter(e => e.type === 'ask');
    ok(specAsks.length === 0, '观战者收不到私有 ask');
    const info = JSON.stringify(reg.info(room));
    ok(!/token/i.test(info) || !/[0-9a-f]{32}/.test(info), '房间信息里不含座位令牌');

    // 战绩落盘
    const recFile = reg.opts.recordFile;
    const lines = fs.existsSync(recFile) ? fs.readFileSync(recFile, 'utf8').trim().split('\n').filter(Boolean) : [];
    ok(lines.length >= 1, '战绩落盘 1 条');
    if (lines.length) {
      const rec = JSON.parse(lines[0]);
      ok(rec.source === 'live' && rec.ruleset_hash && rec.prompt_hash && rec.seats.A.alias && rec.seats.B.alias,
        '战绩带 ruleset_hash / prompt_hash / 座位别名', { p: rec.prompt_hash, r: rec.ruleset_hash });
      ok(typeof rec.duplicate === 'boolean' && rec.hp && typeof rec.winner !== 'undefined', '战绩含血量与胜者');
    }
    reg.close(room.code);

    /* ---------------- [3b] 房间层认输 = 整局判负 ---------------- */
    console.log('[3b] 房间层认输：整局判负，不拖第二轮');
    {
      const regB = makeRegistry();
      const roomB = regB.create({
        seats: { A: { kind: 'me', nick: '认输的人' }, B: { kind: 'bot', bot: 'reader' } },
        rules: 'flex', hpMax: 8, turnMs: 60000, maxRounds: 30, duplicate: false, deals: 1,
      });
      const sinkB = mkSink();
      regB.subscribe(roomB, sinkB, 'A', null);
      await regB.start(roomB.code, { token: roomB.seats.A.token });
      const actorB = regB.actorOfPlan(roomB, 'A');
      let guard = 4000, resigned = false;
      while (guard-- > 0 && !resigned) {
        if (actorB && actorB.waiting && actorB.waiting()) {
          const r = regB.resign(roomB.code, 'A', roomB.seats.A.token);
          ok(r.ok, '座位令牌认输被接受', r);
          resigned = true;
        } else await sleep(5);
      }
      const doneB = await waitFor(() => roomB.state === 'finished' || roomB.state === 'aborted', 8000);
      const evB = sinkB.events();
      const moB = evB.filter(e => e.type === 'matchover').pop();
      const goB = evB.filter(e => e.type === 'gameover').pop();
      ok(doneB && roomB.state === 'finished', '认输后整桌立刻收口（不再空等下一轮）', { state: roomB.state });
      ok(goB && goB.data.winner === 'B' && goB.data.hp && goB.data.hp.A === 0 && goB.data.hp.B === roomB.hpMax,
        '认输方记 0 血、对方判胜', goB && goB.data);
      ok(moB && moB.data.winner === 'B' && moB.data.net.A <= -roomB.hpMax, '净胜血按认输判负结算', moB && moB.data.net);
      ok(evB.some(e => e.type === 'abandon' && e.data.kind === 'resign'), '认输事件已广播');
      regB.close(roomB.code);
    }

    /* ---------------- [4] 复式 ---------------- */
    console.log('[4] 复式：同骰两把换座位');
    const reg2 = makeRegistry();
    const room2 = reg2.create({
      seats: { A: { kind: 'bot', bot: 'reader' }, B: { kind: 'bot', bot: 'oracle' } },
      rules: 'flex', hpMax: 6, turnMs: 60000, maxRounds: 25, duplicate: true, deals: 1,
    }, reg2.owner);
    const sink2 = mkSink();
    reg2.subscribe(room2, sink2, 'spec', null);
    const st2 = await reg2.start(room2.code, { user: reg2.owner });
    ok(st2.ok, '纯 AI 桌由房主账号开局', st2);
    await waitFor(() => room2.state === 'finished' || room2.state === 'aborted', 15000, 'dup');
    const mo = sink2.events().filter(e => e.type === 'matchover').pop();
    ok(!!mo, '复式整桌结束');
    if (mo) {
      const gs = mo.data.games;
      ok(gs.length === 2 && gs[0].swap === false && gs[1].swap === true, '复式打两把且第二把换座位', gs.map(g => ({ swap: g.swap, w: g.winner })));
      ok(typeof mo.data.net.A === 'number' && typeof mo.data.net.B === 'number', '净胜血按人累计', mo.data.net);
    }
    reg2.close(room2.code);
  }

  /* ---------------- [5] 座位混排装配 + 出网策略 ---------------- */
  console.log('[5] 座位混排装配与出网策略');
  {
    const kinds = [
      { kind: 'me', nick: '人' },
      { kind: 'llm', baseUrl: 'http://127.0.0.1:9/v1', model: 'm1', apiKey: 'xxKEYxx', guideText: '先诱开，再转斋' },
      { kind: 'bot', bot: 'reader' },
    ];
    let built = 0, armOk = 0, leak = null;
    for (const a of kinds) for (const b of kinds) {
      const reg = makeRegistry();
      let room;
      try { room = reg.create({ seats: { A: a, B: b }, rules: 'flex', hpMax: 8, turnMs: 20000 }); }
      catch (e) { ok(false, '建桌失败 ' + a.kind + ' vs ' + b.kind + '：' + e.message); continue; }
      try {
        const r = await reg.buildActors(room);
        if (r.ok && r.actors && typeof r.actors.A.decide === 'function' && typeof r.actors.B.decide === 'function') built++;
        if (a.guideText && room.seats.A.armId === C.customArmId(a.guideText)) armOk++;
        if (JSON.stringify(reg.info(room)).includes('xxKEYxx') || JSON.stringify(reg.info(room)).includes('SECRETPRESETKEY')) leak = a.kind + '/' + b.kind;
      } catch (e) { ok(false, '装配失败 ' + a.kind + ' vs ' + b.kind + '：' + e.message); }
      reg.close(room.code);
    }
    ok(built === 9, '九种座位组合全部装配成功', built);
    ok(armOk === 3, '自定义秘诀注册成提示词臂（armId 由文本哈希得出）');
    ok(!leak, '房间信息从不泄漏 Key', leak);
    const reg3 = makeRegistry();
    let rej = null;
    try {
      const r3 = reg3.create({ seats: { A: { kind: 'me', nick: '甲' }, B: { kind: 'llm', baseUrl: 'http://127.0.0.1:1234/v1', model: 'x', apiKey: 'k' } }, rules: 'flex' });
      await reg3.buildActors(r3);
    } catch (e) { rej = String(e.message); }
    ok(rej && /出网策略/.test(rej), '本机端口不在白名单 → 拒绝（SSRF 防线）', rej);
    let rej2 = null;
    try {
      const r4 = makeRegistry().create({ seats: { A: { kind: 'me', nick: '甲' }, B: { kind: 'llm', baseUrl: 'http://169.254.169.254/v1', model: 'x' } }, rules: 'flex' });
      await require('../src/model-gw.js').checkEgress('http://169.254.169.254/v1', { localPorts: [] }).then(c => { if (!c.ok) rej2 = c.reason; });
      void r4;
    } catch (e) { rej2 = String(e.message); }
    ok(rej2 && /元数据|链路本地/.test(rej2), '云元数据地址被拦', rej2);
    const badHost = await require('../src/model-gw.js').checkEgress('http://localhost:8899/v1', { localPorts: [] });
    ok(!badHost.ok, 'localhost 默认禁止（要显式放行端口）', badHost);
  }

  /* ---------------- [6] Parity：与 src/pk.js 同种子逐手一致 ---------------- */
  console.log('[6] Parity：平台路径 vs 实验室 CLI');
  {
    const SEED = 4242, HP = 8, MR = 30;
    // 平台路径：两个内置人机，无换座
    const reg = makeRegistry();
    const room = reg.create({ seats: { A: { kind: 'bot', bot: 'reader' }, B: { kind: 'bot', bot: 'oracle' } }, rules: 'flex', hpMax: HP, maxRounds: MR, duplicate: false, deals: 1, turnMs: 20000 }, reg.owner);
    room.seedBase = SEED;
    const sink = mkSink();
    reg.subscribe(room, sink, 'spec', null);
    const st6 = await reg.start(room.code, { user: reg.owner });
    ok(st6.ok, 'parity 桌开局成功', st6);
    await waitFor(() => room.state === 'finished' || room.state === 'aborted', 20000, 'parity-room');
    const roomHist = room.m ? room.m.history.map(h => ({ no: h.no, count: h.bid.count, face: h.bid.face, zhai: !!h.bid.zhai, opener: h.opener, loser: h.loser, actual: h.actual })) : [];
    ok(roomHist.length > 0, '平台路径产出了逐轮记录（' + roomHist.length + ' 轮）');

    // 直接 runMatch（同一份引擎与 rng 口径）
    const direct = await runMatch({ A: B.makeBot('reader'), B: B.makeBot('oracle') }, E.mulberry32(SEED), {
      hpMax: HP, maxRounds: MR, rules: E.RS.normalize('flex'), firstBidder: SEED % 2 === 0 ? 'A' : 'B',
    });
    const directHist = direct.history.map(h => ({ no: h.no, count: h.bid.count, face: h.bid.face, zhai: !!h.bid.zhai, opener: h.opener, loser: h.loser, actual: h.actual }));
    ok(JSON.stringify(roomHist) === JSON.stringify(directHist), '平台服务端与 runner 直跑逐手一致',
      { room: roomHist.slice(0, 2), direct: directHist.slice(0, 2) });
    ok((room.m && room.m.winner) === direct.winner, '胜者一致', { room: room.m && room.m.winner, direct: direct.winner });

    // 实验室 CLI
    const out = path.join(tmp('parity'), 'pk.jsonl');
    execFileSync(process.execPath, [path.join(ROOT, 'src/pk.js'), '--p0', 'reader', '--p1', 'oracle',
      '--deals', '1', '--seed', String(SEED), '--rules', 'flex', '--hp', String(HP), '--maxRounds', String(MR), '--out', out],
      { stdio: 'ignore' });
    const games = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.kind === 'game' && r.swap === false);
    ok(games.length === 1, 'pk.js 产出原座那局');
    if (games.length) {
      const g = games[0];
      ok(g.winner === direct.winner && JSON.stringify(g.hp) === JSON.stringify(direct.hp) && g.rounds === direct.rounds,
        'pk.js 与平台同种子同结果（胜者 ' + g.winner + '，血量 ' + g.hp.A + ':' + g.hp.B + '，' + g.rounds + ' 轮）',
        { pk: { w: g.winner, hp: g.hp, r: g.rounds }, room: { w: direct.winner, hp: direct.hp, r: direct.rounds } });
    }
    reg.close(room.code);
  }

  console.log(fail === 0 ? '==> ALL PASS' : '==> FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
