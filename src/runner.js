/* 无头大话骰 PK runner。
 * - 复式赛：同一副骰子 deal（同 seed）打两局，第二局交换座位，对消骰运与先手优势。
 * - 过程指标：引擎持上帝视角真值，零成本算出开牌正确率/受骗率/诈唬等，不只看胜负。
 * - 归因：模型有限重写后仍非法 → 判负（forfeit），harness 不替它走棋；连接失败 → 该局未评。
 */
const E = require('./dice-engine.js');
const bots = require('./bots.js');

const MAX_TURNS_PER_ROUND = 200;   // 安全阀：理论上叫点有界，这里防病态循环

function applyForfeit(m, who) {
  const r = m.round;
  r.over = true; r.revealed = true;
  const loser = who, winner = E.other(who);
  const R = E.rulesOf(r);
  const k = R.stake, loserPays = R.openLoserLoses;
  r.result = { forfeit: true, loser, winner, dice: r.dice, stake: k, loserPays };
  m.points[winner] += k;
  if (loserPays) m.points[loser] -= k;
  m.losses[loser]++; m.lastLoser = loser;
  m.history.push({ no: r.no, bid: r.bid || { by: who, count: 0, face: 0 }, opener: winner, actual: 0, truth: false,
    loser, winner, forfeit: true, stake: k, loserPays });
  if (m.points[winner] >= m.roundTarget) { m.over = true; m.winner = winner; }
  return r.result;
}

function newStats() {
  return {
    steps: 0, bids: 0, bluffs: 0, opens: 0, opensCorrect: 0, opensWrong: 0,
    slashes: 0, toZhai: 0, breakZhai: 0,
    fooled: 0, bluffCaught: 0, forfeits: 0, asks: 0, errors: 0,
    // 预算健康度：截断/解析歧义/token/耗时。截断率高时胜负归因不可信。
    truncated: 0, parseAmbiguous: 0, calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, ms: 0,
  };
}

