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
const RS = require('../src/dice-rulesets.js');
const FX = RS.normalize('flex');
const fxStates = [
  { bid:null, zhai:false },
  { bid:{ by:'B', count:5, face:6, mode:'normal', zhai:false, at:1 }, zhai:false },
  { bid:{ by:'B', count:3, face:3, mode:'toZhai', zhai:true, at:2 }, zhai:true, preZhai:{ by:'A', count:5, face:6, at:1 } },
  { bid:{ by:'B', count:6, face:2, mode:'breakZhai', zhai:false, at:3 }, zhai:false },
  { bid:{ by:'B', count:8, face:1, mode:'normal', zhai:true, at:2 }, zhai:true, preZhai:{ by:'A', count:9, face:2, at:1 } },
  // 破斋须超斋前：bc=4 与斋前同个数 → 只允许更大点数；斋前是 1 → 无点可破；首喊斋无斋前 → 任意
  { bid:{ by:'B', count:2, face:5, mode:'toZhai', zhai:true, at:2 }, zhai:true, preZhai:{ by:'A', count:4, face:5, at:1 } },
  { bid:{ by:'B', count:2, face:3, mode:'toZhai', zhai:true, at:2 }, zhai:true, preZhai:{ by:'A', count:4, face:1, at:1 } },
  { bid:{ by:'B', count:3, face:4, mode:'toZhai', zhai:true, at:1 }, zhai:true, preZhai:null },
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
ok(E.breakMinCount(zr) === 6, '破斋门槛 = 3 × 2 = 6（个数至少翻倍）');
ok(E.legalActionSet(zr).has('bid:6:5:breakZhai'), '斋内个数到门槛可破斋、点数任意');
ok(E.legalActionSet(zr).has('bid:8:2:breakZhai'), '个数超过门槛也可以破斋（「至少」翻倍）');
ok(E.legalActionSet(zr).has('bid:6:5:normal'), '同一手不写「破斋」也是合法动作（留在斋里的普通抬价）');
ok(E.normalizeAction(zr, { type:'bid', count:6, face:5 }).mode === 'normal', '漏写「破斋」不再自动推断成破斋');
// A：写「破斋」→ 回到未斋
const zrA = zr;
E.applyBid(zrA, zrA.turn, { type:'bid', count:6, face:5, mode:'breakZhai' });
ok(zrA.zhai === false, '写明「破斋」→ 破斋，1 恢复万能');
// B：同样个数不写「破斋」→ 留在斋里（用户例子：2个4斋 后 4个4 仍是斋）
const zb = E.startRound(zm, E.mulberry32(12));
E.applyBid(zb, zb.turn, { type:'bid', count:2, face:4, mode:'toZhai' });
E.applyBid(zb, zb.turn, { type:'bid', count:4, face:4, mode:'normal' });
ok(zb.zhai === true, '「2 个 4 斋」后喊「4 个 4」不写破斋 → 仍是斋状态');
ok(E.breakMinCount(zb) === 8, '斋里已经到 4 个，破斋门槛随之抬到 8 个');
// 首喊：点数 1~6 都能喊（喊 1 只是普通点数，不进斋），也能直接喊斋
const fs0 = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(41));
const firstBids = E.legalActions(fs0).filter(a => a.type === 'bid');
ok([...new Set(firstBids.map(a => a.face))].sort().join('') === '123456', '首喊点数 1~6 全可选');
ok(R.checkLegal(fs0, { type:'bid', count:2, face:1 }) === null, '首喊可以喊 2 个 1');
E.applyBid(fs0, fs0.turn, { type:'bid', count:2, face:1 });
ok(fs0.zhai === false, '首喊喊 1 不会进斋（进斋只能靠转斋 / 写斋）');
console.log('  [7] 首喊斋 / 至少翻倍破斋 / 必须写标记 / 状态切换');

