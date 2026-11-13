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
    // 概率估算要知道这一手结算时 1 是否算万能——统一问引擎，别在下游再猜一遍
    // （喊 1 即斋这条规则只在 zhaiAfter 里维护一次）。
    return Object.assign({}, a, { zhai: E.zhaiAfter(round, a) });
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

      // 假设局面：镜像 applyBid 的 zhai 记账，不动真局
      const hypo = (round, b, by) => {
        const z = E.zhaiAfter(round, b);
        return Object.assign({}, round, { bid: Object.assign({}, b, { by, zhai: z }), zhai: z });
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
    return Object.assign({}, round, { bid: Object.assign({}, b, { by, zhai: z }), zhai: z });
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
    let st = { rules: r.rules, bid: null, zhai: false };
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

/* deep：比 reader 更强的基线。
 *
 * reader 的三处结构性弱点，deep 各补一个：
 *  ① 它估「对手会不会开盅」时只用对手自己的手牌（pOpenH(b,h) 里没有我方信息），等于假设
 *     对手不看我们的喊价。deep 维护两份后验：我方对对手手牌，以及「对手对我方手牌」的
 *     后验（用同一套滤波跑我方座位）。对手开盅概率按它自己的后验算 → 诈唬的代价被算回来。
 *  ② reader 的叶子先把后验塌缩成一个平均手牌，再把「抬价后继续博弈」记 0。deep 的期望
 *     直接按「对手具体是哪手牌 h」逐条展开（我方手牌已知，真值是确定的），叶子给出
 *     「开掉 / 反抬」两条路的实际价值。
 *  ③ reader 用固定 ±1 的相对分。deep 用「赢下整局」的概率差做效用：终盘斩杀远重于
 *     一次 +1 回血，自己只剩 1 血时也自动变保守。
 * 另加一条 reader 没有的东西：多个候选的期望几乎打平（差 < slack）时，选让对手后验
 *     移动最少的那一手——同样赚，但少喂情报。
 * 零训练、零拟合、确定性；只在合法动作集里选。
 */
function deepBot(opts = {}) {
  const BETA = opts.beta == null ? 6 : opts.beta;
  const GAMMA = opts.gamma == null ? 10 : opts.gamma;
  const EPS = opts.eps == null ? 0.1 : opts.eps;
  const SLACK = opts.slack == null ? 0.001 : opts.slack;  // 期望打平带（赢局概率单位）；一次开盅只值 ~0.026，别设大
  // 对手类型混合：READ 比例假设对手「会读我」（按它对我方后验判真假），其余按「只看自己手牌」
  // （reader/oracle 那一类阈值式打法）。单押一边会偏：只押「会读我」时对 oracle 这种不看人的打法
  // 会系统低估它的开盅率，实测对 oracle 只有 8% 胜率；混合后两头都不吃亏。
  const READ = opts.read == null ? 0.5 : opts.read;
  // 变招：只在估值几乎并列的候选间抽签。带宽默认 0，原 deep 逐位不变。
  const MIXBAND = opts.mixBand == null ? 0 : opts.mixBand;
  const MIXT = opts.mixT == null ? 0.001 : opts.mixT;
  const SEED = opts.seed == null ? 0x6d2b79f5 : opts.seed;
  let rng = E.mulberry32(SEED), games = 0;
  const H = readerHelpers(BETA, GAMMA, EPS);
  const tuned = opts.beta != null || opts.gamma != null || opts.eps != null || opts.read != null || MIXBAND > 0;
  const N = HANDS.length;
  const logit = x => 1 / (1 + Math.exp(-x));

  // 手牌权重按「对某个喊价的贡献个数」分桶 → 尾和表：S[k] = P(贡献 ≥ k)
  function tailTable(w, b) {
    const B = new Float64Array(11);
    for (let i = 0; i < N; i++) { const c = H.hCnt(b, HANDS[i]); B[c > 10 ? 10 : c] += w[i]; }
    const S = new Float64Array(12);
    for (let c = 10; c >= 0; c--) S[c] = S[c + 1] + B[c];
    return S;
  }
  const tailAt = (S, need) => need <= 0 ? 1 : need > 10 ? 0 : S[need];

  return {
    name: tuned ? `deep(${BETA},${GAMMA},${EPS},${SLACK},${READ})` : 'deep',
    decide(match, who) {
      const t0 = Date.now();
      const r = match.round, R = E.rulesOf(r), opp = E.other(who);
      const myN = [0, 0, 0, 0, 0, 0, 0], myE = [0, 0, 0, 0, 0, 0, 0];
      for (const d of r.dice[who]) myN[d]++;
      for (let f = 1; f <= 6; f++) myE[f] = myN[f] + (f === 1 ? 0 : myN[1]);
      const mine = b => H.isZ(b) ? myN[b.face] : myE[b.face];

      // 手牌贡献表（按 点数:斋态 缓存），避免在手牌循环里反复算
      const cntCache = new Map();
      const cntFor = b => {
        const k = b.face + ':' + (H.isZ(b) ? 1 : 0);
        let a = cntCache.get(k);
        if (!a) { a = new Int8Array(N); for (let i = 0; i < N; i++) a[i] = H.hCnt(b, HANDS[i]); cntCache.set(k, a); }
        return a;
      };

      // 效用：赢下整局概率的变化（终盘斩杀自动加权，快输时自动保守）
      const hpMe = match.hp[who], hpOpp = match.hp[opp], hpMax = match.hpMax;
      const W = (a, b) => { const t = a + b; return t <= 0 ? 0.5 : a / t; };
      const U = (won, k, pays) => {
        const base = W(hpMe, hpOpp);
        return won
          ? W(Math.min(hpMax, hpMe + (pays ? k : 0)), Math.max(0, hpOpp - k)) - base
          : W(Math.max(0, hpMe - k), Math.min(hpMax, hpOpp + (pays ? k : 0))) - base;
      };
      const kOpen = R.stake, paysOpen = !!R.openLoserLoses;
      const kSlash = R.slashStake, paysSlash = true;
      const winV = U(true, kOpen, paysOpen), loseV = U(false, kOpen, paysOpen);
      const winSV = R.slash ? U(true, kSlash, paysSlash) : 0, loseSV = R.slash ? U(false, kSlash, paysSlash) : 0;

      // 两份后验：我方读对手；对手读我方（同一套滤波，座位换过来）
      const wMine = H.belief(r, opp);
      const wTheirs0 = H.belief(r, who);

      const lbNow = legalActions(r).filter(a => a.type === 'bid');
      const cand = H.repsOf(lbNow);
      const keyOf = a => E.actionKey(a);
      const idxIn = a => { const k = keyOf(a); for (let i = 0; i < lbNow.length; i++) if (keyOf(lbNow[i]) === k) return i; return -1; };
      const polMine = new Array(N);
      for (let i = 0; i < N; i++) polMine[i] = H.policy(r, HANDS[i], lbNow);

      // 对手看到我方喊 b1 之后，它对我方手牌的后验
      function beliefAfterOur(i1) {
        const w = new Float64Array(N);
        let tot = 0;
        for (let i = 0; i < N; i++) { w[i] = wTheirs0[i] * polMine[i].bids[i1]; tot += w[i]; }
        if (tot < 1e-300) { for (let i = 0; i < N; i++) w[i] = HANDS[i].w; return w; }
        for (let i = 0; i < N; i++) w[i] /= tot;
        return w;
      }

      let bestAct = null, bestEV = -Infinity, bestLeak = Infinity;
      const pool = MIXBAND > 0 ? [] : null;
      function consider(act, ev, leak) {
        if (pool) pool.push({ act, ev });
        if (ev > bestEV + 1e-12) { bestEV = ev; bestAct = act; bestLeak = leak; return; }
        if (ev > bestEV - SLACK && leak < bestLeak) { bestAct = act; bestLeak = leak; }
      }
      // ① 开盅 / 劈（对手当前这一手）
      if (r.bid) {
        const b0 = r.bid, c0 = cntFor(b0), my0 = mine(b0);
        let ev = 0, evS = 0;
        for (let i = 0; i < N; i++) {
          const tru = my0 + c0[i] >= b0.count;
          ev += wMine[i] * (tru ? loseV : winV);
          if (R.slash) evS += wMine[i] * (tru ? loseSV : winSV);
        }
        if (R.slash && evS > ev) consider({ type: 'open', slash: true }, evS, Infinity);
        else consider({ type: 'open', slash: false }, ev, Infinity);
      }

      // ② 每个候选喊价
      for (const b1 of cand) {
        const i1 = idxIn(b1);
        if (i1 < 0) continue;
        const c1 = cntFor(b1), my1 = mine(b1);
        const wT = beliefAfterOur(i1);
        const S1 = tailTable(wT, b1);              // 对手视角：我方对 b1 的贡献尾分布
        const hr1 = H.hypo(r, b1, who);
        const lb1 = H.repsOf(legalActions(hr1).filter(a => a.type === 'bid'));
        const polOpp = new Array(N);
        for (let i = 0; i < N; i++) polOpp[i] = H.policy(hr1, HANDS[i], lb1);

        // 预处理二层：每个对手反价 b2 的手牌贡献、我方开它的价值、以及三层候选 b3
        const pre2 = lb1.map(b2 => {
          const hr2 = H.hypo(hr1, b2, opp);
          const b3s = H.repsOf(legalActions(hr2).filter(a => a.type === 'bid'));
          return {
            c: cntFor(b2), my: mine(b2), need: b2.count,
            lvl3: b3s.map(b3 => ({ b: b3, c: cntFor(b3), S: tailTable(wT, b3), my: mine(b3), need: b3.count })),
          };
        });

        let ev = 0;
        for (let i = 0; i < N; i++) {
          const w = wMine[i];
          if (w <= 0) continue;
          const pTruth1 = (1 - READ) * H.pHat(b1, HANDS[i]) + READ * tailAt(S1, b1.count - c1[i]);
          const pOpen = logit(GAMMA * (0.5 - pTruth1));
          const ourTruth1 = my1 + c1[i] >= b1.count;
          let v = pOpen * (ourTruth1 ? winV : loseV);
          if (pOpen < 1) {
            let cont = 0;
            for (let j = 0; j < lb1.length; j++) {
              const pj = polOpp[i].bids[j];
              if (pj <= 1e-9) continue;
              const P = pre2[j];
              const tru2 = P.my + P.c[i] >= P.need;
              let vv = tru2 ? loseV : winV;                      // 我方开掉 b2
              if (R.slash) { const s2 = tru2 ? loseSV : winSV; if (s2 > vv) vv = s2; }
              for (let t = 0; t < P.lvl3.length; t++) {
                const Q = P.lvl3[t];
                const pT3 = (1 - READ) * H.pHat(Q.b, HANDS[i]) + READ * tailAt(Q.S, Q.need - Q.c[i]);
                const pO3 = logit(GAMMA * (0.5 - pT3));
                const t3 = Q.my + Q.c[i] >= Q.need;
                const v3 = pO3 * (t3 ? winV : loseV);
                if (v3 > vv) vv = v3;
              }
              cont += pj * vv;
            }
            v += (1 - pOpen) * cont;
          }
          ev += w * v;
        }
        // 情报代价：对手对我方手牌的后验移动量（越小越难被读）
        let leak = 0;
        for (let i = 0; i < N; i++) leak += Math.abs(wT[i] - wTheirs0[i]);
        consider(b1, ev, leak);
      }
      // 近似并列才变招：先按真实 EV 找上界，再把带宽内的动作按 Boltzmann 抽签。
      // 带宽必须远小于「开盅 vs 喊价」的实际价值差，否则等于随机送轮。
      if (pool && pool.length > 1) {
        pool.sort((a, b) => b.ev - a.ev);
        const top = pool[0].ev;
        const near = pool.filter(x => x.ev >= top - MIXBAND);
        if (near.length > 1) {
          let sum = 0;
          const w = near.map(x => { const q = Math.exp((x.ev - top) / MIXT); sum += q; return q; });
          let u = rng() * sum;
          for (let i = 0; i < near.length; i++) {
            u -= w[i];
            if (u <= 0) { bestAct = near[i].act; bestEV = near[i].ev; break; }
          }
        }
      }
      const out = bestAct || { type: 'open', slash: false };
      if (opts.debug) out.ms = Date.now() - t0;
      return out;
    },
    reset() { rng = E.mulberry32((SEED + Math.imul(++games, 0x9e3779b1)) >>> 0); },
  };
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

/* ==================================================================== apex v4
 * 用「结算后可见的真实行为」校准对开盅的判断，而不是在搜索里假设一套固定脾气。
 *
 * 为什么不是继续加搜索深度：本地校准显示，近似模型一旦高估「对手不会开我的诈唬」，
 * 多出来的反价搜索会成批制造末价假货，开盅正确率反而被 deep 压住。v4 因此以当前最强
 * 的稳健策略（READ=1）为底座，只加两件能被过程指标验证的事：
 *
 *  ① 在线开盅模型：每轮亮牌后回放公开序列，统计 qT=P(它开|我这手真)、qF=P(它开|我这手假)。
 *     若 qF−qT 长期接近 0（对手根本不看我的牌），就降低「它读我」的权重；反之保持满读。
 *  ② 变招：只在 EV 几乎并列时抽签。带宽远小于开盅价值，混合的是同价动作而不是随机送轮。
 *
 * 对手手牌只在 history 结算后读取，当前决策绝不使用未亮暗牌。
 */
function apexAdaptiveBot(opts = {}) {
  const READ1 = opts.read1 == null ? 1 : opts.read1;
  const MIXBAND = opts.mixBand == null ? 0.0012 : opts.mixBand;
  const MIXT = opts.mixT == null ? 0.0006 : opts.mixT;
  const SEED = opts.seed == null ? 0x51f15e : opts.seed;
  const ADAPT = opts.adapt !== false;

  const Q = { nT: 0, kT: 0, nF: 0, kF: 0 };
  const st = { seen: 0, snap: null, games: 0 };
  let read = READ1, base = null, baseRead = null, minRead = READ1, maxRead = READ1;

  function qVals() {
    const qT = Math.max(0.02, Math.min(0.98, (Q.kT + 0.7) / (Q.nT + 2)));
    const qF = Math.max(0.02, Math.min(0.98, (Q.kF + 1.2) / (Q.nF + 2)));
    return { qT, qF };
  }
  function targetRead() {
    if (!ADAPT) return READ1;
    const n = Q.nT + Q.nF;
    if (n < 6) return READ1;
    const { qT, qF } = qVals();
    const lift = qF - qT;                       // 它开我假货的额外倾向
    const conf = n / (n + 8);
    const dead = Math.max(0, Math.min(1, (0.12 - lift) / 0.12));
    // 只在证据很足且它明显不按我的真假开盅时退到 0.7；底座仍是满读。
    return Math.max(0.7, READ1 - 0.3 * conf * dead);
  }
  function ensureBase() {
    const r = Math.round(read * 20) / 20;
    if (base && baseRead === r) return;
    baseRead = r;
    base = deepBot({ read: r, mixBand: MIXBAND, mixT: MIXT, seed: SEED + Math.imul(st.games + 1, 0x9e3779b1) });
  }

  // 回放一轮结算后的公开序列：每次我方喊价之后对手的那一个动作，就是一条开盅样本。
  function learnRound(hist, who, opp) {
    const snap = st.snap;
    if (!snap || snap.no !== hist.no || !hist.dice) return;
    let seq = snap.seq.slice();
    if (hist.opener === opp && (!seq.length || seq[seq.length - 1].kind !== 'open')) {
      seq.push({ who: opp, kind: 'open', slash: !!hist.slash, zhai: !!hist.zhai });
    }
    const all = hist.dice.A.concat(hist.dice.B);
    let zhai = false, lastMine = null;
    for (const ev of seq) {
      if (ev.kind === 'bid') {
        const isZ = ev.zhai != null ? !!ev.zhai : (ev.face === 1 ? true : ev.mode === 'toZhai' ? true : ev.mode === 'breakZhai' ? false : zhai);
        if (ev.who === who) {
          lastMine = E.countFace(all, ev.face, isZ) >= ev.count;
        } else if (lastMine != null) {
          if (lastMine) { Q.nT++; } else { Q.nF++; }
          lastMine = null;
        }
        zhai = isZ;
      } else if (ev.kind === 'open') {
        if (lastMine != null) {
          if (lastMine) { Q.nT++; if (ev.who === opp) Q.kT++; }
          else { Q.nF++; if (ev.who === opp) Q.kF++; }
          lastMine = null;
        }
      }
    }
  }

  return {
    name: 'apex',
    reset() {
      Q.nT = Q.kT = Q.nF = Q.kF = 0;
      st.seen = 0; st.snap = null; st.games++;
      read = READ1; minRead = maxRead = READ1; base = null; baseRead = null;
    },
    stats() {
      const { qT, qF } = qVals();
      return { qT: +qT.toFixed(3), qF: +qF.toFixed(3), nT: Q.nT, nF: Q.nF,
        read: +read.toFixed(3), minRead: +minRead.toFixed(3), maxRead: +maxRead.toFixed(3), mixBand: MIXBAND };
    },
    decide(match, who) {
      const opp = E.other(who);
      while (match.history.length > st.seen) { learnRound(match.history[st.seen], who, opp); st.seen++; }
      read = targetRead();
      if (read < minRead) minRead = read;
      if (read > maxRead) maxRead = read;
      ensureBase();
      const r = match.round;
      st.snap = { no: r.no, seq: r.seq.slice() };
      const act = base.decide(match, who);
      // 给下一轮复盘留下完整序列；引擎原始 seq 已带 zhai，这里补上我方最后一手。
      st.snap.seq.push(act.type === 'bid'
        ? { who, kind: 'bid', count: act.count, face: act.face, mode: act.mode || 'normal', zhai: E.zhaiAfter(r, act) }
        : { who, kind: 'open', slash: !!act.slash });
      return act;
    },
  };
}

/* ---------- 机器人注册表 ----------
 * 竞技场的下拉框、CLI 的 player 规格、测试都从这张表读；加新机器人只需加一个条目。
 */
const BOTS = {
  'oracle': { label: 'oracle · 期望最大化', desc: '算清对手手牌分布再决策，纯数学地板，很慢', make: () => oracleBot() },
  'reader': { label: 'reader · 贝叶斯读牌', desc: '把对手喊价当情报读', make: () => readerBot() },
  'deep':   { label: 'deep · 双向读牌 + 终盘', desc: 'reader 的加强版：对手也会读我、叶子按手牌展开、效用按赢局概率', make: () => deepBot() },
  'apex':   { label: 'apex · 在线行为校准 + 变招', desc: '结算后学习对手开盅条件概率 + 满读策略底座 + 近似同价混合', make: (o) => apexAdaptiveBot(o && typeof o === 'object' ? o : {}) },
};
function makeBot(spec, rng) {
  const b = BOTS[spec];
  if (!b) throw new Error('未知机器人: ' + spec);
  return b.make(rng || Math.random);
}

return { legalActions, oracleBot, readerBot, readerBelief, deepBot, apexAdaptiveBot, qOpen, tail5, BOTS, makeBot };
});
