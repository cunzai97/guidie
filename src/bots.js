/* 两个基线 bot（只有这两个）：
 *   oracle —— 纯数学地板：精确期望 + 两层 expectimax，确定性，不读喊价。
 *   reader —— 贝叶斯读牌：把对手的喊价当情报，反推手牌分布。
 * 统一接口：decide(match, who) -> {type:'open', slash?} | {type:'bid',count,face,mode?}
 * bot 只看自己的骰子和公开喊价，绝不偷看对手骰子。
 * 合法动作集合直接取引擎的 legalActions（按当前规则集），新套下也可能转斋/破斋/劈。
 *
 * UMD：Node（CLI / 测试）走 require，浏览器（竞技场）挂 window.DiceBots——
 * 同一份实现两边共用，竞技场里选机器人对战时走的就是这里的决策逻辑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dice-engine.js'));
  else root.DiceBots = factory(root.DiceEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {

function legalActions(round) {
  return E.legalActions(round).map(a => {
    if (a.type !== 'bid') return a;
    // 概率估算要知道这一手结算时 1 是否算万能
    const zhai = a.mode === 'toZhai' ? true : a.mode === 'breakZhai' ? false : !!round.zhai;
    return Object.assign({}, a, { zhai: E.rulesOf(round).zhaiMode === 'face1' ? (a.face === 1) : zhai });
  });
}

/* 纯数学 oracle：精确期望 + 两层 expectimax，零训练、零拟合参数、确定性。
 * 比阈值 bot 多算的两步：
 *  ① 价值诈唬：抬到 b 后对手按数学打法（P<0.5 开盅）会以 q(b) 概率开错——
 *     q 用二项分布精确算；b 对我越真、对手越觉得假，抬价越赚。
 *  ② 续值不记 0：枚举对手 252 种手牌型（多项式权重），对手不开时按阈值模型
 *     抬出「对他最真」的反价，再算我方最佳回应值。一步版把这支记 0，过度诈唬被反抬打死。
 * 唯一建模假设：对手按 threshold(0.5)+最真抬价打法；叶子是我方静态最佳回应（深度 2）。
 * 它是「数学对数学」的地板参照，不是 GTO 天花板；对手实际偏离模型时强度打折。
 * flex 的劈：相对分摆动翻倍，P<0.5 开盅必劈、P>0.5 绝不劈。
 */
function binomPMF5(k, p) {
  const C = [1, 5, 10, 10, 5, 1];
  return C[k] * Math.pow(p, k) * Math.pow(1 - p, 5 - k);
}
// P(Binom(5,p) >= need)，与 probBidTrue 同一尾概率
function tail5(need, p) {
  if (need <= 0) return 1;
  if (need > 5) return 0;
  let s = 0;
  for (let k = need; k <= 5; k++) s += binomPMF5(k, p);
  return s;
}
// 对手看到 b 觉得可疑（P<0.5）从而开盅的概率：对手有效点数 k~Binom(5,p)
function qOpen(b) {
  const p = (b.zhai || b.face === 1) ? 1 / 6 : 2 / 6;
  let q = 0;
  for (let k = 0; k <= 5; k++) if (tail5(b.count - k, p) < 0.5) q += binomPMF5(k, p);
  return Math.min(1, Math.max(0, q));
}
// 对手 252 种手牌型（6 面个数和为 5）+ multinomial 权重；n=真实个数，e=含万能 1 的有效个数
const HANDS = (() => {
  const out = [], fact = [1, 1, 2, 6, 24, 120];
  const gen = (face, left, n) => {
    if (face === 6) {
      n.push(left);
      let w = 120;
      for (let f = 1; f <= 6; f++) w /= fact[n[f]];
      const e = [0];
      for (let f = 1; f <= 6; f++) e[f] = n[f] + (f === 1 ? 0 : n[1]);
      out.push({ n: n.slice(), e, w: w / 7776 });
      n.pop();
      return;
    }
    for (let k = 0; k <= left; k++) { n.push(k); gen(face + 1, left - k, n); n.pop(); }
  };
  gen(1, 5, [0]);
  return out;
})();

