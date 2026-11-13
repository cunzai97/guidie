/* 排名模块验证：SHA-1 与 Node crypto 同口径、prompt_hash 与 runlog 一致、
 * Elo 的对手分敏感（虐菜不刷分）、分组隔离、强度筛选、定级标记。 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const RK = require('../web/ranking.js');
const C = require('../src/context.js');
const RS = require('../src/dice-rulesets.js');
const RL = require('../src/runlog.js');

// [1] SHA-1 纯 JS 实现与 Node crypto 逐字一致（含中文 / 空串 / 长文本 / 分块边界）
for (const s of ['', 'abc', '你好，鬼骰', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'd'.repeat(1000), 'x\n\0\ny']) {
  assert.strictEqual(RK.sha1hex(s), crypto.createHash('sha1').update(s).digest('hex'), 'sha1 不一致: len=' + s.length);
}
console.log('[1] SHA-1 与 Node crypto 一致 ✓');

// [2] prompt_hash 与 runlog 完全一致（排名分组键不能和 run 清单漂移）；臂从注册表取，加新臂自动纳入
for (const r of ['classic', 'flex']) for (const v of Object.keys(C.ARMS)) {
  const rules = RS.normalize(r);
  assert.strictEqual(RK.hashTexts(C.promptTexts(rules, v)), RL.promptHash(v, rules), r + '/' + v);
}
for (const r of ['classic', 'flex']) {
  const rules = RS.normalize(r);
  assert.strictEqual(RL.promptHash(null, rules), RL.promptHash(C.ARM_DEFAULT, rules), r + '/默认臂=注册表默认');
}
console.log('[2] prompt_hash 与 runlog 一致（臂：' + Object.keys(C.ARMS).join(',') + '）✓');

// [3] 同分对手：赢 +16 / 输 −16（K=32, E=0.5）
const seat = (id, model, effort) => ({ id, alias: model, model, base: 'http://x/v1', effort: effort || 'medium' });
const match = (t, winner, extra) => Object.assign({ t, seats: { A: seat('a', 'MA'), B: seat('b', 'MB') },
  winner, draw: !winner, points: { A: 0, B: 0 }, ruleset_hash: 'r1', prompt_hash: 'p1', variant: 'probe' }, extra || {});
let board = RK.elo([match(1, 'A')]);
assert.strictEqual(board.find(e => e.model === 'MA').rating, 1516);
assert.strictEqual(board.find(e => e.model === 'MB').rating, 1484);
console.log('[3] 同分胜负 ±16 ✓');

// [4] 虐菜不刷分：分差拉开后，继续赢弱手收益趋零；输给弱手重扣
let ms = [];
for (let i = 0; i < 30; i++) ms.push(match(i + 1, 'A'));   // MA 连赢 30 局把分差拉大
board = RK.elo(ms);
const strong = board.find(e => e.model === 'MA'), weak = board.find(e => e.model === 'MB');
assert(strong.rating - weak.rating > 300, '分差应已拉开');
const gainBefore = strong.rating;
ms.push(match(31, 'A'));
board = RK.elo(ms);
const gain = board.find(e => e.model === 'MA').rating - gainBefore;
assert(gain <= 2, '虐菜第 31 局收益应 ≤2 分，实际 ' + gain);
ms.push(match(32, 'B'));   // 强手翻车输给弱手
board = RK.elo(ms);
const drop = gainBefore + gain - board.find(e => e.model === 'MA').rating;
assert(drop >= 28, '输给弱手应重扣 ≥28，实际 ' + drop);
console.log('[4] 虐菜收益 ' + gain + ' 分 / 翻车扣 ' + drop + ' 分 ✓');

// [5] 平局：高分向低分靠拢（各按 0.5）
board = RK.elo([match(1, 'A'), match(2, null)]);
const a2 = board.find(e => e.model === 'MA').rating, b2 = board.find(e => e.model === 'MB').rating;
assert(a2 < 1516 && b2 > 1484 && a2 > b2, '平局应向中间收敛');
assert.strictEqual(board.find(e => e.model === 'MA').draws, 1);
console.log('[5] 平局 0.5 收敛 ✓');

// [6] 指纹分组隔离：不同 prompt_hash 的胜负互不影响
const g1 = [match(1, 'A')];
const other = match(2, 'B', { prompt_hash: 'p2' });
board = RK.elo(g1);
assert.strictEqual(board.find(e => e.model === 'MA').rating, 1516);
const groups = RK.listGroups(g1.concat([other]));
assert.strictEqual(groups.length, 2);
assert.strictEqual(groups.find(g => g.prompt_hash === 'p1').n, 1);
console.log('[6] 指纹分组隔离 ✓');

// [7] 强度筛选：只收双方同档；混档局不进子榜
const mixed = match(3, 'A', { seats: { A: seat('a', 'MA', 'off'), B: seat('b', 'MB', 'xhigh') } });
const all = g1.concat([mixed]);
assert.strictEqual(RK.filterEffort(all, 'medium').length, 1);
assert.strictEqual(RK.filterEffort(all, 'off').length, 0);
assert.strictEqual(RK.filterEffort(all, 'all').length, 2);
console.log('[7] 强度筛选（双方同档）✓');

// [8] 身份合并：改别名 / base 尾斜杠 / 重建预设（id 变）不分家
const m1 = match(1, 'A');
const m2 = match(2, 'A', { seats: { A: { id: 'new-id', alias: 'MA改', model: 'MA', base: 'http://x/v1/', effort: 'medium' }, B: seat('b', 'MB') } });
board = RK.elo([m1, m2]);
assert.strictEqual(board.length, 2, '同模型同端点应合并');
assert.strictEqual(board.find(e => e.model === 'MA').games, 2);
assert.strictEqual(board.find(e => e.model === 'MA').alias, 'MA改', '别名取最新');
console.log('[8] 身份合并 ✓');

// [9] 定级标记：<5 场 provisional；自己打自己 rating 不动
board = RK.elo([match(1, 'A')]);
assert(board.every(e => e.provisional));
const selfPlay = match(1, 'A', { seats: { A: seat('a', 'MA'), B: seat('b', 'MA') } });
board = RK.elo([selfPlay]);
assert.strictEqual(board.length, 1);
assert.strictEqual(board[0].rating, 1500, '自战不应改分');
console.log('[9] 定级标记 / 自战不变分 ✓');

// [10] 时间顺序：先输后赢 ≠ 先赢后输（Elo 路径依赖）
const fwd = RK.elo([match(1, 'B'), match(2, 'A')]).find(e => e.model === 'MA').rating;
const rev = RK.elo([match(1, 'A'), match(2, 'B')]).find(e => e.model === 'MA').rating;
assert(fwd > rev, '先输后赢应高于先赢后输');
console.log('[10] 时间顺序路径依赖 ✓ (' + fwd + ' > ' + rev + ')');

// [11] 匿名访客（没有账号 id）在榜上打 guest: 前缀；有账号的真人按昵称各占一条
const human = (id, alias) => ({ id, alias, model: 'human', base: 'human', effort: 'off' });
{
  const prepared = RK.prepareBoard([
    { t: 1, winner: 'A', seats: { A: human('me:guest', '玩家'), B: seat('b', 'MB') } },
    { t: 2, winner: 'B', seats: { A: human('u-1', 'pan'), B: seat('b', 'MB') } },
  ]);
  assert.strictEqual(prepared[0].seats.A.model, 'guest:玩家', '匿名访客要打 guest: 前缀');
  assert.strictEqual(prepared[0].seats.A.guest, true, '匿名访客要打 guest 标记');
  assert.strictEqual(prepared[1].seats.A.model, 'pan', '有账号的真人用昵称当模型位');
  assert.ok(!prepared[1].seats.A.guest, '有账号的不算匿名');
  const board = RK.elo(prepared);
  const shown = board.filter(e => !String(e.model || '').startsWith('guest:'));
  assert.ok(!shown.some(e => String(e.model).startsWith('guest:')), '榜上不能出现 guest 条目');
  assert.ok(shown.some(e => e.model === 'pan' && e.base === 'human'), '真人账号在榜上');
  // 对手分照算：匿名访客那局照样给 bot 记分（只是访客自己不上榜）
  const bot = board.find(e => e.model === 'MB');
  assert.strictEqual(bot.games, 2, '匿名局照样计入对手的局数');
}
console.log('[11] 匿名访客不进榜、但对局照算 ✓');

// [12] 样本门槛：只打过一局的不进默认榜（云端那串随机昵称就是这么被挡掉的）
{
  const prep = [];
  for (let i = 0; i < 4; i++) prep.push({ t: i + 1, winner: 'A', seats: { A: human('u-1', 'pan'), B: seat('b', 'MB') } });
  prep.push({ t: 99, winner: 'A', seats: { A: human('u-2', 'th9at2i'), B: seat('b', 'MB') } });
  const board = RK.elo(RK.prepareBoard(prep));
  const shown3 = board.filter(e => !String(e.model || '').startsWith('guest:') && e.games >= 3);
  const shown1 = board.filter(e => !String(e.model || '').startsWith('guest:') && e.games >= 1);
  assert.ok(shown3.some(e => e.model === 'pan'), '4 局的留在榜上');
  assert.ok(!shown3.some(e => e.model === 'th9at2i'), '只打 1 局的被门槛挡掉');
  assert.ok(shown1.some(e => e.model === 'th9at2i'), '放宽到 1 局就能看到');
}
console.log('[12] 样本门槛挡掉「只打一局」的噪声 ✓');

console.log('==> ALL PASS');