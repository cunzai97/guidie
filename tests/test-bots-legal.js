/* bot 合法性回归（属性测试）
 *
 * 问题：规则这一两天改了好几处——个数不变可换到点数 1、同一手不许重复喊、首喊点数放开到 1~6、
 * 破斋必须显式写 / 至少翻倍 / 须超斋前、个数≥2、血量制。
 * bot 只从引擎的 legalActions 取候选，本不该受影响，但「不该」不算证据，这里直接扫：
 *
 * 对大量随机局面（含首喊 / 未斋 / 斋 / 破斋后 / 高个数），每个 bot 的 decide() 必须
 *   ① 落在当前回合的 legalActionSet 里；
 *   ② 只有规则集允许劈时才可能返回 slash；
 *   ③ 有价可喊时不许无缘无故返回 null。
 * 两套内置规则集都扫，另加自定义套（关掉劈 / 破斋 / 首喊斋）防止参数化漏洞。
 */
'use strict';
const assert = require('assert');
const E = require('../src/dice-engine.js');
const RS = require('../src/dice-rulesets.js');
const B = require('../src/bots.js');

const SPECS = Object.keys(B.BOTS);
const CUSTOM = RS.normalize({ id: 'custom-bots', builtin: false, name: '自定义（关闭劈/破斋/首喊斋）',
  zhaiMode: 'half', halfDivisor: 2, faceFree: true, lockFace: false,
  breakMultiplier: 0, slash: false, firstZhai: false });

function traverse(ruleset, seeds, cb) {
  for (let s = 1; s <= seeds; s++) {
    const m = E.newMatch({ hpMax: 30, rules: ruleset, firstBidder: s % 2 ? 'A' : 'B' });
    const rng = E.mulberry32(s * 977);
    let guard = 0;
    while (!m.over && m.roundNo < 3 && guard++ < 40) {
      const r = E.startRound(m, rng);
      let g = 0;
      while (!r.over && g++ < 30) {
        cb(m, r, s, g);
        const legal = [...E.legalActionSet(r)];
        // 用随机合法动作推进（制造各种边界局面：首喊、转斋、破斋后、高个数、无价可喊）
        const bids = legal.filter(k => k.startsWith('bid:'));
        // 首喊必须喊；有价之后按规律偶尔只开盅（含劈），其余随机抬价——
        // 这样能覆盖转斋 / 破斋后 / 高个数 / 无价可喊等边界。
        const openOnly = !!r.bid && (!bids.length || (s + g) % 5 === 0);
        if (openOnly) {
          E.resolveOpen(m, r.turn, { slash: legal.includes('open:1') && (s + g) % 3 === 0 });
        } else {
          const pick = bids[(s * 31 + g * 17) % bids.length];
          const [, c, f, mode] = pick.split(':');
          try { E.applyBid(r, r.turn, { type: 'bid', count: +c, face: +f, mode }); }
          catch (e) { throw new Error('引擎自己给的合法动作却落不了子：' + pick + ' → ' + e.message); }
        }
        if (r.over) break;
      }
    }
  }
}

let states = 0, checked = 0;
const seen = { firstBid: 0, zhai: 0, slashOk: 0, noBid: 0 };

for (const [name, ruleset] of [['flex', RS.normalize('flex')], ['classic', RS.normalize('classic')], ['custom', CUSTOM]]) {
  const R = RS.normalize(ruleset);
  for (const spec of SPECS) {
    traverse(R, 12, (m, r) => {
      states++;
      if (!r.bid) seen.firstBid++;
      if (r.zhai) seen.zhai++;
      if (!E.canBid(r)) seen.noBid++;
      const bot = B.makeBot(spec, E.mulberry32(12345 + states));
      const act = bot.decide(m, r.turn);
      const legal = E.legalActionSet(r);
      assert.ok(act, `${name}/${spec}: 返回了空动作`);
      const key = E.actionKey(E.normalizeAction(r, act));
      if (!legal.has(key)) {
        const cur = r.bid ? r.bid.count + '个' + r.bid.face : '首喊';
        assert.fail(`${name}/${spec}: 落子不合法 ${key}（当前 ${cur}, 斋=${!!r.zhai}, `
          + `合法集 ${[...legal].filter(k => k.startsWith('bid:')).slice(0, 4).join(' ')}…）`);
      }
      if (act.type === 'open' && act.slash) {
        assert.ok(R.slash, `${name}/${spec}: 规则不允许劈却返回了 slash`);
        seen.slashOk++;
      }
      checked++;
    });
  }
}

console.log(`[1] ${SPECS.length} 个 bot × 3 套规则 × ${states} 个局面 = ${checked} 次决策，全部落在合法集内 ✓`);
console.log(`    覆盖：首喊 ${seen.firstBid} · 斋中 ${seen.zhai} · 无价可喊 ${seen.noBid} · 劈 ${seen.slashOk}`);

// [2] 机器人名字稳定（run 记录与排名靠它认身份）
const names = SPECS.map(s => B.makeBot(s).name);
assert.deepStrictEqual(names, ['oracle', 'reader']);
console.log('[2] 机器人名字稳定 ✓ ' + names.join(' / '));

// [3] 未知 spec 必须报错，不能静默降级
assert.throws(() => B.makeBot('nope'), /未知机器人/);
console.log('[3] 未知机器人报错 ✓');

console.log('==> ALL PASS');
