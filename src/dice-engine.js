/* 大话骰规则引擎（无 UI、无网络），浏览器与 Node 都能用
 * 规则不再写死：newMatch({rules}) 注入一份规则集（dice-rulesets.js），
 * legalActions / normalizeAction / countFace / resolveOpen 全按这份配置工作。
 * 不传 rules 时等价于经典套，旧代码与历史 run 逐字不变。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./dice-rulesets.js'));
  else root.DiceEngine = factory(root.DiceRulesets);
})(typeof self !== 'undefined' ? self : globalThis, function (RS) {
  'use strict';
  const FACES = [1, 2, 3, 4, 5, 6];
  const FACE_ORDER = [2, 3, 4, 5, 6, 1];       // 点数大小：2<3<4<5<6<1
  const ord = f => (f === 1 ? 7 : f);
  const CLASSIC = RS.normalize('classic');
  const rulesOf = r => (r && r.rules) || CLASSIC;

  function rollDice(rng, n) {
    const r = [], R = rng || Math.random;
    for (let i = 0; i < (n || 5); i++) r.push(1 + Math.floor(R() * 6));
    return r.sort((a, b) => a - b);
  }

  // 统计 face 的个数。zhai=true（或 face===1）时 1 不再当万能，只数真实点数。
  // 第三参数省略时完全等价于旧实现，保证经典链路不变。
  function countFace(all, face, zhai) {
    const noWild = !!zhai || face === 1;
    let c = 0;
    for (const d of all) { if (d === face) c++; else if (!noWild && d === 1) c++; }
    return c;
  }
  function countOf(dice, face, zhai) { return countFace(dice, face, zhai); }

  // 开盅方视角：对手 5 颗里能凑够所需个数的概率（斋时每颗只有 1/6）
  function probBidTrue(bid, ownDice) {
    const p = (bid.zhai || bid.face === 1) ? 1 / 6 : 2 / 6;
    const need = bid.count - countFace(ownDice, bid.face, bid.zhai);
    if (need <= 0) return 1;
    if (need > 5) return 0;
    let s = 0, c = 1;                              // 二项分布 C(5,k) p^k (1-p)^(5-k)
    for (let k = need; k <= 5; k++) {
      if (k > need) c = c * (6 - k) / k;
      s += c * Math.pow(p, k) * Math.pow(1 - p, 5 - k);
    }
    return Math.min(1, Math.max(0, s));
  }

  function newMatch(cfg) {
    cfg = cfg || {};
    return {
      roundTarget: cfg.roundTarget || 3,           // 积分制：先到 +N 分者赢整场
      points: { A: 0, B: 0 },                      // 开盅赢家 +stake（输家是否扣分看规则）；劈双向
      losses: { A: 0, B: 0 },                      // 兼容字段：各人输掉的轮数（观赏页进度用，非判负依据）
      rules: RS.normalize(cfg.rules || 'classic'),
      roundNo: 0, history: [], round: null,
      firstBidder: cfg.firstBidder || 'A', lastLoser: null, over: false, winner: null,
    };
  }

  function startRound(m, rng) {
    if (m.over) return m.round;
    m.roundNo++;
    const first = m.roundNo === 1 ? m.firstBidder : (m.lastLoser || m.firstBidder);
    m.round = {
      no: m.roundNo, dice: { A: rollDice(rng), B: rollDice(rng) },
      turn: first, bid: null, seq: [], over: false, result: null, revealed: false,
      rules: m.rules, zhai: false, preZhai: null,   // preZhai=斋前最高价；破斋必须严格大于它，防压价死循环
    };
    return m.round;
  }

  const other = w => (w === 'A' ? 'B' : 'A');

  /* ---------- 动作模型 ----------
   * bid: {type:'bid', count, face, mode}
   *   mode: 'normal' | 'toZhai'（转斋） | 'breakZhai'（破斋） | undefined（交给局面自动推断）
   * open: {type:'open', slash:true|false}   slash=true 即「劈」
   * normalizeAction 是唯一的判定入口：显式标记优先，autoInfer 时按个数补推断。
   */
  function zhaiCount(round) {
    const b = round.bid;
    if (!b) return null;
    return Math.ceil(b.count / rulesOf(round).halfDivisor);
  }
  function breakCount(round) {
    const b = round.bid, k = rulesOf(round).breakMultiplier;
    if (!b || !k) return null;
    const n = b.count * k;
    return n <= rulesOf(round).maxCount ? n : null;
  }
  // 破斋可用的点数：翻倍只是必要条件，还必须严格大于斋前一手（转斋前的最高价），
  // 否则「转斋→破斋」能把价越喊越低、无限循环。首喊直接斋没有斋前一手，翻倍即可。
  // 返回 null=本桌此刻谈不上破斋；[]=翻倍值存在但没有合法点数；否则为合法点数列表。
  function breakFaces(round) {
    const R = rulesOf(round);
    if (!round.zhai || !round.bid || !R.breakMultiplier) return null;
    const bc = breakCount(round);
    if (bc == null) return null;
    const pre = round.preZhai;
    if (R.breakMustExceed && pre) {
      if (bc < pre.count) return [];
      if (bc === pre.count) return FACES.filter(f => ord(f) > ord(pre.face));
    }
    return FACES.slice();
  }

  function normalizeAction(round, a) {
    const R = rulesOf(round);
    if (!a || a.type === 'open') return { type: 'open', slash: !!(a && a.slash) };
    const o = { type: 'bid', count: +a.count, face: +a.face, mode: a.mode || null };
    // 已经在斋里又写「斋 / 转斋」：这是幂等标记，按留在斋里的普通抬价处理，不逼模型重写。
    if (o.mode === 'toZhai' && R.zhaiMode === 'half' && round.zhai) return Object.assign(o, { mode: 'normal' });
    if (o.mode === 'toZhai' || o.mode === 'breakZhai') return o;
    // 只对「完全没写标记」的动作按个数推断；legalActions 生成的 mode:'normal' 是显式的
    // 「不切换状态」，不能被个数悄悄改成破斋，否则权威集合里会凭空多出一个不存在的键。
    if (R.autoInfer && R.zhaiMode === 'half' && round.bid && o.mode == null) {
      const zc = zhaiCount(round), bc = breakCount(round);
      if (!round.zhai && zc != null && o.count === zc) return Object.assign(o, { mode: 'toZhai' });
      if (round.zhai && bc != null && o.count === bc) return Object.assign(o, { mode: 'breakZhai' });
    }
    return Object.assign(o, { mode: 'normal' });
  }

  // 状态推进：这一手之后本轮是否处于斋。
  function zhaiAfter(round, a) {
    const R = rulesOf(round);
    if (R.zhaiMode === 'face1') return a.type === 'bid' && a.face === 1;
    if (a.type !== 'bid') return !!round.zhai;
    if (a.mode === 'toZhai') return true;
    if (a.mode === 'breakZhai') return false;
    return !!round.zhai;
  }

  function actionKey(a) {
    if (!a || a.type === 'open') return a && a.slash ? 'open:slash' : 'open';
    return 'bid:' + a.count + ':' + a.face + ':' + (a.mode || 'normal');
  }

  // 权威合法动作集合。经典套复刻旧 legalCounts×legalFaces；新套额外给出转斋/破斋/劈。
  function legalActions(round) {
    const R = rulesOf(round), out = [], seen = new Set();
    const add = a => { const k = actionKey(a); if (!seen.has(k)) { seen.add(k); out.push(a); } };
    const b = round.bid;
    if (R.zhaiMode === 'face1') {
      if (!b) {
        for (let c = R.firstMin; c <= R.firstMax; c++) for (let f = 2; f <= 6; f++) add({ type: 'bid', count: c, face: f, mode: 'normal' });
      } else if (b.face === 1) {
        for (let c = b.count + 1; c <= R.maxCount; c++) add({ type: 'bid', count: c, face: 1, mode: 'normal' });
      } else {
        for (let c = b.count; c <= R.maxCount; c++) {
          for (let f = 1; f <= 6; f++) {
            if (c > b.count || ord(f) > ord(b.face)) add({ type: 'bid', count: c, face: f, mode: 'normal' });
          }
        }
      }
      if (b) add({ type: 'open', slash: false });
      return out;
    }

    // 新套 / 自定义套
    const faces = R.firstFace1 ? FACES : [2, 3, 4, 5, 6];
    if (!b) {
      for (let c = R.firstMin; c <= R.firstMax; c++) for (const f of faces) add({ type: 'bid', count: c, face: f, mode: 'normal' });
      // 「首喊也可以直接喊斋」：没有上一手，就不取半，按普通首喊的个数/点数范围另给一组带斋标记的动作。
      // 必须显式写「斋」才成立（normalizeAction 只在有 round.bid 时才按个数自动推断），避免误伤普通首喊。
      if (R.firstZhai) {
        for (let c = R.firstMin; c <= R.firstMax; c++) for (const f of faces) add({ type: 'bid', count: c, face: f, mode: 'toZhai' });
      }
      return out;
    }
    const locked = round.zhai && R.lockFace;
    const zc = zhaiCount(round), bc = breakCount(round);
    for (let c = b.count; c <= R.maxCount; c++) {
      // 斋内「翻倍个数」这一手固定就是破斋，不再同时作为留在斋里的普通抬价存在，
      // 否则同一串文字会被推断成两种状态，规则文本与合法集合互相打架。
      if (round.zhai && bc != null && c === bc) continue;
      for (const f of FACES) {
        if (c > b.count && !locked) add({ type: 'bid', count: c, face: f, mode: 'normal' });
        else if (c > b.count && locked && f === b.face) add({ type: 'bid', count: c, face: f, mode: 'normal' });
        else if (c === b.count && !locked && f !== 1 && ord(f) > ord(b.face)) add({ type: 'bid', count: c, face: f, mode: 'normal' });
      }
    }
    if (!round.zhai && zc != null && zc >= 1) {
      const zf = R.faceFree ? FACES : [1];
      for (const f of zf) add({ type: 'bid', count: zc, face: f, mode: 'toZhai' });
    }
    if (round.zhai && bc != null) {
      for (const f of breakFaces(round)) add({ type: 'bid', count: bc, face: f, mode: 'breakZhai' });
    }
    add({ type: 'open', slash: false });
    if (R.slash) add({ type: 'open', slash: true });
    return out;
  }

  // 兼容视图：旧代码用 legalCounts×legalFaces 枚举；真值仍是 legalActions。
  function legalCounts(round) {
    const R = rulesOf(round);
    if (R.zhaiMode === 'face1') {
      if (!round.bid) return [2, 3, 4, 5, 6];
      const c = round.bid.count, out = [];
      for (let k = c; k <= 10; k++) if (legalFaces(round, k).length) out.push(k);
      return out;
    }
    return [...new Set(legalActions(round).filter(a => a.type === 'bid').map(a => a.count))].sort((x, y) => x - y);
  }
  function legalFaces(round, count) {
    const R = rulesOf(round);
    if (count == null) return [];
    if (R.zhaiMode === 'face1') {
      const b = round.bid;
      if (!b) return count >= 2 ? [2, 3, 4, 5, 6] : [];       // 首喊不能喊 1
      if (count > b.count) return b.face === 1 ? [1] : FACE_ORDER.slice();
      if (count === b.count) return FACE_ORDER.filter(f => ord(f) > ord(b.face));
      return [];
    }
    return [...new Set(legalActions(round).filter(a => a.type === 'bid' && a.count === count).map(a => a.face))]
      .sort((x, y) => ord(x) - ord(y));
  }
  function legalActionSet(round) { return new Set(legalActions(round).map(actionKey)); }
  function canBid(round) { return legalActions(round).some(a => a.type === 'bid'); }

  // 兼容旧签名 applyBid(round, who, count, face)，也接受完整动作对象。
  function applyBid(round, who, countOrAction, face, extra) {
    let a = (countOrAction && typeof countOrAction === 'object')
      ? Object.assign({}, countOrAction) : { type: 'bid', count: countOrAction, face };
    if (extra) a = Object.assign(a, extra);
    a = normalizeAction(round, a);
    if (!legalActionSet(round).has(actionKey(a))) throw new Error('非法喊价 ' + a.count + '个' + a.face + (a.mode !== 'normal' ? '(' + a.mode + ')' : ''));
    const z = zhaiAfter(round, a);
    if (!round.zhai && z) round.preZhai = round.bid || null;   // 进斋：记住斋前最高价（首喊直接斋则为 null）
    if (round.zhai && !z) round.preZhai = null;                // 破斋：约束随之解除
    round.seq.push({ who, kind: 'bid', count: a.count, face: a.face, mode: a.mode, zhai: z, at: round.seq.length + 1 });
    round.bid = { by: who, count: a.count, face: a.face, mode: a.mode, zhai: z, at: round.seq.length };
    round.zhai = z;
    round.turn = other(who);
    return round.bid;
  }

  // 开盅 / 劈：质疑 round.bid。slash=true 时积分按规则集的 slashStake 翻倍。
  // 开盅默认只给赢家加分（openLoserLoses=false）；劈固定双向结算。
  function resolveOpen(m, opener, opts) {
    const round = m.round, b = round.bid, R = rulesOf(round);
    if (!b) throw new Error('没有可开的喊价');
    const slash = !!(opts && opts.slash) && !!R.slash;
    const stake = slash ? R.slashStake : R.stake;
    const loserPays = slash || R.openLoserLoses;
    const all = round.dice.A.concat(round.dice.B);
    const zhai = !!b.zhai;
    const actual = countFace(all, b.face, zhai);
    const wild = (zhai || b.face === 1) ? 0 : all.filter(d => d === 1).length;
    const truth = actual >= b.count;
    const loser = truth ? opener : b.by, win = other(loser);
    round.seq.push({ who: opener, kind: 'open', slash, at: round.seq.length + 1 });
    round.over = true; round.revealed = true;
    round.result = { bid: b, opener, slash, stake, loserPays, zhai, actual, wild, truth,
                     loser, winner: win, dice: round.dice, all };
    m.points[win] += stake;
    if (loserPays) m.points[loser] -= stake;
    m.losses[loser]++;
    m.lastLoser = loser;
    m.history.push({ no: round.no, ...round.result });
    if (m.points[win] >= m.roundTarget) { m.over = true; m.winner = win; }
    return round.result;
  }

  // 本局比分 / 局史 / 当前最高价，供 prompt 与界面用
  // 注意：这里用固定座位标签甲=A/乙=B（上帝视角）；给模型看的文本一律由 context.js
  // 按"你/对手"第一人称重新渲染，绝不要把这条喂给模型。
  function roundLine(h) {
    const seat = w => (w === 'A' ? '甲' : '乙');
    const seqTxt = seat(h.bid.by) + '喊' + h.bid.count + '个' + h.bid.face + (h.bid.zhai ? '(斋)' : '');
    const s = h.slash ? '劈' : '开盅', k = h.stake || 1;
    const pad = h.loserPays === false ? '，输家不扣' : ' / ' + seat(h.loser) + ' −' + k;
    return '第' + h.no + '轮：' + seqTxt + '，' + seat(h.opener) + s + '，' + seat(h.winner) + ' +' + k + pad;
  }

  // 种子化 RNG（mulberry32）：复式赛同一副骰子 deal 可复现、可座位交换
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return { FACES, FACE_ORDER, ord, rollDice, countFace, countOf, probBidTrue, newMatch, startRound,
           other, legalCounts, legalFaces, legalActions, legalActionSet, normalizeAction, actionKey,
           zhaiCount, breakCount, breakFaces, zhaiAfter, canBid, applyBid, resolveOpen, roundLine, mulberry32,
           rulesOf, RS };
});
