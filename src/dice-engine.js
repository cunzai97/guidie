/* 大话骰规则引擎（无 UI、无网络），浏览器与 Node 都能用
 * 规则不再写死：newMatch({rules}) 注入一份规则集（dice-rulesets.js），
 * legalActions / normalizeAction / countFace / resolveOpen 全按这份配置工作。
 * 不传 rules 时等价于经典套，旧代码与历史 run 逐字不变。
 * 2026-11-10 起计分改为血量制：开局各 hpMax 点血，输家掉血、归零者输掉整局（见 settle）。
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
    const C5 = [1, 5, 10, 10, 5, 1];
    let s = 0, c = C5[need];                     // 二项分布 C(5,k) p^k (1-p)^(5-k)
    for (let k = need; k <= 5; k++) {            // c 必须从 C(5,need) 起步：旧版从 1 起步，
      if (k > need) c = c * (6 - k) / k;         // 整条尾概率被除以 C(5,need)，系统性低估（阈值 bot 因此异常激进）
      s += c * Math.pow(p, k) * Math.pow(1 - p, 5 - k);
    }
    return Math.min(1, Math.max(0, s));
  }

  function newMatch(cfg) {
    cfg = cfg || {};
    // 血量制：开局双方各 hpMax 点血（上限也是 hpMax），每轮结算扣血，先归零的一方输掉整局。
    // 旧参数名 roundTarget 仍接受（同一含义：这一局的初始血量）。
    const hpMax = Math.round(+((cfg.hpMax != null ? cfg.hpMax : cfg.roundTarget) || 10));
    return {
      hpMax,                                      // 血量上限=开局血量
      hp: { A: hpMax, B: hpMax },                 // 当前血量：开盅输家 −stake（劈/零和套赢家也 +stake，回满为止）
      losses: { A: 0, B: 0 },                      // 兼容字段：各人输掉的轮数（观赏页进度用，非判负依据）
      rules: RS.normalize(cfg.rules || 'classic'),
      roundNo: 0, history: [], round: null,
      firstBidder: cfg.firstBidder || 'A', lastLoser: null, over: false, winner: null,
    };
  }

  /* 血量结算（唯一入口，runner / arena / 引擎共用）：
   *  - 输家固定 −stake 点血（开盅与劈都一样，输家总要掉血）；
   *  - 零和结算（劈、以及规则集里 openLoserLoses=true 的开盅）赢家 +stake 点血，回满为止；
   *  - 血量归零的那一方输掉整局。
   */
  function settle(m, win, loser, stake, loserPays) {
    const k = stake || 1;
    if (loserPays) m.hp[win] = Math.min(m.hpMax, m.hp[win] + k);
    m.hp[loser] = Math.max(0, m.hp[loser] - k);
    if (m.hp[loser] <= 0) { m.over = true; m.winner = win; }
  }

  function startRound(m, rng) {
    if (m.over) return m.round;
    m.roundNo++;
    const first = m.roundNo === 1 ? m.firstBidder : (m.lastLoser || m.firstBidder);
    m.round = {
      no: m.roundNo, dice: { A: rollDice(rng), B: rollDice(rng) },
      turn: first, bid: null, seq: [], over: false, result: null, revealed: false,
      rules: m.rules, zhai: false,
    };
    return m.round;
  }

  const other = w => (w === 'A' ? 'B' : 'A');

  /* 本轮是否已经喊过同一手。判重的键是「个数 + 点数 + 斋状态」三样：
   * 未斋的「3 个 6」和斋里的「3 个 6」是两个不同的承诺（后者只数真实 6），不算重复；
   * 而「个数、点数、斋」全同的一手重喊一遍，就是把同一个承诺说了两遍——
   * 转斋取半会把个数砍回去，正是靠这条挡住「价格绕回老位置」。
   */
  function repeatedBid(round, count, face, zhai) {
    for (const s of (round && round.seq) || []) {
      if (s.kind !== 'bid' || s.count !== count || s.face !== face) continue;
      if (zhai == null || !!s.zhai === !!zhai) return true;
    }
    return false;
  }

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
  // 破斋门槛：当前个数的 breakMultiplier 倍再加 breakPlus（新规是「两倍 + 1」）。
  // 2n+1 天生大于转斋前的个数（ceil(n/2)*2+1 > n），所以不再需要「必须超过斋前那一手」这条，
  // 也就不需要在轮内记 preZhai——一条规则同时挡住压价循环。
  function breakMinCount(round) {
    const b = round.bid, R = rulesOf(round), k = R.breakMultiplier;
    if (!b || !k) return null;
    return b.count * k + (R.breakPlus || 0);
  }
  // 破斋的唯一条件：个数 ≥ 当前个数 × k + plus（新规 = 2n+1），点数任选。
  // 写不写「破斋」决定它「算不算」破斋（不写就只是斋里的普通抬价）。
  function canBreak(round, count, face) {
    const R = rulesOf(round);
    if (!R.breakMultiplier || !round.zhai || !round.bid) return false;
    const min = breakMinCount(round);
    if (min == null || count < min || count > R.maxCount) return false;
    return face == null || face !== 1;      // 破斋不能喊 1：喊 1 立刻又是斋
  }
  // 某个个数下允许写「破斋」的点数；count 省略时按最低的翻倍个数算。
  // 返回 null=本桌此刻谈不上破斋；[]=这个个数破不了斋；否则为合法点数列表。
  function breakFaces(round, count) {
    const R = rulesOf(round);
    if (!R.breakMultiplier || !round.zhai || !round.bid) return null;
    const min = breakMinCount(round);
    if (min == null) return null;
    const c = count == null ? min : count;
    // 破斋是「1 恢复万能」，所以点数只能 2~6：喊 1 会立刻又进斋（喊 1 就是斋）。
    return (c < min || c > R.maxCount) ? [] : FACES.filter(f => f !== 1);
  }
  // 兼容旧名字：「个数至少到这个值才能破斋」（旧语义里它也是唯一的可用个数）。
  function breakCount(round) {
    const n = breakMinCount(round);
    return n != null && n <= rulesOf(round).maxCount ? n : null;
  }

  function normalizeAction(round, a) {
    const R = rulesOf(round);
    if (!a || a.type === 'open') return { type: 'open', slash: !!(a && a.slash) };
    const o = { type: 'bid', count: +a.count, face: +a.face, mode: a.mode || null };
    // 已经在斋里又写「斋 / 转斋」：这是幂等标记，按留在斋里的普通抬价处理，不逼模型重写。
    if (o.mode === 'toZhai' && R.zhaiMode === 'half' && round.zhai) return Object.assign(o, { mode: 'normal' });
    if (o.mode === 'toZhai' || o.mode === 'breakZhai') return o;
    // 只对「完全没写标记」的动作按个数推断；legalActions 生成的 mode:'normal' 是显式的
    // 「不切换状态」，不能被个数悄悄改掉，否则权威集合里会凭空多出一个不存在的键。
    // 2026-11-10 起：转斋仍可按取半个数推断，破斋则必须显式写「破斋」——
    // 个数到了翻倍却没写标记，就是留在斋里的普通抬价（例如「2 个 4 斋」后喊「4 个 4」仍是斋）。
    if (R.autoInfer && R.zhaiMode === 'half' && round.bid && o.mode == null) {
      const zc = zhaiCount(round);
      if (!round.zhai && zc != null && zc >= R.minCount && o.count === zc) return Object.assign(o, { mode: 'toZhai' });
    }
    return Object.assign(o, { mode: 'normal' });
  }

  // 状态推进：这一手之后本轮是否处于斋。
  // 关键一条：喊点数 1 就是斋——两套规则都一样，不靠「斋」这个字。
  // 破斋是「回到 1 万能」，所以破斋这一手不能喊 1（喊 1 又立刻进斋，自相矛盾）。
  function zhaiAfter(round, a) {
    const R = rulesOf(round);
    if (a.type !== 'bid') return !!round.zhai;
    if (R.zhaiMode === 'face1') return a.face === 1;
    if (a.mode === 'breakZhai') return a.face === 1 ? true : false;
    if (a.mode === 'toZhai') return true;
    return a.face === 1 ? true : !!round.zhai;
  }

  function actionKey(a) {
    if (!a || a.type === 'open') return a && a.slash ? 'open:slash' : 'open';
    return 'bid:' + a.count + ':' + a.face + ':' + (a.mode || 'normal');
  }

  // 权威合法动作集合。经典套复刻旧 legalCounts×legalFaces；新套额外给出转斋/破斋/劈。
  function legalActions(round) {
    const R = rulesOf(round), out = [], seen = new Set();
    const add = a => {
      if (a.type === 'bid' && repeatedBid(round, a.count, a.face, zhaiAfter(round, a))) return;   // 同一手不再给
      const k = actionKey(a); if (!seen.has(k)) { seen.add(k); out.push(a); }
    };
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
    const zc = zhaiCount(round), bMin = round.zhai ? breakMinCount(round) : null;
    for (let c = b.count; c <= R.maxCount; c++) {
      for (const f of FACES) {
        let normalOk = false;
        if (c > b.count && !locked) normalOk = true;
        else if (c > b.count && locked && f === b.face) normalOk = true;
        // 1 在点数顺序里是最大的（2<3<4<5<6<1），个数不变换到 1 是合法抬价；
        // 旧版这里把 1 排除了，导致「3 个 3 → 3 个 1」被判非法、报错文案还自相矛盾。
        else if (c === b.count && !locked && ord(f) > ord(b.face)) normalOk = true;
        // 同样的个数/点数，写不写「破斋」是两种动作：不写就留在斋里（1 仍不万能）。
        if (normalOk) add({ type: 'bid', count: c, face: f, mode: 'normal' });
        if (round.zhai && bMin != null && c >= bMin && canBreak(round, c, f)) {
          add({ type: 'bid', count: c, face: f, mode: 'breakZhai' });
        }
      }
    }
    if (!round.zhai && zc != null && zc >= R.minCount) {
      const zf = R.faceFree ? FACES : [1];
      for (const f of zf) add({ type: 'bid', count: zc, face: f, mode: 'toZhai' });
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
    m.losses[loser]++;
    m.lastLoser = loser;
    m.history.push({ no: round.no, ...round.result });
    settle(m, win, loser, stake, loserPays);
    return round.result;
  }

  // 本局比分 / 局史 / 当前最高价，供 prompt 与界面用
  // 注意：这里用固定座位标签甲=A/乙=B（上帝视角）；给模型看的文本一律由 context.js
  // 按"你/对手"第一人称重新渲染，绝不要把这条喂给模型。
  function roundLine(h) {
    const seat = w => (w === 'A' ? '甲' : '乙');
    const seqTxt = seat(h.bid.by) + '喊' + h.bid.count + '个' + h.bid.face + (h.bid.zhai ? '(斋)' : '');
    const s = h.slash ? '劈' : '开盅', k = h.stake || 1;
    const pad = h.loserPays === false ? ' / ' + seat(h.loser) + ' −' + k + '血' : ' / ' + seat(h.winner) + ' +' + k + '血 · ' + seat(h.loser) + ' −' + k + '血';
    return '第' + h.no + '轮：' + seqTxt + '，' + seat(h.opener) + s + pad;
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

  return { FACES, FACE_ORDER, ord, repeatedBid, rollDice, countFace, countOf, probBidTrue, newMatch, settle, startRound,
           other, legalCounts, legalFaces, legalActions, legalActionSet, normalizeAction, actionKey,
           zhaiCount, breakCount, breakMinCount, canBreak, breakFaces, zhaiAfter, canBid, applyBid, resolveOpen, roundLine, mulberry32,
           rulesOf, RS };
});
