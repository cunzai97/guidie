/* 人类座位：实现 runner 的 player 接口（decide / reset? / summarize?），但决断来自网络提交。
 * decide() 推一份该座位的视角（view.js 投影，不含对方骰子）→ 等客户端提交 → 按引擎校验合法性 →
 * 超时按房间设定自动接手（最小合法加价 / 无价可喊则开盅）或判负；认输直接判负。
 *
 * 合法性只认引擎的 legalActionSet + normalizeAction：客户端传来的 {count,face,mode} 先过 normalize
 * （和模型走的是同一条推断口径：漏写「斋 / 破斋」按规则自动推断），再查合法集合。服务端不猜玩家意图。
 */
'use strict';
const E = require('./dice-engine.js');
const V = require('./view.js');

const AUTO_BID = 'auto';     // 超时：自动走最小的合法加价（无价可喊则开盅）
const AUTO_FORFEIT = 'forfeit';  // 超时：直接判负（与无头评测 strict 口径一致）

function autoAction(round, mode) {
  if (mode === AUTO_FORFEIT) return { type: 'forfeit' };
  const acts = E.legalActions(round);
  const bids = acts.filter(a => a.type === 'bid')
    .sort((x, y) => x.count - y.count || E.ord(x.face) - E.ord(y.face));
  if (bids.length) return bids[0];
  return acts.some(a => a.type === 'open') ? { type: 'open', slash: false } : { type: 'forfeit' };
}

function makeHumanPlayer(cfg = {}) {
  const nick = String(cfg.nick || '玩家').slice(0, 24);
  const timeoutMs = Math.max(800, +cfg.timeoutMs || 45000);   // 下限只为准时释放，真实桌规由服务端 turnMs 限制（≥5s）
  const onTimeout = cfg.onTimeout === AUTO_FORFEIT ? AUTO_FORFEIT : AUTO_BID;
  const io = cfg.io || {};
  const ask = io.ask || (() => {});
  const notice = io.notice || (() => {});

  let pending = null;      // { round, who, deadline, resolve }
  let submitted = 0;

  function settleWith(p, action) {
    pending = null;
    p.resolve(action);
  }

  /* 客户端提交行动。返回 {ok} 或 {ok:false, reason}；非法直接拒，不替玩家改一手。 */
  function submit(action) {
    if (!pending) return { ok: false, reason: '现在不归你走，或这一手已经结束' };
    if (!action || typeof action !== 'object') return { ok: false, reason: '行动格式不对' };
    const p = pending;
    let a;
    if (action.type === 'open') a = { type: 'open', slash: !!action.slash };
    else if (action.type === 'bid') {
      const count = Math.round(+action.count), face = Math.round(+action.face);
      if (!Number.isFinite(count) || !Number.isFinite(face)) return { ok: false, reason: '个数与点数必须是数字' };
      if (count < 1 || count > 12 || face < 1 || face > 6) return { ok: false, reason: '个数或点数超出范围' };
      a = { type: 'bid', count, face, mode: action.mode || null };
    } else return { ok: false, reason: '只接受「喊价」「开盅 / 劈」两类行动' };

    const norm = a.type === 'bid' ? E.normalizeAction(p.round, a) : a;
    if (!E.legalActionSet(p.round).has(E.actionKey(norm))) {
      const want = V.legalList(p.round).map(x => x.label);
      return { ok: false, reason: '这一步当前不合法。可走：' + (want.length > 12 ? want.slice(0, 12).join('、') + '…' : want.join('、')) };
    }
    submitted++;
    settleWith(p, norm);
    return { ok: true, action: norm };
  }

  async function decide(m, who, memos, meta) {
    const round = m.round;
    return new Promise(resolve => {
      const p = { round, who, resolve };
      pending = p;
      const askedAt = Date.now();
      p.deadline = askedAt + timeoutMs;
      const timer = setTimeout(() => {
        if (pending !== p) return;
        const act = autoAction(round, onTimeout);
        notice(who, { kind: 'timeout', seat: who, took: Date.now() - askedAt, action: act });
        settleWith(p, act);
      }, timeoutMs);
      // 这个定时器绝不能 unref：对局正挂在这一手上，unref 会让「等玩家超时」的进程静默退出
      // （实测：无头跑批里人类座位超时等待时，Node 因为只剩 unref 句柄而直接结束，对局无声消失）。
      // 提交与超时都走 settleWith，pending !== p 守卫保证不会重复结算。
      ask(who, V.viewFor(m, who), { timeoutMs, askedAt, deadline: p.deadline, nick, roundNo: m.roundNo, turnText: null });
    });
  }

  function waiting() { return !!pending; }
  function waitingSeat() { return pending ? pending.who : null; }
  // 断线 / 关房：不再让对局卡在一个不在的人身上
  function giveUp(reason) {
    if (!pending) return false;
    const p = pending;
    notice(p.who, { kind: 'abandon', seat: p.who, reason: reason || 'offline' });
    settleWith(p, autoAction(p.round, onTimeout));
    return true;
  }
  function resign() {
    if (!pending) return false;
    const p = pending;
    settleWith(p, { type: 'forfeit' });
    return true;
  }

  return {
    name: nick, isHuman: true, nick, timeoutMs, onTimeout,
    decide, submit, waiting, waitingSeat, giveUp, resign,
    steps: () => submitted,
  };
}

module.exports = { makeHumanPlayer, autoAction, AUTO_BID, AUTO_FORFEIT };