// ---- 7b. 破斋两个条件 + 必须写标记：个数至少翻倍；整手严格大于斋前一手 ----
// 实战抓到的序列：4个5 → 转斋2个5 → 若允许压价破斋就能一直循环到 2 再横跳
const xm = E.newMatch({ roundTarget:5, rules:FX });
const xr = E.startRound(xm, E.mulberry32(21));
E.applyBid(xr, xr.turn, 4, 5);
E.applyBid(xr, xr.turn, { type:'bid', count:2, face:5, mode:'toZhai' });
ok(xr.preZhai && xr.preZhai.count === 4 && xr.preZhai.face === 5, '转斋时引擎记住斋前最高价');
ok(E.breakMinCount(xr) === 4, '破斋门槛 = 2 × 2 = 4');
ok(JSON.stringify(E.breakFaces(xr, 4)) === JSON.stringify([1,6]), '个数与斋前同为 4：只允许比斋前 5 更大的点数 6/1');
ok(E.breakFaces(xr, 5).length === 6, '个数超过斋前：点数任意');
const xset = E.legalActionSet(xr);
ok(!xset.has('bid:4:4:breakZhai') && !xset.has('bid:4:5:breakZhai'), '破斋 4个4 / 4个5 不高于斋前 4个5，不能破');
ok(xset.has('bid:4:6:breakZhai') && xset.has('bid:4:1:breakZhai'), '破斋 4个6 / 4个1 高于斋前，合法');
ok(xset.has('bid:5:2:breakZhai'), '个数 ≥ 门槛且超过斋前，5个2 也能破斋');
ok(xset.has('bid:4:4:normal'), '不写破斋的 4个4 是合法的斋内普通抬价');
ok(E.normalizeAction(xr, { type:'bid', count:4, face:4 }).mode === 'normal', '漏写标记的 4个4 按普通抬价，不是破斋');
const xwhy = R.checkLegal(xr, { type:'bid', count:4, face:4, mode:'breakZhai' });
ok(typeof xwhy === 'string' && xwhy.includes('斋前'), 'checkLegal 给出含「斋前」的针对性重写原因');
const xwhy2 = R.checkLegal(xr, { type:'bid', count:3, face:6, mode:'breakZhai' });
ok(typeof xwhy2 === 'string' && xwhy2.includes('2 倍'), '个数没到两倍：checkLegal 说清至少要翻倍');
ok(R.checkLegal(xr, { type:'bid', count:4, face:6, mode:'breakZhai' }) === null, 'checkLegal 放行超斋前的破斋');
let xThrow = false;
try { E.applyBid(xr, xr.turn, { type:'bid', count:4, face:4, mode:'breakZhai' }); } catch { xThrow = true; }
ok(xThrow, 'applyBid 拒绝压价破斋');
E.applyBid(xr, xr.turn, { type:'bid', count:4, face:6, mode:'breakZhai' });
ok(xr.zhai === false && xr.preZhai === null, '合法破斋后状态与斋前记录一起清除');
// 循环终结：把斋前逼到 4个1 之后，同个数的破斋再也凑不出来
E.applyBid(xr, xr.turn, { type:'bid', count:2, face:3, mode:'toZhai' });
ok(JSON.stringify(E.breakFaces(xr, 4)) === JSON.stringify([1]), '斋前 4个6：个数同为 4 时只剩 4个1 能破');
E.applyBid(xr, xr.turn, { type:'bid', count:4, face:1, mode:'breakZhai' });
E.applyBid(xr, xr.turn, { type:'bid', count:2, face:2, mode:'toZhai' });
ok(E.breakFaces(xr, 4).length === 0, '斋前 4个1：个数同为 4 无更大点数，4 个破不了；往上加个数仍可破');
ok(E.breakFaces(xr, 5).length === 6, '反弹验证：个数加到 5 就又能破斋（「至少」翻倍）');
ok(E.legalActions(xr).some(a => a.type === 'bid' && a.mode === 'normal'), '破斋受限时仍有普通抬价可走');
// 个数下限 2：任何喊价都不能少于 2 个，转斋取半不足 2 个就不许转
const c2 = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(33));
E.applyBid(c2, c2.turn, 2, 4);
ok(!E.legalActions(c2).some(a => a.type === 'bid' && a.mode === 'toZhai'), '当前 2 个：取半得 1 个，本轮不能转斋');
ok(!E.legalActions(c2).some(a => a.type === 'bid' && a.count < 2), '任何合法动作的个数都不少于 2');
ok(typeof R.checkLegal(c2, { type:'bid', count:1, face:3 }) === 'string', '喊 1 个判非法');
const c3 = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(34));
E.applyBid(c3, c3.turn, 3, 4);
ok(E.zhaiCount(c3) === 2 && E.legalActions(c3).some(a => a.type === 'bid' && a.mode === 'toZhai'), '当前 3 个：取半得 2 个，可以转斋');
// 个数不变换点数：1 是最大点数，换到 1 必须合法（未斋与斋都一样）
const f1 = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(35));
E.applyBid(f1, f1.turn, 3, 3);
ok(E.legalActionSet(f1).has('bid:3:1:normal'), '未斋 3个3 → 3个1 合法（1 是最大点数）');
ok(R.checkLegal(f1, { type:'bid', count:3, face:1 }) === null, 'checkLegal 放行 3个1');
const f1z = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(36));
E.applyBid(f1z, f1z.turn, { type:'bid', count:2, face:3, mode:'toZhai' });
ok(E.legalActionSet(f1z).has('bid:2:1:normal'), '斋内 2个3斋 → 2个1 合法');
E.applyBid(f1z, f1z.turn, { type:'bid', count:2, face:1 });
ok(f1z.zhai === true, '换到 1 之后仍在斋（喊 1 不等于破斋）');
// 同一手不许重复喊：转斋取半会落回老价位（截图里的 3个6 → 2个6斋 → 2个1 → 4个6破斋 → 2个1转斋）
const rp = E.startRound(E.newMatch({ hpMax:10, rules:FX }), E.mulberry32(37));
E.applyBid(rp, rp.turn, 3, 6);
E.applyBid(rp, rp.turn, { type:'bid', count:2, face:6, mode:'toZhai' });
E.applyBid(rp, rp.turn, 2, 1);
E.applyBid(rp, rp.turn, { type:'bid', count:4, face:6, mode:'breakZhai' });
ok(R.checkLegal(rp, { type:'bid', count:2, face:1, mode:'toZhai' }) !== null, '转斋落回本轮喊过的 2个1 → 非法');
ok(!E.legalActionSet(rp).has('bid:2:1:toZhai'), '合法集合里不再提供 2个1 转斋');
ok(!E.legalActionSet(rp).has('bid:2:6:toZhai'), '2个6 本轮也喊过 → 转斋同样不给');
ok(E.legalActionSet(rp).has('bid:2:3:toZhai'), '没喊过的 2个3 仍可转斋');
console.log('  [7b] 破斋＝至少翻倍 + 超过斋前 + 必须写标记');

