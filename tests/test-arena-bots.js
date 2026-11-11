/* 竞技场「内置机器人」回归测试（DOM 桩）
 *
 * 验的是 UI 里选 reader 这类机器人真的能开战并打到结束：
 *   ① 'bot:<spec>' 席位能解析成机器人玩家（不要求 Base URL / 模型 ID）；
 *   ② 机器人走 decideBot 本地决策，落子合法，不产生 tok / 不调接口；
 *   ③ 整局能按血量制结算完；机器人席位不触发轮末复盘请求。
 * 用最小 DOM 桩跑真实的 arena.js（不 mock 决策逻辑本身）。
 */
'use strict';
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..', 'src');
globalThis.DiceEngine = require(path.join(root, 'dice-engine.js'));
globalThis.DiceRules = require(path.join(root, 'dice-rules.js'));
globalThis.DiceContext = require(path.join(root, 'context.js'));
globalThis.DiceRulesets = require(path.join(root, 'dice-rulesets.js'));
globalThis.DiceBots = require(path.join(root, 'bots.js'));
globalThis.DiceCtxLog = require(path.join(root, 'ctxlog.js'));
globalThis.ArenaRanking = require(path.join(__dirname, '..', 'web', 'ranking.js'));

/* ---------- 最小 DOM 桩 ---------- */
function stubEl(id) {
  const e = {
    id, style: {}, value: '', textContent: '', innerHTML: '', hidden: false,
    checked: false, disabled: false, children: [], scrollTop: 0, scrollHeight: 0,
    onclick: null, onchange: null, title: '', className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    setAttribute() {}, removeAttribute() {}, focus() {}, click() {},
    addEventListener() {}, querySelector() { return null; }, getContext() { return null; },
    scrollIntoView() {},
  };
  return e;
}
const els = new Map();
const doc = {
  documentElement: stubEl('html'),
  body: stubEl('body'),
  getElementById(id) { if (!els.has(id)) els.set(id, stubEl(id)); return els.get(id); },
  createElement(tag) { return stubEl(tag); },
  querySelector() { return null; },
  defaultView: { confirm: () => true },
};
globalThis.document = doc;
globalThis.location = { search: '' };
globalThis.fetch = async () => { throw new Error('离线测试：不连服务'); };

const A = require(path.join(__dirname, '..', 'web', 'arena.js'));
const E = globalThis.DiceEngine, RS = globalThis.DiceRulesets, BOT = globalThis.DiceBots;

