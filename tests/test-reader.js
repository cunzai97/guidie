/* reader（贝叶斯读牌）回归：后验方向 / 剥削点修复 / 确定性 / 合法性 / 冒烟。零 token 不触网。 */
const E = require('../src/dice-engine.js');
const B = require('../src/bots.js');
const { runPK } = require('../src/runner.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function mkRound(rules, diceA, seq) {
  const m = E.newMatch({ rules, hpMax: 10 });
  E.startRound(m, E.mulberry32(42));
  m.round.dice.A = diceA.slice();
  // 按 seq 重建公开喊价过程（applyBid 走权威校验，保证构造的局面合法）
  for (const s of seq) E.applyBid(m.round, s.who, { type: 'bid', count: s.count, face: s.face, mode: s.mode });
  m.round.turn = 'A';
  return m;
}

console.log('[1] 后验方向：对手喊 3个6斋 → 后验移向有 6 的手牌');
{
  // 首喊直接斋：B 喊 3个6(toZhai)。A 视角重建后验。
  const m = mkRound('flex', [1, 2, 3, 4, 5], [{ who: 'B', count: 3, face: 6, mode: 'toZhai' }]);
  const w = B.readerBelief(m.round, 'A');
  const priorSix = 5 / 6;
  let postSix = 0, postGe3 = 0;
  // 用 readerBelief 的同一 HANDS 不可得，改用加权和定义：E[6的个数] 与 P(≥3)
  // HANDS 顺序与 bots 内部一致不可见，改从行为断言 + 后验均值两条路：
  // 均值：直接数值积分——重建 252 手牌（与 bots 同算法）算后验均值
  const fact = [1, 1, 2, 6, 24, 120], hands = [];
  const gen = (f, left, n) => {
    if (f === 6) { n.push(left); let wt = 120; for (let x = 1; x <= 6; x++) wt /= fact[n[x]]; hands.push({ n: n.slice(), w: wt / 7776 }); n.pop(); return; }
    for (let k = 0; k <= left; k++) { n.push(k); gen(f + 1, left - k, n); n.pop(); }
  };
  gen(1, 5, [0]);
  for (let i = 0; i < hands.length; i++) { postSix += w[i] * hands[i].n[6]; if (hands[i].n[6] >= 3) postGe3 += w[i]; }
  ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, '后验归一');
  ok(postSix > priorSix + 0.5, `后验 6 均值 ${postSix.toFixed(2)} > 先验 ${priorSix.toFixed(2)}+0.5`);
  ok(postGe3 > 0.3, `后验 P(对手≥3个6)=${postGe3.toFixed(3)} 远高于先验 0.035`);
}

console.log('[2] 剥削点修复：手持 0 个 6 面对 3个6斋，v2 必劈、reader 不劈');
{
  const m = mkRound('flex', [1, 2, 3, 4, 5], [{ who: 'B', count: 3, face: 6, mode: 'toZhai' }]);
  const o = B.oracleBot().decide(m, 'A');
  const rd = B.readerBot().decide(m, 'A');
  ok(o.type === 'open' && o.slash === true, `v2 oracle 劈（被剥削行为复现）: ${JSON.stringify(o)}`);
  ok(!(rd.type === 'open' && rd.slash), `reader 不劈: ${JSON.stringify(rd)}`);
}

console.log('[3] 反向：对手喊明显超载的假价，reader 敢开/劈');
{
  // B 首喊 6个2斋（斋中 p=1/6，6 个几乎不可能）→ reader 应开且劈
  const m = mkRound('flex', [1, 2, 3, 4, 5], [{ who: 'B', count: 6, face: 2, mode: 'toZhai' }]);
  const rd = B.readerBot().decide(m, 'A');
  ok(rd.type === 'open' && rd.slash === true, `reader 劈假价: ${JSON.stringify(rd)}`);
}

console.log('[4] 确定性 + 合法动作（classic/flex 各 20 个随机局面）');
{
  for (const rules of ['classic', 'flex']) {
    const rng = E.mulberry32(7);
    let allLegal = true, det = true;
    for (let t = 0; t < 20; t++) {
      const m = E.newMatch({ rules, hpMax: 10 });
      E.startRound(m, rng);
      // 随机走 0~4 手合法喊价
      const steps = Math.floor(rng() * 5);
      for (let s = 0; s < steps; s++) {
        const acts = B.legalActions(m.round).filter(a => a.type === 'bid');
        if (!acts.length) break;
        E.applyBid(m.round, m.round.turn, acts[Math.floor(rng() * acts.length)]);
      }
      const a1 = B.readerBot().decide(m, m.round.turn);
      const a2 = B.readerBot().decide(m, m.round.turn);
      if (JSON.stringify(a1) !== JSON.stringify(a2)) det = false;
      const key = E.actionKey(E.normalizeAction(m.round, a1));
      if (!new Set(E.legalActions(m.round).map(E.actionKey)).has(key)) allLegal = false;
    }
    ok(det, rules + ' 确定性');
    ok(allLegal, rules + ' 全部动作合法');
  }
}

console.log('[5] 冒烟：reader vs oracle，classic+flex 各 1 deal 零判负零异常');
{
  (async () => {
    for (const rules of ['classic', 'flex']) {
      const { agg } = await runPK(B.readerBot(), B.oracleBot(), { deals: 1, seed: 99, hpMax: 10, maxRounds: 30, rules: E.RS.normalize(rules) });
      ok(agg.p0.stats.forfeits === 0 && agg.p0.stats.errors === 0, `${rules} vs oracle: 零判负零异常 (${agg.p0.wins}-${agg.p0.losses}-${agg.p0.draws})`);
    }
    console.log(fail === 0 ? '==> ALL PASS' : `==> FAIL ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}