// ---- 8. 血量结算：开盅只有输家掉血；劈双向（赢家回血、封顶上限）；经典套双向零和；归零判负 ----
const sm = E.newMatch({ hpMax:10, rules:FX });
const sr = E.startRound(sm, E.mulberry32(3));
E.applyBid(sr, sr.turn, 2, 3);
const sres = E.resolveOpen(sm, sr.turn, { slash:true });
ok(sres.slash === true && sres.stake === 1 && sres.loserPays === true, '劈：stake=1、双向结算');
ok(sm.hp[sres.loser] === 9, '劈：输家 −1 血');
ok(sm.hp[sres.winner] === 10, '劈：赢家满血时回不上去（封顶=开局血量）');

const sm2 = E.newMatch({ hpMax:10, rules:FX });
sm2.hp.A = 4; sm2.hp.B = 6;
const sr2 = E.startRound(sm2, E.mulberry32(3));
E.applyBid(sr2, sr2.turn, 2, 3);
const hres2 = E.resolveOpen(sm2, sr2.turn, { slash:true });
ok(sm2.hp[hres2.winner] === 5 && sm2.hp[hres2.loser] === 5, '劈：赢家 +1 血、输家 −1 血（双向）');

const nm = E.newMatch({ hpMax:10, rules:FX });
const nr = E.startRound(nm, E.mulberry32(4));
E.applyBid(nr, nr.turn, 2, 3);
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
E.applyBid(kor, kor.turn, 2, 3);
const kres = E.resolveOpen(ko, kor.turn, { slash:false });
ok(ko.hp[kres.loser] === 0 && ko.over === true && ko.winner === kres.winner, '血量归零 → 该方输掉整局');
console.log('  [8] 血量：开盅只扣输家 · 劈双向回血 ±1 · 经典零和 · 归零判负');

