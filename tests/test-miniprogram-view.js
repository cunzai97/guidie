#!/usr/bin/env node
/* 牌桌渲染逻辑自检：不启动微信开发者工具，直接把「服务端 view」喂进页面，检查它算出来的界面数据。
 *
 * 覆盖的是最容易错、又最难在真机上看出来的那几处：
 *   - 骰子：自己的 5 颗 / 对手只有背面
 *   - 喊价文案：普通 / 转斋 / 破斋 / 斋局
 *   - 选择器：个数与点数的合法组合、模式只给合法项、切换时自动兜底
 *   - 按钮：开盅 / 劈 的可用性严格跟着 view.legal 走
 *   - 开盅亮牌：按昵称对齐座位，复式换座也不串
 *   - 整桌结算：净胜血与「你」的标注
 *
 * 用法：node tests/test-miniprogram-view.js
 */
'use strict';
const path = require('node:path');

const MP = path.join(__dirname, '..', 'miniprogram');
let pass = 0, fail = 0;
const ok = (c, n, e) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 220) : '')); }
};

// —— 假运行环境：只要够页面模块加载 + setData 落地 ——
function loadPage(rel) {
  let def = null;
  global.Page = d => { def = d; };
  global.getApp = () => ({ globalData: {}, seatToken: () => '', setSeatToken() { }, setSession() { } });
  global.wx = {
    getStorageSync: () => '', setStorageSync() { }, removeStorageSync() { },
    request() { }, setNavigationBarTitle() { }, navigateBack() { }, showToast() { }, login() { },
  };
  require(path.join(MP, rel));
  return def;
}
function instance(def, role) {
  const o = Object.create(def);
  o.data = JSON.parse(JSON.stringify(def.data));
  o.setData = function (patch) { Object.assign(this.data, patch); };
  o.role = role;
  o.legal = [];
  o.sel = null;
  o.revealDice = null;
  o.lastRoundNo = null;
  o.seatToken = 't';
  o.stopTimer = () => { };
  return o;
}

const defTable = loadPage('pages/table/table.js');

console.log('· 牌桌渲染逻辑');

/* ---------- 1. 首喊：自己的骰子 + 对手背面 ---------- */
const firstView = {
  seat: 'A', roundNo: 1, over: false, hpMax: 8,
  hp: { me: 8, opp: 8 }, losses: { me: 0, opp: 0 },
  firstBidder: 'me',
  dice: [1, 2, 2, 4, 6], counts: { 1: 1, 2: 2, 3: 0, 4: 1, 5: 0, 6: 1 },
  zhai: false, turn: 'me', bid: null, seq: [], canOpen: false,
  legal: [
    { type: 'bid', count: 1, face: 2 }, { type: 'bid', count: 1, face: 4 },
    { type: 'bid', count: 2, face: 2 }, { type: 'bid', count: 2, face: 6 },
  ],
  history: [],
};
const p1 = instance(defTable, 'A');
p1.applyView(firstView);
ok(p1.data.myDice.length === 5, '自己的骰子渲染 5 颗');
ok(p1.data.myDice[0].cells.filter(Boolean).length === 1, '1 点只有 1 个点');
ok(p1.data.myDice[0].wild === true, '未斋时 1 标记为万能');
ok(p1.data.oppDice.length === 5 && p1.data.oppRevealed === false, '对手只有 5 张背面');
ok(p1.data.oppDice.every(d => d.cells.every(x => !x)), '对手背面没有点数泄漏');
ok(p1.data.bidText === '还没人喊价', '首喊文案正确', p1.data.bidText);
ok(p1.data.bidSub.includes('轮到你首喊'), '提示轮到你首喊', p1.data.bidSub);
ok(p1.data.counts.join(',') === '1,2', '个数选项来自 legal', p1.data.counts);
ok(p1.data.faces.map(f => f.face).join(',') === '2,4,6', '点数按 2<3<4<5<6<1 排序', p1.data.faces);
ok(p1.data.preview.includes('喊'), '落子预览有文案', p1.data.preview);
ok(p1.data.canOpen === false, '首喊不能开盅');

/* ---------- 2. 有喊价 + 可开盅 / 可劈 ---------- */
const midView = {
  seat: 'A', roundNo: 3, over: false, hpMax: 8,
  hp: { me: 3, opp: 6 }, losses: { me: 1, opp: 0 },
  firstBidder: 'opp',
  dice: [5, 5, 5, 1, 3], counts: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 3, 6: 0 },
  zhai: false, turn: 'me',
  bid: { by: 'opp', count: 4, face: 5, zhai: false, mode: 'toZhai' },
  seq: [
    { at: 1, by: 'opp', count: 4, face: 5, zhai: false, mode: 'toZhai' },
    { at: 2, by: 'me', count: 5, face: 5, zhai: false, mode: null },
  ],
  canOpen: true,
  legal: [
    { type: 'bid', count: 5, face: 2, mode: 'toZhai' },
    { type: 'bid', count: 6, face: 3 },
    { type: 'bid', count: 8, face: 5, mode: 'breakZhai' },
    { type: 'open', slash: false }, { type: 'open', slash: true },
  ],
  history: [{
    no: 1, slash: false, stake: 1, zhai: false, actual: 3, truth: false,
    loser: 'me', winner: 'opp', opener: 'opp',
    bid: { by: 'opp', count: 5, face: 4, zhai: false, mode: null },
  }, {
    no: 2, slash: true, stake: 2, zhai: false, actual: 6, truth: true,
    loser: 'opp', winner: 'me', opener: 'me',
    bid: { by: 'me', count: 4, face: 2, zhai: false, mode: null },
  }],
};
const p2 = instance(defTable, 'A');
p2.applyView(midView);
ok(p2.data.bidText === '转斋 4 个 5', '转斋文案带前缀', p2.data.bidText);
ok(p2.data.bidSub.includes('对手 喊的'), '喊价人正确', p2.data.bidSub);
ok(p2.data.hpMe === 3 && p2.data.hpOpp === 6, '血量按座位取');
ok(p2.data.hpMePct === 38, '血量条百分比', p2.data.hpMePct);
ok(p2.data.canOpen === true && p2.data.canSlash === true, '开盅 / 劈 都可用');
ok(p2.data.seqList.length === 2 && p2.data.seqList[1].mine === true, '本轮流水区分你我');
ok(p2.data.seqList[0].text.includes('转斋'), '流水里标出转斋');
ok(p2.data.histList.length === 2, '开盅记录 2 条');
ok(p2.data.histList[0].body.includes('不够'), '开盅记录写清真值（不够 = 喊的人赢）', p2.data.histList[0]);
ok(p2.data.histList[1].body.includes('劈'), '劈 也写进记录', p2.data.histList[1].body);

/* ---------- 3. 选择器：模式只给合法项 ---------- */
ok(p2.data.faces.map(f => f.face).join(',') === '2,3,5', '点数候选来自 legal', p2.data.faces);
ok(p2.data.counts.join(',') === '5,6,8', '个数候选来自 legal', p2.data.counts);
ok(p2.data.preview.includes('转斋') || p2.data.preview.includes('破斋') || p2.data.preview.includes('喊'), '预览有内容', p2.data.preview);

// 选 8 个 → 只应剩破斋模式
p2.onPickCount({ currentTarget: { dataset: { c: 8 } } });
ok(p2.data.countSel === 8, '切到 8 个');
ok(p2.data.modeOpts.length === 1 && p2.data.modeOpts[0].id === 'breakZhai', '8 个只允许破斋', p2.data.modeOpts);
ok(p2.data.preview.includes('破斋'), '预览跟着变破斋', p2.data.preview);

// 再点一个当前个数下不存在的点数，应该原地不动（不是崩，也不是乱跳）
const beforeFace = p2.data.faceSel;
p2.onPickFace({ currentTarget: { dataset: { f: 4 } } });
ok(p2.data.faceSel === beforeFace, '非法点数点击被忽略', { beforeFace, after: p2.data.faceSel });

// 切回 6 个：模式应回到 normal，且点数自动兜底到 3
p2.onPickCount({ currentTarget: { dataset: { c: 6 } } });
ok(p2.data.countSel === 6 && p2.data.faceSel === 3, '切换个数自动兜底到合法点数', { c: p2.data.countSel, f: p2.data.faceSel });
ok(p2.data.modeSel === 'normal', '模式自动回到普通抬价', p2.data.modeSel);

/* ---------- 4. 斋局 ---------- */
const zhaiView = Object.assign({}, firstView, {
  zhai: true,
  dice: [1, 1, 3, 4, 5],
  counts: { 1: 2, 2: 0, 3: 1, 4: 1, 5: 1, 6: 0 },
});
const p3 = instance(defTable, 'A');
p3.applyView(zhaiView);
ok(p3.data.zhai === true, '斋局标记');
ok(p3.data.myDice[0].wild === false, '斋局里 1 不再是万能', p3.data.myDice[0]);
ok(p3.data.countsText.includes('斋'), '计数说明标出斋', p3.data.countsText);