async function run() {
  // arena.js 在浏览器里由 init() 自启；这里等它的异步 loadStore 落地后再改状态，否则会被覆盖。
  await new Promise(r => setTimeout(r, 60));
  // [1] 席位解析：机器人不需要 base/model；未知 spec 返回 null
  const seat = A.botSeat('bot:reader');
  assert.ok(seat && seat.kind === 'bot' && seat.alias.indexOf('reader') === 0, 'bot:reader 应解析成机器人席位');
  assert.strictEqual(seat.base, 'bot');
  assert.strictEqual(A.playerById('bot:reader').kind, 'bot');
  assert.strictEqual(A.botSeat('bot:nope'), null, '未知机器人返回 null');
  assert.strictEqual(A.isBotId('p_abc'), false);
  console.log('[1] bot:<spec> 席位解析 ✓  （注册表：' + Object.keys(BOT.BOTS).join(',') + '）');

  // [2] 机器人决策：本地、合法、不产生 tok
  A.state.settings.target = 3;
  A.state.settings.speed = 0;
  doc.getElementById('qTarget').value = '3';    // startMatch 从快速设置栏读初始血量
  doc.getElementById('qSpeed').value = '0';
  doc.getElementById('qRules').value = 'flex';
  doc.getElementById('qVariant').value = 'plain';
  A.state.settings.summary = true;          // 打开复盘，机器人席位必须跳过
  A.state.settings.rules = 'flex';
  A.state.seat = { A: 'bot:reader', B: 'bot:oracle' };
  A.state.players = { A: A.playerById('bot:reader'), B: A.playerById('bot:oracle') };
  A.state.bots = {
    A: BOT.makeBot('reader', E.mulberry32(7)),
    B: BOT.makeBot('oracle', E.mulberry32(8)),
  };
  A.state.G = E.newMatch({ hpMax: 3, firstBidder: 'A', rules: RS.normalize('flex') });
  A.state.stats = { A: A.newStats(), B: A.newStats() };
  A.state.memos = { A: [], B: [] }; A.state.ownMemo = { A: [], B: [] };
  A.state.god = false;

  E.startRound(A.state.G);
  const w = A.state.G.round.turn;
  const d = A.decideBot(w, '首喊');
  assert.ok(d.bot === true && d.tokens === 0 && d.action, '机器人应本地给出动作');
  assert.strictEqual(globalThis.DiceRules.checkLegal(A.state.G.round, d.action), null, '机器人动作必须合法');
  console.log('[2] decideBot 本地决策合法 ✓  → ' + A.actText(d.action) + '（' + d.ms + 'ms, 0 tok）');

  // [3] 整局打完：血量归零即结束，双方都是机器人时不发复盘请求
  let summaryCalls = 0, stateSaves = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    const u = String(url || '');
    if (u.indexOf('/api/arena/state') === 0) { stateSaves++; return { ok:true, json:async () => ({ ok:true }) }; }
    summaryCalls++; throw new Error('不该发请求');
  };
  return (async () => {
    await A.startMatch();
    globalThis.fetch = realFetch;
    const G = A.state.G;
    if (!G.over) {
      const flow = els.get('panelFlow');
      console.log('--- 牌桌日志 ---');
      console.log((flow ? flow.children : []).map(c => c.textContent || c.innerHTML).join('\n').slice(0, 1200));
      console.log('--- think A ---'); console.log(els.get('thinkA') && els.get('thinkA').textContent);
      console.log('--- think B ---'); console.log(els.get('thinkB') && els.get('thinkB').textContent);
    }
    assert.ok(G && G.over, '对局应自然结束');
    assert.ok(G.hp.A <= 0 || G.hp.B <= 0 || G.capped, '结束条件应是血量归零或轮数封顶');
    assert.strictEqual(summaryCalls, 1, '只有对局记录那一次 POST（复盘与模型调用都不该走接口），实际 ' + summaryCalls);
    assert.ok(stateSaves >= 1, '每落一手都要写断点存档（实际 ' + stateSaves + ' 次）');
    assert.ok(A.state.memos.A.length === 0, '机器人席位不应写入复盘');
    console.log('[3] 机器人整局对战 ✓  血量 ' + G.hp.A + ':' + G.hp.B + ' · ' + G.roundNo + ' 轮 · 胜者 '
      + (G.winner ? A.seatLabel(G.winner) : '平局'));

    // [4] 连败反思的触发计数（真模型调用要接口，这里只验触发时机与清零）
    A.state.settings.reflect = 2;
    A.state.reflect = { text:{A:'',B:''}, streak:{A:0,B:0}, round:{A:null,B:null} };
    const lose = { loser:'A', winner:'B' };
    assert.deepStrictEqual(A.noteReflectStreak(lose), [], '连输 1 轮不触发');
    assert.deepStrictEqual(A.noteReflectStreak(lose), ['A'], '连输 2 轮触发反思');
    assert.strictEqual(A.state.reflect.streak.A, 2);
    assert.deepStrictEqual(A.noteReflectStreak({ loser:'B', winner:'A' }), [], '换人连输从 0 数');
    assert.strictEqual(A.state.reflect.streak.A, 0, '赢一轮即清零');
    assert.strictEqual(A.state.reflect.streak.B, 1);
    const botSeat = A.state.players.A;
    assert.strictEqual(botSeat.kind, 'bot');
    await A.requestReflect('A', 2).then(t => assert.strictEqual(t, '', '机器人席位不发反思请求'));
    console.log('[4] 连败反思：连输 N 轮触发 / 赢一轮清零 / 机器人跳过 ✓');

    // [5] 断点续跑：整局存档 → JSON 往返 → 恢复后局面 / 上下文前缀 / ursor 全等，且能继续落子
    const CX = globalThis.DiceCtxLog;
    A.state.settings.rules = 'flex';
    A.state.settings.target = 5;
    A.state.players = { A:A.botSeat('bot:reader'), B:A.botSeat('bot:deep') };
    A.state.bots = { A:BOT.makeBot('reader', E.mulberry32(7)), B:BOT.makeBot('deep', E.mulberry32(9)) };
    A.state.started = true; A.state.runId = 'rt-test'; A.state.gameNo = 1;
    A.state.G = E.newMatch({ hpMax:5, firstBidder:'A', rules:A.allRules().find(r => r.id === 'flex') });
    E.startRound(A.state.G, E.mulberry32(11));
    A.state.logs = { A:CX.create({ system:'SYS-A', ctxLimit:8192 }), B:CX.create({ system:'SYS-B', ctxLimit:8192 }) };
    for (const w of ['A','B']) {
      A.state.logs[w].beginRound(1);
      A.state.logs[w].appendUser('第1轮第1手：对手喊 2 个 3');
      A.state.logs[w].appendAssistant('行动：喊 3 个 4');
      A.state.memos[w].push({ round:1, text:'第 1 轮复盘（测试）' });
      A.state.ownMemo[w].push({ round:1, judgment:'测试判断', action:'喊 3 个 4' });
    }
    A.state.cursor = { A:{ round:1, turn:1 }, B:{ round:1, turn:1 } };
    A.state.reflect = { text:{ A:'反思A', B:'' }, streak:{ A:2, B:0 }, round:{ A:1, B:null } };
    const snap = A.arenaSaveState();
    assert.ok(snap && snap.v === 3 && snap.G.round, '存档应包含局面与当前轮');
    const wire = JSON.parse(JSON.stringify(snap));          // 过一遍 JSON：模拟落盘再读回
    const beforeHash = { A:A.state.logs.A.prefixHash(), B:A.state.logs.B.prefixHash() };
    const beforeMsg = A.state.logs.A.snapshot().length;
    const beforeDice = JSON.stringify(A.state.G.round.dice);
    A.state.G = null; A.state.logs = {}; A.state.players = null;   // 把内存状态砸掉，逼它从存档重建
    assert.ok(A.arenaRestoreState(wire), '恢复成功');
    assert.strictEqual(A.state.G.hpMax, 5);
    assert.strictEqual(A.state.G.rules.id, 'flex', '规则集按 id 复原');
    assert.strictEqual(JSON.stringify(A.state.G.round.dice), beforeDice, '骰子原样复原');
    assert.strictEqual(A.state.logs.A.prefixHash(), beforeHash.A, '上下文前缀哈希不变（缓存可续）');
    assert.strictEqual(A.state.logs.B.prefixHash(), beforeHash.B);
    assert.strictEqual(A.state.logs.A.snapshot().length, beforeMsg, '消息条数不变');
    assert.strictEqual(A.state.cursor.A.round, 1, '逐手游标复原');
    assert.strictEqual(A.state.reflect.text.A, '反思A');
    // 恢复后还能继续打：机器人走本地决策，落子必须合法
    const G2 = A.state.G, w2 = G2.round.turn;
    const act = A.decideBot(w2, G2.round.bid ? '行动' : '首喊');
    assert.ok(act && act.action, '恢复后仍能给出决策');
    A.state.settings.strict = true;
    console.log('[5] 断点续跑：存档→JSON→恢复，局面/骰子/前缀哈希/游标全等，且能继续落子 ✓');
    console.log('==> ALL PASS');
  })();
}

run().catch(e => { console.error('FAIL:', e && e.message); console.error(e); process.exit(1); });
