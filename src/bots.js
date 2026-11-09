/* 基线 bot：免费午餐检查。LLM 赢不了阈值 bot，就说明没展现出超越算概率的博弈能力。
 * 统一接口：decide(match, who) -> {type:'open', slash?} | {type:'bid',count,face,mode?}
 * bot 只看自己的骰子和公开喊价，绝不偷看对手骰子。
 * 合法动作集合直接取引擎的 legalActions（按当前规则集），新套下也可能转斋/破斋/劈。
 */
const E = require('./dice-engine.js');

function legalActions(round) {
  return E.legalActions(round).map(a => {
    if (a.type !== 'bid') return a;
    // 概率估算要知道这一手结算时 1 是否算万能
    const zhai = a.mode === 'toZhai' ? true : a.mode === 'breakZhai' ? false : !!round.zhai;
    return Object.assign({}, a, { zhai: E.rulesOf(round).zhaiMode === 'face1' ? (a.face === 1) : zhai });
  });
}

// 最小合法加价（兜底/never-open 用）：个数优先小，点数按顺序小
function minBid(round) {
  const bids = legalActions(round).filter(a => a.type === 'bid');
  if (!bids.length) return null;
  bids.sort((x, y) => x.count - y.count || E.ord(x.face) - E.ord(y.face));
  return bids[0];
}

// 阈值 bot：P(当前叫点为真|我的骰子) < 阈值就开；否则喊一个"最可能为真"的合法价。
function thresholdBot(opts = {}) {
  const th = opts.threshold == null ? 0.5 : opts.threshold;
  return {
    name: `threshold(${th})`,
    decide(match, who) {
      const r = match.round;
      if (r.bid && E.probBidTrue(r.bid, r.dice[who]) < th) return { type: 'open' };
      const bids = legalActions(r).filter(a => a.type === 'bid');
      if (!bids.length) return { type: 'open' };
      let best = null, bestP = -1;
      for (const b of bids) {
        const p = E.probBidTrue(b, r.dice[who]);
        if (p > bestP + 1e-9 || (Math.abs(p - bestP) < 1e-9 && best && b.count < best.count)) {
          best = b; bestP = p;
        }
      }
      return best || minBid(r);
    },
  };
}

function randomBot(rng) {
  const R = rng || Math.random;
  return {
    name: 'random',
    decide(match, who) {
      const acts = legalActions(match.round);
      return acts[Math.floor(R() * acts.length)];
    },
  };
}

function alwaysOpenBot() {
  return {
    name: 'always-open',
    decide(match, who) {
      if (match.round.bid) return { type: 'open' };
      return minBid(match.round);
    },
  };
}

function neverOpenBot() {
  return {
    name: 'never-open',
    decide(match, who) {
      return minBid(match.round) || { type: 'open' };
    },
  };
}

module.exports = { legalActions, minBid, thresholdBot, randomBot, alwaysOpenBot, neverOpenBot };