// ---- 8b. 斋内再写「斋」= 留在斋里的普通抬价，不判非法、不触发重试 ----
const zm2 = E.newMatch({ roundTarget:5, rules:FX });
const zr2 = E.startRound(zm2, E.mulberry32(31));
E.applyBid(zr2, 'A', 4, 5);
E.applyBid(zr2, 'B', { type:'bid', count:2, face:5, mode:'toZhai' });
ok(zr2.zhai === true, '转入斋状态');
const stay = R.parseAction('行动：喊 3 个 4 斋').action;
ok(stay.mode === 'toZhai', '解析层仍把「斋」标成 toZhai（词表不变）');
ok(E.normalizeAction(zr2, stay).mode === 'normal', '斋内再写「斋」被折成普通抬价');
ok(R.checkLegal(zr2, stay) === null, '斋内「喊 3 个 4 斋」合法，不需要重试');
E.applyBid(zr2, zr2.turn, stay);
ok(zr2.bid.count === 3 && zr2.bid.face === 4 && zr2.zhai === true, '落子后仍留在斋内');
ok(E.normalizeAction(zr2, { type:'bid', count:6, face:2, mode:'breakZhai' }).mode === 'breakZhai', '「破斋」标记不受影响');
ok(E.normalizeAction(zr2, { type:'bid', count:4, face:6 }).mode === 'normal', '斋内普通抬价不受影响');
console.log('  [8b] 斋内写「斋」幂等：不重试、仍留斋');

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
// 2026-11-10 计分改为血量制（输家掉血、归零判负），指纹并入 |hp=1：积分制时代的旧 run 与现在不可比。
ok(RS.hash(CUSTOM) !== RS.hash(FX) && RS.hash('classic') === '413e1d1d', '自定义套指纹独立、经典套指纹随血量制版本锁定');
ok(RS.hash(FX) === '663ae23e', 'flex 指纹锁定（破斋＝至少翻倍 + 必须写标记 + 个数≥2 + 血量制 + 合法集修正 sv2 + 不许重复喊 nr + 首喊点数可到 1，与更早的 flex 数据不可比）');
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
          const pre = rr.preZhai;
          ok(!pre || a.count > pre.count || (a.count === pre.count && E.ord(a.face) > E.ord(pre.face)),
            '落子的破斋严格大于斋前', { a, pre });
        }
        E.applyBid(rr, rr.turn, a);
      }
    }
  }
  ok(mm.over && mm.winner && mm.hp[E.other(mm.winner)] === 0, '随机对局打到一方血量归零');
}
console.log(`  [10] 单局 / ${flexRounds} 轮 / ${flexSteps} 手；劈 ${nSlash} · 转斋 ${nToZhai} · 破斋 ${nBreak}`);

console.log(failed ? `\n==> FAIL (${failed})` : '\n==> ALL PASS');
process.exit(failed ? 1 : 0);
