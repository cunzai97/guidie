/* 座位视角投影（实时对战平台）
 * 服务端权威的 match 里含双方骰子，绝不能整份下发给客户端：这里只投影「该座位允许看到的」信息。
 * 文本视图仍由 context.js 的 buildTurn 负责（第一人称、只给自己骰子），本模块只补一份结构化 JSON 给 UI。
 * 同一条真值的「模型看到的文本」和「人看到的界面」都出自同一份引擎状态，不做第二套描述。
 */
'use strict';
const E = require('./dice-engine.js');

function countsOf(dice) {
  const o = {};
  for (let f = 1; f <= 6; f++) o[f] = 0;
  for (const d of (dice || [])) if (o[d] != null) o[d]++;
  return o;
}

// 动作的人类可读名（与 arena.js 的 actText 同口径，UI 直接用它渲染按钮）
function actLabel(a) {
  if (!a) return '';
  if (a.type === 'open') return a.slash ? '劈' : '开盅';
  const tail = a.mode === 'toZhai' ? ' 斋' : a.mode === 'breakZhai' ? ' 破斋' : '';
  return '喊 ' + a.count + ' 个 ' + a.face + tail;
}

function legalList(round) {
  return E.legalActions(round).map(a => Object.assign({}, a, { label: actLabel(a) }));
}

// 结算后的真值：runner / 引擎只在轮末把这些写进 history，所以「什么时候能看到」由 history 决定，
// 不由客户端决定。未结算的本轮骰子绝不从这里泄漏。
function historyView(h, who) {
  const o = who ? (x => (x === who ? 'me' : 'opp')) : (x => x);
  const out = {
    no: h.no,
    forfeit: !!h.forfeit,
    slash: !!h.slash,
    stake: h.stake || 1,
    loserPays: h.loserPays,
    zhai: !!h.zhai,
    actual: h.actual,
    truth: h.truth,
    loser: h.loser ? o(h.loser) : null,
    winner: h.winner ? o(h.winner) : null,
    opener: h.opener ? o(h.opener) : null,
  };
  if (h.bid) out.bid = { by: o(h.bid.by), count: h.bid.count, face: h.bid.face, zhai: !!h.bid.zhai, mode: h.bid.mode || null };
  if (h.dice) {
    out.dice = who ? { me: h.dice[who], opp: h.dice[E.other(who)] } : { A: h.dice.A, B: h.dice.B };
    out.all = h.all;
  }
  return out;
}

/* 该座位的完整视图。who = 'A' | 'B'。 */
function viewFor(m, who) {
  const r = m.round, opp = E.other(who);
  const me = x => (x === who ? 'me' : 'opp');
  return {
    seat: who,
    roundNo: m.roundNo,
    over: !!m.over,
    winner: m.winner ? me(m.winner) : null,
    capped: !!m.capped,
    hpMax: m.hpMax,
    hp: { me: m.hp[who], opp: m.hp[opp] },
    losses: { me: m.losses[who], opp: m.losses[opp] },
    firstBidder: m.firstBidder === who ? 'me' : 'opp',
    lastLoser: m.lastLoser ? me(m.lastLoser) : null,
    dice: r.dice[who],
    counts: countsOf(r.dice[who]),
    zhai: !!r.zhai,
    turn: r.turn === who ? 'me' : 'opp',
    bid: r.bid ? { by: me(r.bid.by), count: r.bid.count, face: r.bid.face, zhai: !!r.bid.zhai, mode: r.bid.mode || null, at: r.bid.at } : null,
    seq: (r.seq || []).filter(s => s.kind === 'bid')
      .map(s => ({ at: s.at, by: me(s.who), count: s.count, face: s.face, zhai: !!s.zhai, mode: s.mode || null })),
    legal: legalList(r),
    canOpen: !!r.bid,
    history: (m.history || []).map(h => historyView(h, who)),
  };
}

/* 观战视图：绝不包含本轮骰子（结算后才从 history 带出真值）。
   也绝不包含任何座位的私有视角，因此可以直接广播给任意观众。 */
function publicView(m) {
  const r = m.round;
  return {
    roundNo: m.roundNo,
    over: !!m.over,
    winner: m.winner || null,
    capped: !!m.capped,
    hpMax: m.hpMax,
    hp: { A: m.hp.A, B: m.hp.B },
    losses: { A: m.losses.A, B: m.losses.B },
    firstBidder: m.firstBidder,
    lastLoser: m.lastLoser || null,
    zhai: !!r.zhai,
    turn: r.turn,
    bid: r.bid ? { by: r.bid.by, count: r.bid.count, face: r.bid.face, zhai: !!r.bid.zhai, mode: r.bid.mode || null, at: r.bid.at } : null,
    seq: (r.seq || []).filter(s => s.kind === 'bid')
      .map(s => ({ at: s.at, by: s.who, count: s.count, face: s.face, zhai: !!s.zhai, mode: s.mode || null })),
    history: (m.history || []).map(h => historyView(h, null)),
  };
}

// runner 的 ev 里带 truth（这一手是真是假）。广播前必须剥掉：当场公布等于替对手读出牌面。
const PRIVATE_FIELDS = ['truth', 'asks'];
function sanitizeEvent(ev) {
  const out = {};
  for (const k of Object.keys(ev)) {
    if (PRIVATE_FIELDS.includes(k)) continue;
    if (k === 'bid' && ev.bid) { out.bid = { by: ev.bid.by, count: ev.bid.count, face: ev.bid.face, zhai: !!ev.bid.zhai, mode: ev.bid.mode || null }; continue; }
    if (k === 'attempts') continue;   // 模型逐次尝试明细（含思考长度），不下发
    out[k] = ev[k];
  }
  return out;
}

module.exports = { viewFor, publicView, historyView, legalList, actLabel, countsOf, sanitizeEvent, PRIVATE_FIELDS };
