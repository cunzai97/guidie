/* oracle（纯数学精确期望 bot）回归：
 * [1] probBidTrue 与 6^5 暴力枚举逐例一致
 * [2] qOpen 性质：值域 / 个数单调 / 极端值
 * [3] 价值诈唬：阈值 bot 短视开盅的局面，oracle 抬价（严格更强的决策类）
 * [4] 确定性 + 构造局面合法动作
 * [5] flex 劈：P<0.5 开盅必劈、P>0.5 绝不劈
 * [6] 全场冒烟：oracle vs reader（classic+flex），零判负零异常
 */
const assert = require('assert');
const E = require('../src/dice-engine.js');
const B = require('../src/bots.js');
const { runPK } = require('../src/runner.js');

function mkRound(rules, diceA, bid) {
  const m = E.newMatch({ rules, hpMax: 10, firstBidder: 'A' });
  E.startRound(m, E.mulberry32(42));
  m.round.dice.A = diceA.slice().sort((a, b) => a - b);
  if (bid) {
    m.round.bid = Object.assign({ by: 'B', mode: 'normal', zhai: false, at: 1 }, bid);
    m.round.turn = 'A';
  }
  return m;
}

(async () => {
  // [1] 精确概率 vs 暴力
  let checked = 0;
  for (const bid of [{ count: 5, face: 3, zhai: false }, { count: 7, face: 6, zhai: false },
                     { count: 3, face: 1, zhai: false }, { count: 4, face: 2, zhai: true }]) {
    for (const own of [[1, 2, 3, 4, 5], [3, 3, 3, 1, 1], [6, 6, 1, 2, 2], [1, 1, 1, 1, 1]]) {
      let hit = 0, total = 0;
      const rec = (k, acc) => {
        if (k === 5) {
          total++;
          if (E.countFace(own.concat(acc), bid.face, bid.zhai) >= bid.count) hit++;
          return;
        }
        for (let f = 1; f <= 6; f++) rec(k + 1, acc.concat([f]));
      };
      rec(0, []);
      assert(Math.abs(E.probBidTrue(bid, own) - hit / total) < 1e-12, 'probBidTrue != brute force');
      checked++;
    }
  }
  console.log(`[1] probBidTrue 与 7776 枚举一致（${checked} 例）✓`);

  // [2] qOpen 性质
  for (let c = 2; c <= 10; c++) {
    for (const z of [false, true]) {
      const q = B.qOpen({ count: c, face: z ? 1 : 4, zhai: z });
      assert(q >= 0 && q <= 1, 'qOpen 越界');
      if (c > 2) assert(q >= B.qOpen({ count: c - 1, face: z ? 1 : 4, zhai: z }) - 1e-12, 'qOpen 应随个数单调不减');
    }
  }
  assert(B.qOpen({ count: 2, face: 4, zhai: false }) < 1e-12, '2 个不该有人开');
  assert(Math.abs(B.qOpen({ count: 10, face: 4, zhai: false }) - 1) < 1e-12, '10 个必被开');
  console.log('[2] qOpen 值域 / 单调 / 极端值 ✓');

  // [3] 价值诈唬：我持 4,4,4,4,1（5 个有效 4），对手喊 4 个 3（P=0.21）
  //     阈值 bot：P<0.5 直接开（EV 0.58）；oracle：抬 5 个 4（必真，79% 对手会开错，EV 0.79）
  const m3 = mkRound('classic', [4, 4, 4, 4, 1], { count: 4, face: 3 });
  // 「短视」的判据：P(这手为真 | 我的骰子) < 0.5 —— 只看单手的打法会直接开，oracle 不该只看这一层。
  assert.ok(E.probBidTrue(m3.round.bid, m3.round.dice.A) < 0.5, '前提：这一手单手概率不足一半');
  const or = B.oracleBot().decide(m3, 'A');
  assert.strictEqual(or.type, 'bid', 'oracle 应看到续值');
  assert.strictEqual(or.count, 5); assert.strictEqual(or.face, 4);
  console.log('[3] 价值诈唬：单手概率不足一半，oracle 仍抬 5 个 4 ✓');

  // [4] 确定性 + 合法
  const m4 = mkRound('classic', [1, 2, 3, 4, 5], { count: 3, face: 5 });
  const a1 = B.oracleBot().decide(m4, 'A'), a2 = B.oracleBot().decide(m4, 'A');
  assert.deepStrictEqual(a1, a2, 'oracle 必须确定性');
  const legal = new Set(E.legalActions(m4.round).map(E.actionKey));
  assert(legal.has(E.actionKey(E.normalizeAction(m4.round, a1))), 'oracle 动作必须合法');
  console.log('[4] 确定性 + 合法动作 ✓');

  // [5] flex 劈
  const m5a = mkRound('flex', [2, 2, 3, 4, 5], { count: 8, face: 6 });   // P=0 → 开且劈
  const a5a = B.oracleBot().decide(m5a, 'A');
  assert.strictEqual(a5a.type, 'open'); assert.strictEqual(a5a.slash, true, 'P<0.5 开盅应劈');
  const m5b = mkRound('flex', [6, 6, 6, 6, 1], { count: 3, face: 6 });   // P=1 → 不开
  const a5b = B.oracleBot().decide(m5b, 'A');
  assert(!(a5b.type === 'open' && a5b.slash), 'P>0.5 绝不劈');
  console.log('[5] flex 劈：有利必劈 / 不利不劈 ✓');

  // [6] 全场冒烟（零 token）：合法性的最终证明是跑完整局零判负
  for (const rules of ['classic', 'flex']) {
    const { agg } = await runPK(B.oracleBot(), B.readerBot(),
      { deals: 1, seed: 99, hpMax: 10, maxRounds: 40, rules: E.RS.normalize(rules) });
    const s = agg.p0.stats;
    assert.strictEqual(s.forfeits, 0, `oracle(${rules}) vs reader 出现判负`);
    assert.strictEqual(s.errors, 0, `oracle(${rules}) vs reader 出现错误`);
  }
  console.log('[6] classic+flex 冒烟（oracle vs reader，各 1 局）：零判负零异常 ✓');
  console.log('==> ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });