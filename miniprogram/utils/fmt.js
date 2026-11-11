/* 展示层小工具：骰面点阵、动作中文名、座位显示名。
 * 与 web/play.js 的 PIPS / actText 同口径 —— 两个端看起来是同一副骰子、同一句话。
 */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

function cellsOf(face) {
  const on = PIPS[face] || [];
  const out = [];
  for (let i = 0; i < 9; i++) out.push(on.indexOf(i) >= 0);
  return out;
}

// zhai 时 1 不再是万能，界面要能看出这个差别
function diceView(list, zhai) {
  return (list || []).map(f => ({ face: f, cells: cellsOf(f), wild: f === 1 && !zhai }));
}

function backView(n) {
  const out = [];
  for (let i = 0; i < (n || 5); i++) out.push({ cells: cellsOf(0) });
  return out;
}

function actText(a) {
  if (!a) return '';
  if (a.type === 'open') return a.slash ? '劈' : '开盅';
  const tail = a.mode === 'toZhai' ? ' 斋' : a.mode === 'breakZhai' ? ' 破斋' : '';
  return '喊 ' + a.count + ' 个 ' + a.face + tail;
}

const MODE_LABEL = { normal: '普通抬价', toZhai: '转斋', breakZhai: '破斋' };

function modeLabel(m) { return MODE_LABEL[m] || m || '普通抬价'; }

// 座位在「我 / 对手」里的另一侧
function other(p) { return p === 'B' ? 'A' : 'B'; }

function seatNick(room, p, fallback) {
  const s = room && room.seats && room.seats[p];
  if (!s) return fallback || p;
  if (s.nick) return s.nick;
  return s.kind === 'open' ? '空位' : (fallback || p);
}

function seatMeta(s) {
  if (!s) return '';
  if (s.kind === 'open') return '等邀请';
  if (s.kind === 'me') return '真人手打';
  if (s.kind === 'bot') return '内置人机 · ' + (s.bot || '');
  const bits = [];
  if (s.model) bits.push(s.model);
  if (s.effort) bits.push('思考 ' + s.effort);
  return bits.join(' · ') || '模型';
}

function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function pct(v, max) {
  if (!max) return 0;
  return Math.max(0, Math.min(100, Math.round(v / max * 100)));
}

module.exports = { PIPS, cellsOf, diceView, backView, actText, modeLabel, MODE_LABEL, other, seatNick, seatMeta, hhmm, pct };
