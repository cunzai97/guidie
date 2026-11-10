/* 连败反思臂回归：系统提示替换 + runner 触发时机。零 token 不触网。 */
const E = require('../src/dice-engine.js');
const B = require('../src/bots.js');
const C = require('../src/context.js');
const RS = require('../src/dice-rulesets.js');
const { runPK } = require('../src/runner.js');

// 最小合法价（测试自用：bots.js 不再导出 minBid）
function minBid(round) {
  const bids = E.legalActions(round).filter(a => a.type === 'bid');
  if (!bids.length) return null;
  bids.sort((x, y) => x.count - y.count || E.ord(x.face) - E.ord(y.face));
  return bids[0];
}

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }

console.log('[1] 反思是拼接不是替代：基础提示词（规则 + 赢的秘诀）必须还在');
{
  const base = C.buildSystem(10, { rules: RS.normalize('flex') });
  const refl = C.buildSystem(10, { rules: RS.normalize('flex'),
    reflection: { streak: 5, text: '以后遇到 3个6斋 先看对手历史，不急着劈。' } });
  ok(base.includes('【赢的秘诀】'), '基线含「赢的秘诀」');
  ok(base.includes('谁的暴露少、读到的多，谁赢'), '基线含结尾那句');
  ok(refl.includes('【赢的秘诀】'), '反思臂仍有「赢的秘诀」（不被替代）');
  ok(refl.includes('谁的暴露少、读到的多，谁赢'), '反思臂仍有结尾那句');
  ok(refl.includes('连输 5 轮'), '反思臂含连败提示');
  ok(refl.includes('不急着劈'), '反思全文注入');
  ok(refl.includes('喊价「n 个 m」'), '规则仍在（不然没法打）');
  ok(refl.indexOf('【连败后的自省】') > refl.indexOf('【赢的秘诀】'), '反思拼在「赢的秘诀」之后');
  ok(!base.includes('【连败后的自省】'), '没触发反思时不会出现这一段');
}

console.log('[2] runner 触发（局内连轮）：连续输满 4 轮触发，之前不触发');
{
  const calls = [];
  const stub = {
    name: 'stub-loser',
    reset() { },
    async decide(match, who) {
      // 只喊最小合法价，几乎每轮都输给 oracle
      const a = minBid(match.round);
      return a ? { type: 'bid', count: a.count, face: a.face, mode: a.mode, judgment: '' } : { type: 'open' };
    },
    async reflect(info) { calls.push(info); },
  };
  (async () => {
    const { agg } = await runPK(stub, B.oracleBot(), {
      deals: 1, seed: 7, hpMax: 10, maxRounds: 20,
      rules: RS.normalize('classic'), reflectAfter: 4,
    });
    ok(calls.length >= 1, `反思触发次数 ${calls.length}（应 >=1）`);
    ok(calls[0] && calls[0].streak === 4, `首次触发时连输 ${calls[0] && calls[0].streak} 轮（应为 4）`);
    ok(calls[0] && Array.isArray(calls[0].history) && calls[0].history.length >= 4, `反思拿到本局逐轮记录（${calls[0] && calls[0].history.length} 轮）`);
    ok(calls[0] && calls[0].history.every(h => h.dice && h.dice.A && h.dice.B), '记录含双方真实手牌');
    ok(calls[0] && ['A', 'B'].includes(calls[0].seat), '记录含座位');
    ok(calls.every(c => c.streak % 4 === 0), '每次触发都恰在 4 的倍数轮（不重复/不提前）');
    console.log('  赛果（stub 对 oracle）:', agg.p0.wins + '-' + agg.p0.losses + '-' + agg.p0.draws);
    console.log(fail === 0 ? '==> ALL PASS' : `==> FAIL ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}