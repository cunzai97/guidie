#!/usr/bin/env node
/* 规则/解析回归：无网络、无 LLM。
 * 1) checkLegal 与引擎合法动作集合全枚举比对（单一真源的不变量）
 * 2) applyBid 的个数上界
 * 3) parseAction 关键样例
 * 4) UMD 模块在"浏览器全局"与 Node 下行为一致
 * 5) 300 局随机对局，校验合法性、计数与判负
 * 用法: node tests/test-rules.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const E = require('../src/dice-engine.js');
const C = require('../src/context.js');
const R = require('../src/dice-rules.js');

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
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'dice-rules.js'), 'utf8'), sandbox);
ok(!!sandbox.DiceRules, '浏览器全局下 DiceRules 可用');
for (const raw of ['对手喊了 3 个 5。\n\n开盅', '喊 4 个 6', '']) {
  ok(JSON.stringify(sandbox.DiceRules.parseAction(raw)) === JSON.stringify(R.parseAction(raw)), '双端 parseAction 一致: ' + raw.slice(0, 12));
}
ok(C.parseAction === R.parseAction && C.checkLegal === R.checkLegal, 'context.js re-export 指向共享实现');
console.log('  [4] UMD 双端 + re-export 一致');

// ---- 5. 300 局随机对局 ----
let rounds = 0, steps = 0;
for (let g = 0; g < 300; g++) {
  // 这一节是「经典套」随机对局：newMatch 默认已改 flex，必须显式写 classic 保持原意。
  const m = E.newMatch({ roundTarget: 3, firstBidder: g % 2 ? 'A' : 'B', rules: 'classic' });
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
const RS = require('../src/dice-rulesets.js');
const FX = RS.normalize('flex');
const fxStates = [
  { bid:null, zhai:false },
  { bid:{ by:'B', count:5, face:6, mode:'normal', zhai:false, at:1 }, zhai:false },
  { bid:{ by:'B', count:3, face:3, mode:'toZhai', zhai:true, at:2 }, zhai:true },
  { bid:{ by:'B', count:6, face:2, mode:'breakZhai', zhai:false, at:3 }, zhai:false },
  { bid:{ by:'B', count:8, face:1, mode:'normal', zhai:true, at:2 }, zhai:true },
  // 破斋 2n：门槛随个数走，点数一律任意；2 个斋 → 4 个起破
  { bid:{ by:'B', count:2, face:5, mode:'toZhai', zhai:true, at:2 }, zhai:true },
  { bid:{ by:'B', count:2, face:3, mode:'toZhai', zhai:true, at:2 }, zhai:true },
  { bid:{ by:'B', count:3, face:4, mode:'toZhai', zhai:true, at:1 }, zhai:true },
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
ok(E.breakMinCount(zr) === 6, '破斋门槛 = 3 × 2 = 6（正好两倍）');
ok(E.legalActionSet(zr).has('bid:7:5:breakZhai'), '斋内个数到门槛可破斋、点数任意');
ok(E.legalActionSet(zr).has('bid:9:2:breakZhai'), '个数超过门槛也可以破斋');
ok(E.legalActionSet(zr).has('bid:6:5:breakZhai'), '门槛上就能破：3 个斋要 6 个');
ok(!E.legalActionSet(zr).has('bid:5:5:breakZhai'), '不到 2n 的 5 个破不了斋');
ok(E.legalActionSet(zr).has('bid:7:5:normal'), '同一个数不写「破斋」也是合法动作（留在斋里的普通抬价）');
ok(E.normalizeAction(zr, { type:'bid', count:7, face:5 }).mode === 'normal', '漏写「破斋」不再自动推断成破斋');
// A：写「破斋」→ 回到未斋
const zrA = zr;
E.applyBid(zrA, zrA.turn, { type:'bid', count:7, face:5, mode:'breakZhai' });
ok(zrA.zhai === false, '写明「破斋」→ 破斋，1 恢复万能');
// B：同样个数不写「破斋」→ 留在斋里（用户例子：2个4斋 后 4个4 仍是斋）
const zb = E.startRound(zm, E.mulberry32(12));
E.applyBid(zb, zb.turn, { type:'bid', count:3, face:4, mode:'toZhai' });
E.applyBid(zb, zb.turn, { type:'bid', count:4, face:4, mode:'normal' });
ok(zb.zhai === true, '「2 个 4 斋」后喊「4 个 4」不写破斋 → 仍是斋状态');
ok(E.breakMinCount(zb) === 8, '斋里已经到 4 个，破斋门槛随之抬到 8 个（4×2）');
// 首喊：点数 1~6 都能喊（喊 1 即斋），也能直接喊斋
const fs0 = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(41));
const firstBids = E.legalActions(fs0).filter(a => a.type === 'bid');
ok([...new Set(firstBids.map(a => a.face))].sort().join('') === '123456', '首喊点数 1~6 全可选');
ok(R.checkLegal(fs0, { type:'bid', count:3, face:1 }) === null, '首喊可以喊 3 个 1');
ok(R.checkLegal(fs0, { type:'bid', count:2, face:1 }) !== null, '首喊 2 个被 ≥3 下限拒绝');
E.applyBid(fs0, fs0.turn, { type:'bid', count:3, face:1 });
ok(fs0.zhai === true, '首喊喊 1 即以斋开局（喊 1 就是斋）');
console.log('  [7] 首喊斋 / 2n 破斋 / 必须写标记 / 状态切换');

// ---- 7b. 破斋 = 正好两倍：一条规则，同时天然挡掉压价循环 ----
// 转斋把 n 砍到 ceil(n/2+0.5)，破斋门槛 2·ceil(n/2+0.5) > n，所以「破斋后最高价」永远比斋前高，
// 不需要再记斋前那一手，也不需要「整手必须超过斋前」这条附加条件。
const xm = E.newMatch({ roundTarget:5, rules:FX });
const xr = E.startRound(xm, E.mulberry32(21));
E.applyBid(xr, xr.turn, 4, 5);
E.applyBid(xr, xr.turn, { type:'bid', count:3, face:5, mode:'toZhai' });
ok(E.breakMinCount(xr) === 6, '破斋门槛 = 3 × 2 = 6');
ok(E.breakFaces(xr, 5).length === 0 && E.breakFaces(xr, 6).join('') === '23456', '5 个破不了斋；6 个起点数 2~6（喊 1 会又进斋）');
const xset = E.legalActionSet(xr);
ok(!xset.has('bid:5:6:breakZhai') && !xset.has('bid:5:1:breakZhai'), '不到 2n（5 个）任何时候都破不了斋，与点数无关');
ok(xset.has('bid:6:2:breakZhai') && xset.has('bid:6:6:breakZhai'), '6 个 + 点数 2~6 都能破斋');
ok(!xset.has('bid:6:1:breakZhai'), '破斋不能喊 1（喊 1 立刻又是斋）');
ok(xset.has('bid:4:4:normal'), '不写破斋的 4个4 仍是合法的斋内普通抬价');
ok(E.normalizeAction(xr, { type:'bid', count:5, face:2 }).mode === 'normal', '漏写标记的 5个2 按普通抬价，不是破斋');
const xwhy = R.checkLegal(xr, { type:'bid', count:5, face:6, mode:'breakZhai' });
ok(typeof xwhy === 'string' && xwhy.includes('2 倍') && !xwhy.includes('再加 1') && xwhy.includes('至少 6 个'), 'checkLegal 说清门槛是「正好 2 倍」');
ok(R.checkLegal(xr, { type:'bid', count:6, face:6, mode:'breakZhai' }) === null, 'checkLegal 放行门槛上的破斋');
let xThrow = false;
try { E.applyBid(xr, xr.turn, { type:'bid', count:5, face:6, mode:'breakZhai' }); } catch { xThrow = true; }
ok(xThrow, 'applyBid 拒绝不到 2n 的破斋');
E.applyBid(xr, xr.turn, { type:'bid', count:6, face:6, mode:'breakZhai' });
ok(xr.zhai === false, '合法破斋后回到未斋');
// 结构性：斋↔破斋每转一圈，最高价至少涨 1，永远不会绕回去（不再需要斋前记账）
{
  let allMono = true;
  for (let n = 2; n <= 10; n++) if (2 * Math.ceil(n / 2 + 0.5) <= n) allMono = false;
  ok(allMono, '2·ceil(n/2+0.5) > n 对 n=2..10 恒成立 → 破斋后最高价必然高于斋前');
  // 实跑一圈：4个5 → 3个5斋 → 6个6破斋（4→3→6）
  const mm = E.newMatch({ hpMax:10, rules:FX });
  const rr = E.startRound(mm, E.mulberry32(77));
  E.applyBid(rr, rr.turn, 4, 5);
  E.applyBid(rr, rr.turn, { type:'bid', count:3, face:5, mode:'toZhai' });
  ok(E.breakMinCount(rr) === 6, '4 个转斋成 3 个，破斋门槛 6（高于斋前的 4）');
  E.applyBid(rr, rr.turn, { type:'bid', count:6, face:6, mode:'breakZhai' });
  ok(rr.bid.count === 6 && !rr.zhai, '破斋落地：6 个 6，回到未斋');
}
console.log('  [7b] 破斋＝正好两倍（不再需要斋前记账）');

// ---- 8. 血量结算：开盅只有输家掉血；劈双向（赢家回血、封顶上限）；经典套双向零和；归零判负 ----
const sm = E.newMatch({ hpMax:10, rules:FX });
const sr = E.startRound(sm, E.mulberry32(3));
E.applyBid(sr, sr.turn, 3, 3);
const sres = E.resolveOpen(sm, sr.turn, { slash:true });
ok(sres.slash === true && sres.stake === 1 && sres.loserPays === true, '劈：stake=1、双向结算');
ok(sm.hp[sres.loser] === 9, '劈：输家 −1 血');
ok(sm.hp[sres.winner] === 10, '劈：赢家满血时回不上去（封顶=开局血量）');

const sm2 = E.newMatch({ hpMax:10, rules:FX });
sm2.hp.A = 4; sm2.hp.B = 6;
const sr2 = E.startRound(sm2, E.mulberry32(3));
E.applyBid(sr2, sr2.turn, 3, 3);
const hres2 = E.resolveOpen(sm2, sr2.turn, { slash:true });
ok(sm2.hp[hres2.winner] === 5 && sm2.hp[hres2.loser] === 5, '劈：赢家 +1 血、输家 −1 血（双向）');

const nm = E.newMatch({ hpMax:10, rules:FX });
const nr = E.startRound(nm, E.mulberry32(4));
E.applyBid(nr, nr.turn, 3, 3);
const nres = E.resolveOpen(nm, nr.turn, { slash:false });
ok(nres.stake === 1 && nres.loserPays === false, '开盅：只有输家掉血');
ok(nm.hp[nres.loser] === 9 && nm.hp[nres.winner] === 10, '开盅：输家 −1 血、赢家不回血');

const cm2 = E.newMatch({ hpMax:10, rules:'classic' });
cm2.hp.A = 5; cm2.hp.B = 5;
const cr2 = E.startRound(cm2, E.mulberry32(6));
E.applyBid(cr2, cr2.turn, 2, 3);
ok(!E.legalActionSet(cr2).has('open:slash'), '经典套没有劈');
const cres = E.resolveOpen(cm2, cr2.turn);
ok(cres.stake === 1 && cres.loserPays === true && cm2.hp[cres.winner] === 6 && cm2.hp[cres.loser] === 4,
  '经典套双向零和：赢家 +1 血、输家 −1 血');

// 归零判负：血量只到 1 再输一轮就整局结束
const ko = E.newMatch({ hpMax:10, rules:FX });
ko.hp.A = 1; ko.hp.B = 1;   // 双方都是残血：谁输这一轮谁归零
const kor = E.startRound(ko, E.mulberry32(9));
E.applyBid(kor, kor.turn, 3, 3);
const kres = E.resolveOpen(ko, kor.turn, { slash:false });
ok(ko.hp[kres.loser] === 0 && ko.over === true && ko.winner === kres.winner, '血量归零 → 该方输掉整局');
console.log('  [8] 血量：开盅只扣输家 · 劈双向回血 ±1 · 经典零和 · 归零判负');

// ---- 8b. 斋内再写「斋」= 留在斋里的普通抬价，不判非法、不触发重试 ----
const zm2 = E.newMatch({ roundTarget:5, rules:FX });
const zr2 = E.startRound(zm2, E.mulberry32(31));
E.applyBid(zr2, 'A', 4, 5);
E.applyBid(zr2, 'B', { type:'bid', count:3, face:5, mode:'toZhai' });
ok(zr2.zhai === true, '转入斋状态');
const stay = R.parseAction('行动：喊 4 个 4 斋').action;
ok(stay.mode === 'toZhai', '解析层仍把「斋」标成 toZhai（词表不变）');
ok(E.normalizeAction(zr2, stay).mode === 'normal', '斋内再写「斋」被折成普通抬价');
ok(R.checkLegal(zr2, stay) === null, '斋内「喊 4 个 4 斋」合法，不需要重试');
E.applyBid(zr2, zr2.turn, stay);
ok(zr2.bid.count === 4 && zr2.bid.face === 4 && zr2.zhai === true, '落子后仍留在斋内');
ok(E.normalizeAction(zr2, { type:'bid', count:6, face:2, mode:'breakZhai' }).mode === 'breakZhai', '「破斋」标记不受影响');
ok(E.normalizeAction(zr2, { type:'bid', count:4, face:6 }).mode === 'normal', '斋内普通抬价不受影响');
console.log('  [8b] 斋内写「斋」幂等：不重试、仍留斋');

// ---- 9. 自定义规则套：参数真的改变引擎与规则文本 ----
const CUSTOM = RS.normalize({ id:'my1', name:'三倍取半 · 不许破斋', zhaiMode:'half',
  halfDivisor:3, breakMultiplier:0, firstZhai:false, slash:false, stake:1 });
const cm = E.newMatch({ rules:CUSTOM });
const cr = E.startRound(cm, E.mulberry32(5));
E.applyBid(cr, cr.turn, 6, 6);
ok(E.zhaiCount(cr) === 3, '自定义除数 3：ceil(6/3 + 0.5) = 3');
ok(!E.legalActions(cr).some(a => a.mode === 'breakZhai'), '自定义套禁止破斋时没有破斋动作');
ok(!E.legalActions(cr).some(a => a.type === 'open' && a.slash), '自定义套关闭劈时没有劈动作');
ok(!E.legalActions(E.startRound(E.newMatch({ rules:CUSTOM }))).some(a => a.mode === 'toZhai'), '自定义套关掉首喊斋');
const ctxt = RS.rulesText(CUSTOM);
ok(ctxt.includes('ceil(n / 3 + 0.5)') && !ctxt.includes('翻倍破斋') && !ctxt.includes('「劈」'), '规则文本按参数生成');
// 2026-11-10 计分改为血量制（输家掉血、归零判负），指纹并入 |hp=1：积分制时代的旧 run 与现在不可比。
ok(RS.hash(CUSTOM) !== RS.hash(FX) && RS.hash('classic') === '413e1d1d', '自定义套指纹独立、经典套指纹随血量制版本锁定');
ok(RS.hash(FX) === 'a6c5a8ef', 'flex 指纹锁定（2026-11-12 新规：破斋＝正好两倍 bv4 + 首喊≥3 + 转斋范围 sv3 + 血量制 + 喊 1 即斋，与更早的 flex 数据不可比）');
console.log('  [9] 自定义规则套参数贯通引擎 / 文本 / 指纹');

// ---- 10. 单局 flex 随机对局（跑到血量归零），覆盖转斋、破斋、劈 ----
// 每手都跑一遍合法性校验；只跑一局，够覆盖到三种状态切换就不必堆样本量。
let flexRounds = 0, flexSteps = 0, nSlash = 0, nToZhai = 0, nBreak = 0;
{
  const mm = E.newMatch({ hpMax:10, rules:FX });
  const rng = E.mulberry32(5000);
  for (let rd = 0; rd < 200 && !mm.over; rd++) {
    const rr = E.startRound(mm, rng); flexRounds++;
    for (let t = 0; t < 200 && !rr.over; t++) {
      flexSteps++;
      const acts = E.legalActions(rr);
      const a = acts[Math.floor(rng() * acts.length)];
      ok(R.checkLegal(rr, a) === null, 'flex 随机合法动作通过校验', { a, bid:rr.bid, zhai:rr.zhai });
      if (a.type === 'open') { if (a.slash) nSlash++; E.resolveOpen(mm, rr.turn, { slash:a.slash }); }
      else {
        if (a.mode === 'toZhai') nToZhai++;
        if (a.mode === 'breakZhai') {
          nBreak++;
          // 不变量：每一手真实落子的破斋都严格大于斋前一手（同个数则点数更大）
          ok(a.count >= E.breakMinCount(rr), '落子的破斋个数达到 2n 门槛', { a, bid: rr.bid });
        }
        E.applyBid(rr, rr.turn, a);
      }
    }
  }
  ok(mm.over && mm.winner && mm.hp[E.other(mm.winner)] === 0, '随机对局打到一方血量归零');
}
console.log(`  [10] 单局 / ${flexRounds} 轮 / ${flexSteps} 手；劈 ${nSlash} · 转斋 ${nToZhai} · 破斋 ${nBreak}`);

// ---- 11. 2026-11-12 新规：四条边界 + 默认规则 + classic 逐字不动 ----
{
  // 边界 2/4：≥3 只管未斋普通喊价与首喊（含首喊直接喊斋）
  const f0 = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(91));
  const firstCounts = E.legalActions(f0).filter(a => a.type === 'bid').map(a => a.count);
  ok(Math.min(...firstCounts) === 3, '首喊最小个数 = 3');
  const fset = E.legalActionSet(f0);
  ok(!fset.has('bid:2:4:normal') && fset.has('bid:3:4:normal'), '首喊 2 个非法 / 3 个合法');
  ok(fset.has('bid:3:4:toZhai') && !fset.has('bid:2:4:toZhai'), '首喊直接喊斋同样 ≥3');
  ok(R.checkLegal(f0, { type:'bid', count:2, face:4, mode:'toZhai' }) !== null, '首喊 2 个「斋」被 ≥3 下限拒绝');

  // 边界 1/3：转斋是 [zc, 10] 的范围；autoInfer 只认恰好等于 zc 的那一档
  const turnCase = (n, zc) => {
    const r = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(200 + n));
    E.applyBid(r, r.turn, n, 5);
    ok(E.zhaiCount(r) === zc, 'n=' + n + ' → 转斋最低档 ' + zc + '（ceil(n/2+0.5)）');
    const set = E.legalActionSet(r);
    ok(set.has('bid:' + zc + ':4:toZhai'), 'n=' + n + '：最低档可转斋');
    ok(!set.has('bid:' + (zc - 1) + ':4:toZhai'), 'n=' + n + '：低于最低档不能转斋');
    ok(set.has('bid:10:4:toZhai'), 'n=' + n + '：10 个也能转斋（范围是 [zc,10]）');
    ok(R.checkLegal(r, { type:'bid', count:zc + 1, face:4, mode:'toZhai' }) === null,
       'n=' + n + '：高一档并写明「斋」合法');
    ok(E.normalizeAction(r, { type:'bid', count:zc, face:4 }).mode === 'toZhai',
       'n=' + n + '：漏写「斋」但恰好最低档 → 自动转斋');
    ok(E.normalizeAction(r, { type:'bid', count:zc + 1, face:4 }).mode === 'normal',
       'n=' + n + '：漏写「斋」且高一档 → 普通抬价，不误判转斋');
  };
  turnCase(4, 3); turnCase(5, 3); turnCase(6, 4); turnCase(3, 2);

  // 破斋 ≥2n；2n 超过 10 颗则本轮破不了斋（沿用现有处理）
  const breakCase = (n, min) => {
    const r = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(300 + n));
    E.applyBid(r, r.turn, { type:'bid', count:n, face:4, mode:'toZhai' });
    ok(E.breakMinCount(r) === min, 'n=' + n + ' → 破斋门槛 2n = ' + min);
    if (min <= 10) {
      ok(E.legalActionSet(r).has('bid:' + min + ':4:breakZhai'), 'n=' + n + '：门槛上可破斋');
      ok(!E.legalActionSet(r).has('bid:' + (min - 1) + ':4:breakZhai'), 'n=' + n + '：少一个破不了斋');
    } else {
      ok(E.breakCount(r) === null, 'n=' + n + '：2n > 10 → breakCount=null');
      ok(!E.legalActions(r).some(a => a.mode === 'breakZhai'), 'n=' + n + '：本轮没有任何破斋动作');
      ok(R.checkLegal(r, { type:'bid', count:10, face:4, mode:'breakZhai' }) !== null,
         'n=' + n + '：连喊 10 个破斋也被拒');
    }
  };
  breakCase(3, 6); breakCase(4, 8); breakCase(5, 10); breakCase(6, 12);

  // 边界 2 的另一半：进斋之后的普通抬价可以低于 3
  const rz = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(410));
  E.applyBid(rz, rz.turn, 3, 4);
  E.applyBid(rz, rz.turn, { type:'bid', count:2, face:5, mode:'toZhai' });
  ok(rz.zhai === true && rz.bid.count === 2, 'n=3 转斋到 2 个（转斋不受 ≥3 约束）');
  ok(E.legalActionSet(rz).has('bid:2:6:normal'), '斋内 2 个 6 在权威集合里');
  ok(R.checkLegal(rz, { type:'bid', count:2, face:6, mode:'normal' }) === null,
     '斋内 2 个普通抬价合法，不被 ≥3 下限误拒');

  // 默认规则：新局一律 flex；显式 classic 与「传入整套规则」都不回改
  ok(E.newMatch({}).rules.id === 'flex', 'newMatch 不传 rules → 默认 flex');
  ok(E.newMatch({ rules:'classic' }).rules.id === 'classic', '显式 classic 仍 classic');
  ok(E.newMatch({ rules: RS.normalize('classic') }).rules.id === 'classic', '房间传入已存规则对象时不回改');
  const CL = RS.normalize('classic');
  ok(CL.minCount === 2 && CL.firstMin === 2 && CL.breakPlus === 0, 'classic 参数逐字不动');
  ok(RS.hash('classic') === '413e1d1d', 'classic 指纹不因新规漂移');
  const cr = E.startRound(E.newMatch({ rules:'classic' }), E.mulberry32(7));
  ok(E.legalActionSet(cr).has('bid:2:4:normal'), 'classic 首喊仍是 2 个');
  E.applyBid(cr, cr.turn, 6, 3);
  ok(E.zhaiCount(cr) === 3, 'classic 的 zhaiCount 仍是 ceil(6/2)=3，没被新公式带跑');
  ok(RS.hash(FX) !== RS.hash('classic'), '新 flex 与 classic 仍是两个 cohort');
}
console.log('  [11] 2026-11-12 新规四条边界 / 默认 flex / classic 不变');

console.log(failed ? `\n==> FAIL (${failed})` : '\n==> ALL PASS');
process.exit(failed ? 1 : 0);