// 单局。players: {A:player, B:player}；rng 为种子 RNG。返回结果与双方过程指标。
async function runMatch(players, rng, opts = {}) {
  const target = opts.roundTarget || 3;
  const maxRounds = opts.maxRounds || 30;        // 单局轮数封顶，到顶按当前积分判胜
  const firstBidder = opts.firstBidder || 'A';
  const m = E.newMatch({ roundTarget: target, firstBidder, rules: opts.rules || 'classic' });
  // 每局清空 LLM 玩家的持久对话，避免跨局串味（bot 无 reset 则跳过）
  if (players.A.reset) players.A.reset();
  if (players.B.reset) players.B.reset();
  const stats = { A: newStats(), B: newStats() };
  const memos = { A: [], B: [] };                // 各模型自身思考历史，喂回上下文
  const events = [];
  const metaBase = opts.meta || {};             // { run_id, deal, swap, game } 由 runPK 注入
  let ungraded = false;
  let turns = 0;
  const ev = x => events.push({ ...metaBase, round: m.roundNo, step: turns || 0, ...x });

  while (!m.over) {
    E.startRound(m, rng);
    const r = m.round;
    turns = 0;
    while (!r.over) {
      if (++turns > MAX_TURNS_PER_ROUND) { ungraded = true; break; }
      const who = r.turn, pl = players[who];
      const prevBid = r.bid ? { ...r.bid } : null;
      const all = r.dice.A.concat(r.dice.B);
      const stepMeta = { ...metaBase, round: m.roundNo, step: turns, seat: who };
      let action;
      try { action = await pl.decide(m, who, memos[who], stepMeta); }
      catch (e) { action = { type: 'error', error: String(e) }; }
      const st = stats[who];
      st.steps++;
      if (action.asks) st.asks += action.asks;
      st.calls += (action.attempts || []).length;
      for (const a of (action.attempts || [])) {
        if (a.finish === 'length') st.truncated++;
        if (a.ambiguous) st.parseAmbiguous++;
        st.promptTokens += a.promptTokens || 0;
        st.completionTokens += a.completionTokens || 0;
        st.cachedTokens += a.cachedTokens || 0;
        st.ms += a.ms || 0;
      }
      // 记录自身思考（判断句 + 行动），供下一回合上下文喂回
      if (action.type !== 'error') {
        const at = action.type === 'bid'
          ? `喊 ${action.count} 个 ${action.face}` + (action.mode === 'toZhai' ? ' 斋' : action.mode === 'breakZhai' ? ' 破斋' : '')
          : action.type === 'open' ? (action.slash ? '劈' : '开盅') : '判负';
        memos[who].push({ round: r.no, judgment: action.judgment || '', action: at });
      }

      if (action.type === 'error') {
        st.errors++; ungraded = true;
        ev({ round: r.no, who, kind: 'error', error: action.error });
        return { ungraded, winner: null, points: m.points, losses: m.losses, stats, events, rounds: m.roundNo };
      }
      if (action.type === 'forfeit') {
        st.forfeits++;
        ev({ round: r.no, who, kind: 'forfeit', attempts: action.attempts });
        applyForfeit(m, who);
        break;
      }
      if (action.type === 'open') {
        st.opens++;
        if (action.slash) st.slashes++;
        const res = E.resolveOpen(m, who, { slash: action.slash });
        const actual = E.countFace(all, prevBid.face, prevBid.zhai);
        const truth = actual >= prevBid.count;
        if (truth) st.opensWrong++; else { st.opensCorrect++; stats[prevBid.by].bluffCaught++; }
        ev({ round: r.no, who, kind: 'open', slash: !!res.slash, stake: res.stake,
             bid: prevBid, actual, truth, loser: res.loser });
        break;
      }
      if (action.type === 'bid') {
        st.bids++;
        const norm = E.normalizeAction(r, action);
        const zhai = E.zhaiAfter(r, norm);
        if (norm.mode === 'toZhai') st.toZhai++;
        if (norm.mode === 'breakZhai') st.breakZhai++;
        const actual = E.countFace(all, norm.face, zhai);
        const truth = actual >= norm.count;
        if (!truth) st.bluffs++;
        // 受骗：对手上一手是假的，你却跟着喊（没开）
        if (prevBid && prevBid.by !== who) {
          const prevActual = E.countFace(all, prevBid.face, prevBid.zhai);
          if (prevActual < prevBid.count) st.fooled++;
        }
        E.applyBid(r, who, norm);
        ev({ round: r.no, who, kind: 'bid', count: norm.count, face: norm.face,
             mode: norm.mode, zhai, truth, asks: action.asks || 1 });
        continue;
      }
      // 未知动作类型 → 当作非法判负
      st.forfeits++;
      ev({ round: r.no, who, kind: 'forfeit', reason: 'unknown-action', action });
      applyForfeit(m, who);
      break;
    }
    if (ungraded) break;
    // 轮末压缩：摘要链模式（player.summarize 存在）下，让每个 LLM 玩家把本轮总结成一条记忆笔记带入下一轮。
    // 终局轮（m.over）不再总结——没有下一轮可带入，省一次调用。总结失败不致命，记 event 不影响比分。
    if (!m.over && m.round.result) {
      for (const who of ['A', 'B']) {
        const pl = players[who];
        if (pl.summarize) {
          try { await pl.summarize(m, who, m.round.result, { ...metaBase, round: m.roundNo, step: 0, seat: who }); }
          catch (e) { ev({ round: m.roundNo, who, kind: 'summary-error', error: String(e).slice(0, 200) }); }
        }
      }
    }
    if (!m.over && m.roundNo >= maxRounds) {
      m.over = true; m.capped = true;
      m.winner = m.points.A === m.points.B ? null : (m.points.A > m.points.B ? 'A' : 'B');
    }
  }
  // 封顶且积分持平 → 平局。以前 winner=null 会让这一局在 runPK 里静默消失（stats 却并入了）。
  return { ungraded, winner: m.winner, draw: !!m.capped && m.winner === null,
           capped: !!m.capped, points: m.points, losses: m.losses, stats, events, rounds: m.roundNo };
}