function oracleBot() {
  return {
    name: 'oracle',
    decide(match, who) {
      const r = match.round, R = E.rulesOf(r);
      const myN = [0, 0, 0, 0, 0, 0, 0], myE = [0, 0, 0, 0, 0, 0, 0];
      for (const d of r.dice[who]) myN[d]++;
      for (let f = 1; f <= 6; f++) myE[f] = myN[f] + (f === 1 ? 0 : myN[1]);
      const isZ = b => !!(b.zhai || b.face === 1);
      const pOf = b => isZ(b) ? 1 / 6 : 2 / 6;
      const pOwn = b => tail5(b.count - (isZ(b) ? myN[b.face] : myE[b.face]), pOf(b));

      const bids = legalActions(r).filter(a => a.type === 'bid');
      const pCur = r.bid ? pOwn(r.bid) : null;
      const evOpen = pCur === null ? null : 1 - 2 * pCur;

      // 假设局面：镜像 applyBid 的 zhai/preZhai 记账，不动真局
      const hypo = (round, b, by) => {
        const z = E.zhaiAfter(round, b);
        let pre = round.preZhai;
        if (!round.zhai && z) pre = round.bid || null;
        if (round.zhai && !z) pre = null;
        return Object.assign({}, round, { bid: Object.assign({}, b, { by, zhai: z }), zhai: z, preZhai: pre });
      };
      // 叶子：面对对手反价 b*（落在 hr1 之后）的我方静态最佳回应值
      const leafCache = new Map();
      const leaf = (hr1, b1, bStar) => {
        const ck = E.actionKey(b1) + '>' + E.actionKey(bStar);
        if (leafCache.has(ck)) return leafCache.get(ck);
        const hr2 = hypo(hr1, bStar, 'X');
        let v = 1 - 2 * pOwn(bStar);
        for (const b2 of legalActions(hr2).filter(a => a.type === 'bid')) {
          const ev = qOpen(b2) * (2 * pOwn(b2) - 1);
          if (ev > v) v = ev;
        }
        leafCache.set(ck, v);
        return v;
      };

      let best = null, bestEV = -Infinity;
      for (const b1 of bids) {
        const hr1 = hypo(r, b1, who);
        const lb1 = legalActions(hr1).filter(a => a.type === 'bid');
        // 同(点数,斋态)组内最小个数支配（同面更高个数 P 严格更低）；组间按阈值 bot 口径取最大 P
        const groups = [], gseen = new Set();
        for (const b of lb1) {
          const gk = b.face + ':' + isZ(b);
          if (!gseen.has(gk)) { gseen.add(gk); groups.push(b); }
        }
        let ev = 0;
        const c1 = b1.count, f1 = b1.face, p1 = pOf(b1), z1 = isZ(b1);
        const myCnt1 = z1 ? myN[f1] : myE[f1];
        if (!groups.length) {
          ev = 2 * pOwn(b1) - 1;                    // 对手无价可抬被迫开盅：payoff=2P−1
        } else {
          for (const h of HANDS) {
            const k1 = z1 ? h.n[f1] : h.e[f1];
            if (tail5(c1 - k1, p1) < 0.5) {
              ev += h.w * ((myCnt1 + k1 >= c1) ? 1 : -1);   // 对手开盅：真值给定手牌是确定的
            } else {
              let bg = null, bp = -1;
              for (const g of groups) {
                const pg = tail5(g.count - (isZ(g) ? h.n[g.face] : h.e[g.face]), pOf(g));
                if (pg > bp + 1e-9) { bp = pg; bg = g; }    // 严格更大才换：等价阈值 bot 的同分取小个数
              }
              ev += h.w * leaf(hr1, b1, bg);
            }
          }
        }
        if (ev > bestEV + 1e-9 || (Math.abs(ev - bestEV) <= 1e-9 && best
            && (b1.count < best.count || (b1.count === best.count && E.ord(b1.face) < E.ord(best.face))))) {
          best = b1; bestEV = ev;
        }
      }
      if (evOpen !== null && evOpen > bestEV + 1e-9) {
        return { type: 'open', slash: !!(R.slash && pCur < 0.5) };
      }
      return best || { type: 'open', slash: false };
    },
  };
}

