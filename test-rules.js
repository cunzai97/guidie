#!/usr/bin/env node
/* 规则/解析回归：无网络、无 LLM。
 * 1) checkLegal 与引擎合法动作集合全枚举比对（单一真源的不变量）
 * 2) applyBid 的个数上界
 * 3) parseAction 关键样例
 * 4) UMD 模块在"浏览器全局"与 Node 下行为一致
 * 5) 300 局随机对局，校验合法性、计数与判负
 * 用法: node test-rules.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const E = require('./dice-engine.js');
const C = require('./context.js');
const R = require('./dice-rules.js');

let failed = 0;
function ok(cond, label, extra) {
  if (!cond) { failed++; console.log('  FAIL ' + label + (extra ? '  ' + JSON.stringify(extra) : '')); }
}

// ---- 1. 全枚举：checkLegal 的合法判定必须等于引擎的合法动作集合 ----
const prevs = [null];
for (const f of [2, 3, 4, 5, 6, 1]) for (const c of [2, 3, 4, 5, 6, 8, 10]) prevs.push({ by: 'B', count: c, face: f, at: 1 });
let combos = 0, mismatch = 0;
for (const prev of prevs) {
  const r = { bid: prev, seq: prev ? [{ who: 'B', kind: 'bid', count: prev.count, face: prev.face, at: 1 }] : [] };
  const set = R.legalActionSet(r);
  for (let c = 0; c <= 12; c++) for (let f = 0; f <= 7; f++) {
    const a = { type: 'bid', count: c, face: f };
    combos++;
    if ((C.checkLegal(r, a) === null) !== set.has(R.actionKey(a))) { mismatch++; console.log('  差异:', prev, a); }
  }
  const open = { type: 'open' };
  combos++;
  if ((C.checkLegal(r, open) === null) !== set.has('open')) { mismatch++; console.log('  开盅差异:', prev); }
}
ok(mismatch === 0, `枚举 ${combos} 组合，checkLegal 与引擎一致`);
console.log(`  [1] 枚举 ${combos} 个 (局面,动作)，差异 ${mismatch} 处`);

// ---- 2. applyBid 上界 ----
const r2 = { bid: { by: 'B', count: 2, face: 2, at: 1 }, seq: [] };
let rejected = 0;
for (const c of [11, 12, 99]) { try { E.applyBid(r2, 'A', c, 6); } catch { rejected++; } }
ok(rejected === 3, 'applyBid 拒绝超过 10 个的喊价');
let accepted = false;
try { E.applyBid({ bid: null, seq: [] }, 'A', 3, 5); accepted = true; } catch { }
ok(accepted, 'applyBid 接受合法首喊');
console.log(`  [2] 超界拒绝 ${rejected}/3，合法首喊通过 ${accepted}`);

// ---- 3. parseAction 样例 ----
const cases = [
  ['对手喊了 3 个 5，我判断它在虚张。\n\n开盅', { type: 'open' }],
  ['判断：它在诈。\n\n喊 ４ 个 ６', { type: 'bid', count: 4, face: 6 }],
  ['我打算喊 4 个 6，但更稳妥是开盅。\n\n开盅', { type: 'open' }],
  ['五个三', { type: 'bid', count: 5, face: 3 }],
];
for (const [raw, expect] of cases) {
  const got = C.parseAction(raw).action;
  ok(got && got.type === expect.type && (expect.count == null || (got.count === expect.count && got.face === expect.face)),
    'parseAction: ' + raw.slice(0, 24), { got, expect });
}
ok(!C.parseAction('不开盅，先抬价').action, '否定式不误判开盅');
console.log(`  [3] parseAction ${cases.length + 1} 个样例`);

// ---- 4. UMD 双端一致 ----
const sandbox = { DiceEngine: E };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'dice-rules.js'), 'utf8'), sandbox);
ok(!!sandbox.DiceRules, '浏览器全局下 DiceRules 可用');
for (const raw of ['对手喊了 3 个 5。\n\n开盅', '喊 4 个 6', '']) {
  ok(JSON.stringify(sandbox.DiceRules.parseAction(raw)) === JSON.stringify(R.parseAction(raw)), '双端 parseAction 一致: ' + raw.slice(0, 12));
}
ok(C.parseAction === R.parseAction && C.checkLegal === R.checkLegal, 'context.js re-export 指向共享实现');
console.log('  [4] UMD 双端 + re-export 一致');

// ---- 5. 300 局随机对局 ----
let rounds = 0, steps = 0;
for (let g = 0; g < 300; g++) {
  const m = E.newMatch({ roundTarget: 3, firstBidder: g % 2 ? 'A' : 'B' });
  const rng = E.mulberry32(g + 1);
  for (let rd = 0; rd < 20 && !m.over; rd++) {
    const r = E.startRound(m, rng);
    rounds++;
    for (let t = 0; t < 200 && !r.over; t++) {
      steps++;
      const counts = E.legalCounts(r);
      const wantsOpen = r.bid && rng() < 0.25;
      if (wantsOpen) { E.resolveOpen(m, r.turn); continue; }
      if (!counts.length) { E.resolveOpen(m, r.turn); continue; }
      const c = counts[Math.floor(rng() * counts.length)];
      const faces = E.legalFaces(r, c);
      const f = faces[Math.floor(rng() * faces.length)];
      ok(C.checkLegal(r, { type: 'bid', count: c, face: f }) === null, '随机合法动作通过校验', { c, f, bid: r.bid });
      E.applyBid(r, r.turn, c, f);
    }
  }
}
console.log(`  [5] 300 局 / ${rounds} 轮 / ${steps} 手，无异常`);

// ---- 6. flex 套：checkLegal 与 legalActionSet 在首喊 / 未斋 / 斋 / 破斋后全枚举一致 ----
const RS = require('./dice-rulesets.js');
const FX = RS.normalize('flex');
const fxStates = [
  { bid:null, zhai:false },
  { bid:{ by:'B', count:5, face:6, mode:'normal', zhai:false, at:1 }, zhai:false },
  { bid:{ by:'B', count:3, face:3, mode:'toZhai', zhai:true, at:2 }, zhai:true },
  { bid:{ by:'B', count:6, face:2, mode:'breakZhai', zhai:false, at:3 }, zhai:false },
  { bid:{ by:'B', count:8, face:1, mode:'normal', zhai:true, at:2 }, zhai:true },
];
let fcombos = 0, fmismatch = 0;
for (const base of fxStates) {
  const r = Object.assign({ seq:[], rules:FX }, base);
  const set = E.legalActionSet(r);
  for (let c = 0; c <= 12; c++) for (let f = 0; f <= 7; f++) for (const mode of [null, 'toZhai', 'breakZhai']) {
    const a = { type:'bid', count:c, face:f, mode };
    fcombos++;
    const norm = E.normalizeAction(r, a);
    if ((R.checkLegal(r, a) === null) !== set.has(E.actionKey(norm))) {
      fmismatch++; if (fmismatch <= 6) console.log('  flex 差异:', base.bid, a, norm);
    }
  }
  for (const slash of [false, true]) {
    const a = { type:'open', slash }; fcombos++;
    const norm = E.normalizeAction(r, a);
    if ((R.checkLegal(r, a) === null) !== set.has(E.actionKey(norm))) {
      fmismatch++; console.log('  flex 开盅差异:', slash, base.bid);
    }
  }
}
ok(fmismatch === 0, `flex 枚举 ${fcombos} 组合，checkLegal 与引擎一致`);
console.log(`  [6] flex 枚举 ${fcombos} 个 (局面,动作)，差异 ${fmismatch} 处`);

// ---- 7. 首喊斋 → 翻倍破斋 → 劈 的完整状态机 ----
const zAll = [1, 1, 2, 3, 4, 5, 6, 6, 6, 1];
ok(E.countFace(zAll, 6, false) === 6 && E.countFace(zAll, 6, true) === 3, '斋开关：未斋时 1 算万能，斋时只数真实点数');
const zm = E.newMatch({ roundTarget:5, rules:FX });
const zr = E.startRound(zm, E.mulberry32(11));
ok(E.legalActionSet(zr).has('bid:3:4:toZhai'), '首喊可直接喊斋');
const firstZhaiAction = R.parseAction('行动：喊 3 个 4 斋').action;
ok(firstZhaiAction.mode === 'toZhai' && R.checkLegal(zr, firstZhaiAction) === null, '「喊 3 个 4 斋」被解析为首喊转斋且合法');
E.applyBid(zr, zr.turn, firstZhaiAction);
ok(zr.zhai === true && zr.bid.zhai === true, '首喊斋后本轮进入斋状态（被开时按斋结算）');
ok(E.breakCount(zr) === 6, '翻倍破斋个数 = 3 × 2 = 6');
ok(E.legalActionSet(zr).has('bid:6:5:breakZhai'), '斋内翻倍个数可破斋、点数任意');
ok(!E.legalActionSet(zr).has('bid:6:5:normal'), '翻倍个数不再同时作为留在斋里的普通抬价');
ok(E.normalizeAction(zr, { type:'bid', count:6, face:5 }).mode === 'breakZhai', '漏写「破斋」按个数自动推断');
E.applyBid(zr, zr.turn, R.parseAction('行动：喊 6 个 5 破斋').action);
ok(zr.zhai === false, '破斋后 1 恢复万能');
console.log('  [7] 首喊斋 / 翻倍破斋 / 计数与状态切换');

// ---- 8. 劈：与开盅同结算，积分零和 ±2 ----
const sm = E.newMatch({ roundTarget:10, rules:FX });
const sr = E.startRound(sm, E.mulberry32(3));
E.applyBid(sr, sr.turn, 2, 3);
const sres = E.resolveOpen(sm, sr.turn, { slash:true });
ok(sres.slash === true && sres.stake === 2, '劈的 stake = 2');
ok(sm.points[sres.winner] === 2 && sm.points[sres.loser] === -2, '劈结算零和 ±2');
ok(sm.points.A + sm.points.B === 0, '双方积分始终零和');
const nm = E.newMatch({ roundTarget:10, rules:FX });
const nr = E.startRound(nm, E.mulberry32(4));
E.applyBid(nr, nr.turn, 2, 3);
const nres = E.resolveOpen(nm, nr.turn, { slash:false });
ok(nres.stake === 1 && nm.points[nres.winner] === 1, '普通开盅仍是 ±1');
console.log('  [8] 劈 ±2 / 开盅 ±1 / 零和');

// ---- 9. 自定义规则套：参数真的改变引擎与规则文本 ----
const CUSTOM = RS.normalize({ id:'my1', name:'三倍取半 · 不许破斋', zhaiMode:'half',
  halfDivisor:3, breakMultiplier:0, firstZhai:false, slash:false, stake:1 });
const cm = E.newMatch({ rules:CUSTOM });
const cr = E.startRound(cm, E.mulberry32(5));
E.applyBid(cr, cr.turn, 6, 6);
ok(E.zhaiCount(cr) === 2, '自定义除数 3：ceil(6/3) = 2');
ok(!E.legalActions(cr).some(a => a.mode === 'breakZhai'), '自定义套禁止破斋时没有破斋动作');
ok(!E.legalActions(cr).some(a => a.type === 'open' && a.slash), '自定义套关闭劈时没有劈动作');
ok(!E.legalActions(E.startRound(E.newMatch({ rules:CUSTOM }))).some(a => a.mode === 'toZhai'), '自定义套关掉首喊斋');
const ctxt = RS.rulesText(CUSTOM);
ok(ctxt.includes('ceil(n / 3)') && !ctxt.includes('翻倍破斋') && !ctxt.includes('「劈」'), '规则文本按参数生成');
ok(RS.hash(CUSTOM) !== RS.hash(FX) && RS.hash('classic') === '177d9fc1', '自定义套指纹独立、经典套指纹不漂移');
console.log('  [9] 自定义规则套参数贯通引擎 / 文本 / 指纹');

// ---- 10. 200 局 flex 随机对局，覆盖转斋、破斋、劈 ----
let flexRounds = 0, flexSteps = 0, nSlash = 0, nToZhai = 0, nBreak = 0;
for (let g = 0; g < 200; g++) {
  const mm = E.newMatch({ roundTarget:3, rules:FX });
  const rng = E.mulberry32(5000 + g);
  for (let rd = 0; rd < 20 && !mm.over; rd++) {
    const rr = E.startRound(mm, rng); flexRounds++;
    for (let t = 0; t < 200 && !rr.over; t++) {
      flexSteps++;
      const acts = E.legalActions(rr);
      const a = acts[Math.floor(rng() * acts.length)];
      ok(R.checkLegal(rr, a) === null, 'flex 随机合法动作通过校验', { a, bid:rr.bid, zhai:rr.zhai });
      if (a.type === 'open') { if (a.slash) nSlash++; E.resolveOpen(mm, rr.turn, { slash:a.slash }); }
      else {
        if (a.mode === 'toZhai') nToZhai++;
        if (a.mode === 'breakZhai') nBreak++;
        E.applyBid(rr, rr.turn, a);
      }
    }
  }
}
ok(nSlash > 0 && nToZhai > 0 && nBreak > 0, '随机对局真的走到了劈 / 转斋 / 破斋',
  { nSlash, nToZhai, nBreak });
console.log(`  [10] 200 局 / ${flexRounds} 轮 / ${flexSteps} 手；劈 ${nSlash} · 转斋 ${nToZhai} · 破斋 ${nBreak}`);

console.log(failed ? `\n==> FAIL (${failed})` : '\n==> ALL PASS');
process.exit(failed ? 1 : 0);