// 复式赛：deals 个 seed，每个 seed 打两局（交换座位）。聚合到玩家身份。
async function runPK(player0, player1, opts = {}) {
  const deals = opts.deals || 10;
  const baseSeed = opts.seed || 12345;
  const agg = {
    p0: { name: player0.name, wins: 0, losses: 0, draws: 0, ungraded: 0, stats: newStats() },
    p1: { name: player1.name, wins: 0, losses: 0, draws: 0, ungraded: 0, stats: newStats() },
  };
  const games = [];
  for (let d = 0; d < deals; d++) {
    const seed = baseSeed + d;
    const firstBidder = (seed % 2 === 0) ? 'A' : 'B';
    // 局 1：p0 坐 A；局 2：p1 坐 A（同一副骰子）
    for (const swap of [false, true]) {
      const game = d * 2 + (swap ? 1 : 0);
      const meta = { run_id: opts.runId || null, deal: d, swap, game };
      const players = swap ? { A: player1, B: player0 } : { A: player0, B: player1 };
      const res = await runMatch(players, E.mulberry32(seed), { roundTarget: opts.roundTarget, maxRounds: opts.maxRounds, firstBidder, meta, rules: opts.rules });
      const seatOf = { p0: swap ? 'B' : 'A', p1: swap ? 'A' : 'B' };
      for (const pk of ['p0', 'p1']) {
        const seat = seatOf[pk];
        mergeStats(agg[pk].stats, res.stats[seat]);
        if (res.ungraded) agg[pk].ungraded++;
        else if (res.draw) agg[pk].draws++;
        else if (res.winner === seat) agg[pk].wins++;
        else if (res.winner) agg[pk].losses++;
      }
      games.push({ ...meta, seed, winner: res.ungraded ? null : res.winner, draw: !!res.draw,
                   capped: res.capped, seatOf, points: res.points, losses: res.losses,
                   rounds: res.rounds, stats: res.stats, events: res.events });
      if (opts.onGame) opts.onGame(games[games.length - 1], d, swap);
    }
  }
  return { agg, games, deals, baseSeed };
}

function mergeStats(dst, src) { for (const k in dst) dst[k] += src[k] || 0; }

function rate(n, d) { return d ? +(n / d).toFixed(3) : null; }

function summarize(agg) {
  const out = {};
  for (const pk of ['p0', 'p1']) {
    const a = agg[pk], s = a.stats;
    const graded = a.wins + a.losses;
    out[a.name] = {
      wins: a.wins, losses: a.losses, draws: a.draws, ungraded: a.ungraded,
      winRate: rate(a.wins, graded),
      openAccuracy: rate(s.opensCorrect, s.opens),       // 开牌正确率（ToM 直接度量）
      fooledRate: rate(s.fooled, s.bids),                // 受骗率：对手诈唬你却跟了
      bluffRate: rate(s.bluffs, s.bids),                 // 诈唬倾向
      bluffCaught: s.bluffCaught,                        // 你的诈唬被正确开掉次数
      forfeits: s.forfeits, errors: s.errors,
      avgAsks: rate(s.asks, s.steps),                    // 平均重写次数（越高越费劲）
      steps: s.steps,
      // 预算健康度：截断/歧义率高 → 胜负归因被输出预算污染，结论不可信
      calls: s.calls, truncated: s.truncated, truncRate: rate(s.truncated, s.calls),
      ambiguousRate: rate(s.parseAmbiguous, s.calls),
      avgPromptTokens: rate(s.promptTokens, s.calls),
      avgCompletionTokens: rate(s.completionTokens, s.calls),
      cacheRate: rate(s.cachedTokens, s.promptTokens),
      avgCallMs: rate(s.ms, s.calls),
    };
  }
  return out;
}

/* 配对 bootstrap：复式赛每个 deal 两局（同一副骰子、交换座位），deal 才是独立单位。
 * score_d = p0 在该 deal 的净胜局数 ∈ {-2..2}；p0 胜率 = 0.5 + mean(score_d)/4。
 * 对 deals 重采样得到 95% CI；样本 <2 个 deal 时返回 null（不给虚假精度）。
 */
function pairedCI(games, B = 2000, seed = 20261109) {
  const deals = new Map();
  for (const g of games) {
    if (!g.winner && !g.draw) continue;                 // 未评局不进配对
    const k = g.deal != null ? g.deal : g.seed;
    if (!deals.has(k)) deals.set(k, 0);
    const s = g.draw ? 0 : (g.winner === g.seatOf.p0 ? 1 : -1);
    deals.set(k, deals.get(k) + s);
  }
  const arr = [...deals.values()];
  if (arr.length < 2) return null;
  const rng = E.mulberry32(seed);
  const means = [];
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[Math.floor(rng() * arr.length)];
    means.push(0.5 + sum / (4 * arr.length));
  }
  means.sort((x, y) => x - y);
  return {
    deals: arr.length, bootstrap: B,
    winRateCI95: [+means[Math.floor(0.025 * B)].toFixed(3), +means[Math.floor(0.975 * B)].toFixed(3)],
    point: +(0.5 + arr.reduce((x, y) => x + y, 0) / (4 * arr.length)).toFixed(3),
  };
}

module.exports = { runMatch, runPK, summarize, pairedCI, newStats, bots };