/* 读牌 reader（v3）：贝叶斯对手建模——喊价即信息。
 * v2 的可剥削点：把对手喊价当无信息随机事件，「P<0.5 必劈」被真货价值喊价双倍收割
 * （2026-11-10 flex 实测 MiniMax 三胜全由此而来）。v3 在 252 种手牌型上维护后验：
 * 每看到对手一手喊价，按生成模型更新权重——
 *   P(对手开盅|h) = logistic(GAMMA·(0.5−P(当前价|h)))   （觉得假才开）
 *   P(对手喊 b|h) = (1−P开)·softmax(BETA·P(b|h))         （更可能喊自己持有的面）
 *   再加 EPS 均匀混合防模型失配。后验每轮从公开 seq 重建（骰子每轮重摇，无跨轮信念）。
 * 开盅/劈 EV 用后验真值概率；抬价 EV 对后验 expectimax，叶子用对手反价再更新一次后验。
 * BETA/GAMMA/EPS 是固定行为假设，零训练、零对局拟合、确定性。
 * 残余假设：叶子层对手开盅不劈；我方 EV 按相对分（ classic 开盅摆动 2、flex 开盅 1、劈 2×slashStake）。
 */
const T5C = new Map();
function t5c(need, p) {
  const k = need + '|' + p;
  let v = T5C.get(k);
  if (v === undefined) { v = tail5(need, p); T5C.set(k, v); }
  return v;
}

function readerHelpers(BETA, GAMMA, EPS) {
  const isZ = b => !!(b.zhai || b.face === 1);
  const pOf = b => isZ(b) ? 1 / 6 : 2 / 6;
  const hCnt = (b, h) => isZ(b) ? h.n[b.face] : h.e[b.face];
  const pHat = (b, h) => t5c(b.count - hCnt(b, h), pOf(b));
  const logistic = x => 1 / (1 + Math.exp(-x));
  const pOpenH = (b, h) => b ? logistic(GAMMA * (0.5 - pHat(b, h))) : 0;
  const hypo = (round, b, by) => {
    const z = E.zhaiAfter(round, b);
    let pre = round.preZhai;
    if (!round.zhai && z) pre = round.bid || null;
    if (round.zhai && !z) pre = null;
    return Object.assign({}, round, { bid: Object.assign({}, b, { by, zhai: z }), zhai: z, preZhai: pre });
  };
  // 同(点数,斋态)组内取最小个数代表：同面更高个数 P 严格更低，任何理性喊价者都先选最小个数。
  // 这是对手模型的支撑集剪枝（策略等价类），把 |合法价| 从 ~54 压到 ≤12，举证成本降两个数量级。
  function repsOf(lb) {
    const seen = new Set(), out = [];
    for (const b of lb) { const k = b.face + ':' + isZ(b); if (!seen.has(k)) { seen.add(k); out.push(b); } }
    return out;
  }
  // 对手在 st 局面下选各动作的概率（含 EPS 均匀混合）；lb 必须是带 zhai 标注的合法喊价
  function policy(st, h, lb) {
    const canOpen = !!st.bid;
    if (!lb.length) return { open: 1, bids: [] };
    const po = canOpen ? pOpenH(st.bid, h) : 0;
    let mx = -1;
    const ps = new Array(lb.length);
    for (let i = 0; i < lb.length; i++) { ps[i] = pHat(lb[i], h); if (ps[i] > mx) mx = ps[i]; }
    let sum = 0;
    for (let i = 0; i < lb.length; i++) { ps[i] = Math.exp(BETA * (ps[i] - mx)); sum += ps[i]; }
    const uni = 1 / (lb.length + (canOpen ? 1 : 0));
    const out = { open: (1 - EPS) * po + (canOpen ? EPS * uni : 0), bids: new Array(lb.length) };
    for (let i = 0; i < lb.length; i++) out.bids[i] = (1 - EPS) * (1 - po) * ps[i] / sum + EPS * uni;
    return out;
  }
  // 从公开喊价序列重建对手手牌后验；每步归一化，塌缩时回落先验
  function belief(r, opp) {
    let w = HANDS.map(h => h.w);
    let st = { rules: r.rules, bid: null, zhai: false, preZhai: null };
    for (const s of r.seq) {
      if (s.kind !== 'bid') break;
      const a = { type: 'bid', count: s.count, face: s.face, mode: s.mode || 'normal' };
      if (s.who === opp) {
        // 信念更新用全量合法价支撑（忠实度优先；单次 ~8 万 exp，可接受）；支撑剪枝只用于期望枚举
        const lb = legalActions(st).filter(x => x.type === 'bid');
        let act = lb.find(x => E.actionKey(x) === E.actionKey(a));
        if (!act) act = Object.assign({}, a, { zhai: E.zhaiAfter(st, a) });
        let idx = lb.findIndex(x => E.actionKey(x) === E.actionKey(act));
        if (idx < 0) { lb.push(act); idx = lb.length - 1; }
        let tot = 0;
        for (let i = 0; i < HANDS.length; i++) {
          const pol = policy(st, HANDS[i], lb);
          w[i] *= pol.bids[idx]; tot += w[i];
        }
        if (tot < 1e-300) w = HANDS.map(h => h.w);
        else for (let i = 0; i < w.length; i++) w[i] /= tot;
      }
      st = hypo(st, a, s.who);
    }
    return w;
  }
  return { isZ, pOf, hCnt, pHat, pOpenH, hypo, policy, belief, repsOf };
}