/* ---------- 5. 观战视角 ---------- */
const specView = {
  roundNo: 2, over: false, hpMax: 8, hp: { A: 5, B: 7 }, losses: { A: 1, B: 0 },
  firstBidder: 'A', zhai: false, turn: 'B', bid: null, seq: [], history: [],
};
const p4 = instance(defTable, 'spec');
p4.applyView(specView);
ok(p4.data.myDice.length === 0, '观战没有「我的骰子」');
ok(p4.data.oppDice.length === 5, '观战也只看到背面');
ok(p4.data.myTurn === false, '观战没有行动权');
ok(p4.data.bidText === '还没人喊价', '观战文案');

/* ---------- 6. 开盅亮牌：按昵称对齐座位 ---------- */
const p5 = instance(defTable, 'A');
p5.data.room = { seats: { A: { nick: '阿甲', kind: 'me' }, B: { nick: '阿乙', kind: 'me' } } };
p5.data.meName = '阿甲';
p5.data.oppName = '阿乙';
p5.data.hpMax = 8;
p5.onOpen({
  seat: 'A', who: 'B', loser: 'A', truth: false, slash: false,
  bid: { count: 4, face: 5, zhai: false },
  reveal: { A: '阿甲', B: '阿乙', dice: { A: [1, 1, 1, 2, 3], B: [5, 5, 5, 5, 6] }, actual: 4 },
  hp: { A: 7, B: 8 },
});
ok(p5.data.oppRevealed === true, '开盅后对手亮牌');
ok(p5.data.oppDice.map(d => d.face).join(',') === '5,5,5,5,6', '亮的是对手那一组骰子', p5.data.oppDice.map(d => d.face));
ok(p5.data.hpMe === 7, '开盅后血量即时更新', p5.data.hpMe);

// 复式换座：我坐 B，reveal 的键还是甲/乙，不能拿错
const p6 = instance(defTable, 'B');
p6.data.room = { seats: { A: { nick: '阿甲', kind: 'me' }, B: { nick: '阿乙', kind: 'me' } } };
p6.data.meName = '阿乙';
p6.data.oppName = '阿甲';
p6.data.hpMax = 8;
p6.onOpen({
  seat: 'B', who: 'A', loser: 'B', truth: true, slash: false,
  bid: { count: 3, face: 2, zhai: false },
  reveal: { A: '阿甲', B: '阿乙', dice: { A: [2, 2, 2, 4, 5], B: [6, 6, 1, 1, 3] }, actual: 3 },
  hp: { A: 8, B: 6 },
});
ok(p6.data.oppDice.map(d => d.face).join(',') === '2,2,2,4,5', '换座后亮的是甲（对手）的牌', p6.data.oppDice.map(d => d.face));
ok(p6.data.hpMe === 6 && p6.data.hpOpp === 8, '换座后血量归属正确', { me: p6.data.hpMe, opp: p6.data.hpOpp });

/* ---------- 7. 整桌结算 ---------- */
const p7 = instance(defTable, 'A');
p7.data.room = { seats: { A: { nick: '阿甲' }, B: { nick: '阿乙' } } };
p7.onMatchOver({
  net: { A: 3, B: -3 }, winner: 'A', winnerNick: '阿甲', draw: false, duplicate: true,
  games: [{}, {}], usedTokens: 12345,
});
ok(p7.data.over === true, '结算浮层弹出');
ok(p7.data.overTitle.includes('阿甲'), '标题写赢家', p7.data.overTitle);
ok(p7.data.overLines.some(l => l.includes('（你）')), '标出「你」', p7.data.overLines);
ok(p7.data.overLines.some(l => l.includes('+3')), '净胜血带正号', p7.data.overLines);

/* ---------- 8. 新一轮要盖回牌 ---------- */
const p8 = instance(defTable, 'A');
p8.applyView(Object.assign({}, firstView, { roundNo: 1 }));
p8.revealDice = { A: [1, 2, 3, 4, 5], B: [6, 6, 6, 6, 6] };
p8.applyView(Object.assign({}, firstView, { roundNo: 2, dice: [2, 2, 3, 3, 4] }));
ok(p8.data.oppRevealed === false, '新一轮对手重新盖牌');
ok(p8.data.oppDice.every(d => d.cells.every(x => !x)), '新一轮背面无点数');

console.log('\n' + (fail ? 'FAIL' : 'ALL PASS') + '  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
