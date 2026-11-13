/* apex（第四档）回归：合法、可打完、行为校准真的采到样本。
 * 强度由多组复式对拍负责；这里锁住上线必须成立的硬性质。
 */
'use strict';
const assert = require('assert');
const E = require('../src/dice-engine.js');
const RS = require('../src/dice-rulesets.js');
const R = require('../src/runner.js');
const B = require('../src/bots.js');

const FX = RS.normalize('flex');
const legal = (r, a) => E.legalActionSet(r).has(E.actionKey(E.normalizeAction(r, a)));

// [1] 随机局面：动作合法、非空、只有规则允许时才劈
{
  let n = 0;
  for (let s = 1; s <= 16; s++) {
    const m = E.newMatch({ hpMax: 8, rules: FX, firstBidder: s % 2 ? 'A' : 'B' });
    const r = E.startRound(m, E.mulberry32(s * 131));
    const bot = B.makeBot('apex', { mixBand: 0.01, seed: s });
    let g = 0;
    while (!r.over && g++ < 10) {
      const a = bot.decide(m, r.turn);
      assert.ok(a, 'apex 不应返回空动作');
      assert.ok(legal(r, a), 'apex 落子必须合法: ' + JSON.stringify(a));
      if (a.type === 'open' && a.slash) assert.ok(RS.normalize('flex').slash, 'flex 允许劈');
      n++;
      if (a.type === 'open') E.resolveOpen(m, r.turn, a);
      else E.applyBid(r, r.turn, a);
    }
  }
  console.log(`[1] 合法性：${n} 个随机局面全部通过 ✓`);
}

// [2] 在线校准：打完一小局后必须真的从亮牌复盘里采到 qT/qF 样本
(async () => {
  const a = B.makeBot('apex', { seed: 424242 });
  const b = B.makeBot('deep');
  const res = await R.runMatch({ A: a, B: b }, E.mulberry32(90210), { hpMax: 2, rules: 'flex', maxRounds: 12 });
  assert.strictEqual(res.ungraded, false, 'apex 对局不应判负/报错');
  const st = a.stats();
  assert.ok(st.nT + st.nF > 0, '亮牌后应采到对手开盅样本');
  assert.ok(st.qT >= 0 && st.qT <= 1 && st.qF >= 0 && st.qF <= 1, 'qT/qF 必须在概率域内');
  assert.ok(st.read >= 0.7 && st.read <= 1, '读牌权重必须被限制在安全区间');
  console.log(`[2] 在线校准：样本 T/F=${st.nT}/${st.nF}，qT=${st.qT} qF=${st.qF} read=${st.read} ✓`);
  console.log('==> ALL PASS');
})().catch(e => { console.error('FAIL:', e && e.message); console.error(e); process.exit(1); });