// 测试钩子：直接看后验（默认参数）
function readerBelief(round, who, opts = {}) {
  const H = readerHelpers(opts.beta == null ? 6 : opts.beta, opts.gamma == null ? 10 : opts.gamma, opts.eps == null ? 0.1 : opts.eps);
  return H.belief(round, who === 'A' ? 'B' : 'A');
}

function readerBot(opts = {}) {
  const BETA = opts.beta == null ? 6 : opts.beta;
  const GAMMA = opts.gamma == null ? 10 : opts.gamma;
  const EPS = opts.eps == null ? 0.1 : opts.eps;
  const H = readerHelpers(BETA, GAMMA, EPS);
  const tuned = opts.beta != null || opts.gamma != null || opts.eps != null;
  return {
    name: tuned ? `reader(${BETA},${GAMMA},${EPS})` : 'reader',
    decide(match, who) {
      const r = match.round, R = E.rulesOf(r), opp = who === 'A' ? 'B' : 'A';
      const myN = [0, 0, 0, 0, 0, 0, 0], myE = [0, 0, 0, 0, 0, 0, 0];
      for (const d of r.dice[who]) myN[d]++;
      for (let f = 1; f <= 6; f++) myE[f] = myN[f] + (f === 1 ? 0 : myN[1]);
      const myCnt = b => H.isZ(b) ? myN[b.face] : myE[b.face];
      const pOwn = b => t5c(b.count - myCnt(b), H.pOf(b));
      // 后验下喊价为真的概率：给定双方手牌，真值是确定的
      const pBelief = (b, w) => {
        const mc = myCnt(b);
        let s = 0;
        for (let i = 0; i < HANDS.length; i++) if (mc + H.hCnt(b, HANDS[i]) >= b.count) s += w[i];
        return s;
      };
      const openSwing = R.openLoserLoses ? 2 : 1;          // 相对分摆动：classic 开盅 2、flex 开盅 1
      const slashSwing = R.slash ? 2 * R.slashStake : openSwing;

      const w = H.belief(r, opp);
      const bids = H.repsOf(legalActions(r).filter(a => a.type === 'bid'));
      const pCur = r.bid ? pBelief(r.bid, w) : null;
      const evOpen = pCur === null ? null : (1 - 2 * pCur) * (R.slash && pCur < 0.5 ? slashSwing : openSwing);

      let best = null, bestEV = -Infinity;
      for (const b1 of bids) {
        const hr1 = H.hypo(r, b1, who);
        const lb1 = H.repsOf(legalActions(hr1).filter(a => a.type === 'bid'));
        const pols = HANDS.map(h => H.policy(hr1, h, lb1));
        const leafCache = new Map();
        // 叶子：对手反价 lb1[j] 后，用反价再更新后验，取我方最佳静态回应
        const leaf = j => {
          if (leafCache.has(j)) return leafCache.get(j);
          const bStar = lb1[j];
          let tot = 0;
          const w2 = new Array(HANDS.length);
          for (let i = 0; i < HANDS.length; i++) { w2[i] = w[i] * pols[i].bids[j]; tot += w2[i]; }
          if (tot < 1e-300) for (let i = 0; i < HANDS.length; i++) { w2[i] = w[i]; tot += w2[i]; }
          for (let i = 0; i < HANDS.length; i++) w2[i] /= tot;
          const pS = pBelief(bStar, w2);
          let v = (1 - 2 * pS) * (R.slash && pS < 0.5 ? slashSwing : openSwing);
          const hr2 = H.hypo(hr1, bStar, opp);
          for (const b2 of H.repsOf(legalActions(hr2).filter(a => a.type === 'bid'))) {
            let q = 0;
            for (let i = 0; i < HANDS.length; i++) q += w2[i] * H.pOpenH(b2, HANDS[i]);
            const ev = q * (2 * pOwn(b2) - 1) * openSwing;
            if (ev > v) v = ev;
          }
          leafCache.set(j, v);
          return v;
        };
        let ev = 0;
        const mc1 = myCnt(b1);
        for (let i = 0; i < HANDS.length; i++) {
          const pol = pols[i], h = HANDS[i];
          const truth = mc1 + H.hCnt(b1, h) >= b1.count;
          // 对手开盅（可能劈：可疑度越高劈概率越大）的相对分 payoff
          const swing = openSwing + (R.slash ? pol.open * (slashSwing - openSwing) : 0);
          let e = pol.open * (truth ? swing : -swing);
          for (let j = 0; j < lb1.length; j++) e += pol.bids[j] * leaf(j);
          ev += w[i] * e;
        }
        if (ev > bestEV + 1e-9 || (Math.abs(ev - bestEV) <= 1e-9 && best
            && (b1.count < best.count || (b1.count === best.count && E.ord(b1.face) < E.ord(best.face))))) {
          best = b1; bestEV = ev;
        }
      }
      if (evOpen !== null && evOpen > bestEV + 1e-9) {
        return { type: 'open', slash: !!(R.slash && pCur < 0.5) };
      }
      return best || { type: 'open', slash: false };
    },
  };
}

/* ---------- 机器人注册表 ----------
 * 竞技场的下拉框、CLI 的 player 规格、测试都从这张表读；加新机器人只需加一个条目。
 */
const BOTS = {
  'oracle': { label: 'oracle · 期望最大化', desc: '算清对手手牌分布再决策，纯数学地板，很慢', make: () => oracleBot() },
  'reader': { label: 'reader · 贝叶斯读牌', desc: '把对手喊价当情报读，最强基线', make: () => readerBot() },
};
function makeBot(spec, rng) {
  const b = BOTS[spec];
  if (!b) throw new Error('未知机器人: ' + spec);
  return b.make(rng || Math.random);
}

return { legalActions, oracleBot, readerBot, readerBelief, qOpen, tail5, BOTS, makeBot };
});
