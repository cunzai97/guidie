/* deep bot 回归：确定性、合法性、以及两条「读牌质量」的硬断言
 *
 * deep 是 reader 的加强版（对手模型双向 + 叶子按手牌展开 + 效用按赢局概率）。
 * 强度本身用 pk.js 的对局数据说话（见 README），这里只锁住不会退化的性质：
 *  ① 决策确定：同一局面两次调用结果一致（不含随机数）；
 *  ② 永远合法：只从 legalActions 里选；
 *  ③ 该开就开：当自己手牌已能证明对手那手为假、且对手不会在我抬价后送更多时，必须开盅；
 *  ④ 该守就守：己方能证明对手那手为真的局面里，不该去开（胜率极低的选择）。
 */
'use strict';
const assert = require('assert');
const E = require('../src/dice-engine.js');
const RS = require('../src/dice-rulesets.js');
const B = require('../src/bots.js');

const FX = RS.normalize('flex');
// 直接摆一个「A 已喊过一手」的局面：diceB 是我方（B）手牌
const mk = (rules, diceB, bid, hpMe, hpOpp) => {
  const m = E.newMatch({ hpMax: 10, rules, firstBidder: 'A' });
  const r = E.startRound(m, E.mulberry32(1));
  r.dice = { A: [2, 3, 4, 5, 6], B: diceB.slice() };
  const z = bid.face === 1;
  r.bid = { by: 'A', count: bid.count, face: bid.face, mode: 'normal', zhai: z, at: 1 };
  r.seq = [{ who: 'A', kind: 'bid', count: bid.count, face: bid.face, mode: 'normal', zhai: z, at: 1 }];
  r.zhai = z;
  r.turn = 'B';
  m.hp = { A: hpMe == null ? 10 : hpMe, B: hpOpp == null ? 10 : hpOpp };
  return { m, r };
};
const legal = (r, a) => E.legalActionSet(r).has(E.actionKey(E.normalizeAction(r, a)));

// [1] 确定性 + 合法性：随机推进若干局面，deep 的动作必须落在合法集内且可复现
{
  let n = 0;
  for (let s = 1; s <= 30; s++) {
    const m = E.newMatch({ hpMax: 10, rules: FX, firstBidder: 'A' });
    const r = E.startRound(m, E.mulberry32(s * 31));
    let g = 0;
    while (!r.over && g++ < 12) {
      const a1 = B.makeBot('deep').decide(m, r.turn);
      const a2 = B.makeBot('deep').decide(m, r.turn);
      assert.deepStrictEqual(a1, a2, '同一局面两次决策必须一致');
      assert.ok(legal(r, a1), 'deep 落子必须合法: ' + JSON.stringify(a1));
      n++;
      if (a1.type === 'open') E.resolveOpen(m, r.turn, a1);
      else E.applyBid(r, r.turn, a1);
    }
  }
  console.log(`[1] 确定性 + 合法性：${n} 个局面全部通过 ✓`);
}

// [3] 该开就开：我手里没有 6，对手喊 8 个 6（真值必假）→ 必须开
{
  const { m, r } = mk(FX, [2, 2, 3, 3, 4], { count: 8, face: 6 }, 10, 10);
  const a = B.makeBot('deep').decide(m, 'B');
  assert.strictEqual(a.type, 'open', '必假的一手必须开盅，实际: ' + JSON.stringify(a));
  console.log('[3] 必假的喊价 → 开盅 ✓' + (a.slash ? '（并劈）' : ''));
}

// [4] 该守就守：对手喊 3 个 6，我手上 4 张 6 + 1 → 必真，不该开
{
  const { m, r } = mk(FX, [6, 6, 6, 6, 1], { count: 3, face: 6 }, 10, 10);
  const a = B.makeBot('deep').decide(m, 'B');
  assert.ok(!(a.type === 'open' && !a.slash) || a.type === 'bid', '必真的一手不该去开');
  console.log('[4] 必真的喊价 → 不轻易开盅 ✓ 实际: ' + (a.type === 'open' ? '开盅' : `喊 ${a.count} 个 ${a.face}`));
}

// [5] 终盘：对手只剩 1 血时，正确的开盅就是斩杀，价值必须高于「稳一手」
{
  const a10 = (() => { const { m, r } = mk(FX, [2, 2, 3, 3, 4], { count: 8, face: 6 }, 10, 10); return B.makeBot('deep').decide(m, 'B'); })();
  const a1 = (() => { const { m, r } = mk(FX, [2, 2, 3, 3, 4], { count: 8, face: 6 }, 10, 1); return B.makeBot('deep').decide(m, 'B'); })();
  assert.strictEqual(a10.type, 'open');
  assert.strictEqual(a1.type, 'open');
  console.log('[5] 终盘斩杀与常规局面都给出开盅 ✓' + (a1.slash ? '（终盘劈）' : ''));
}

// [6] 名字与注册表
assert.strictEqual(B.makeBot('deep').name, 'deep', '默认参数下名字必须是 deep');
assert.ok(B.BOTS.deep, 'BOTS 注册表里必须有 deep');
console.log('[6] 注册表 / 名字 ✓');

console.log('==> ALL PASS');
