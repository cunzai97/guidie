/* 鬼骰排名：纯函数 Elo + 指纹分组，无 UI / 网络。浏览器与 Node 测试同源。
 *
 * 口径：
 *  - 每个 (ruleset_hash × prompt_hash) 组独立一张榜——跨指纹的胜负不混排；
 *  - 对手分决定得失：E = 1/(1+10^((Rb−Ra)/400))，R += K×(S−E)，K=32，初始 1500；
 *    赢弱手几乎不涨（虐菜刷不动），输给弱手重扣；平局各按 0.5 计；
 *  - 同端点+同模型 = 同一选手（改别名 / 重建预设不分家）；
 *  - 强度筛选只收「双方都是该档」的对局，混档局只在「全部」里出现。
 */
(function (root) {
'use strict';
const NODE = (typeof module !== 'undefined' && module.exports);

const INITIAL = 1500, K = 32, PROVISIONAL_GAMES = 5;

/* SHA-1（纯 JS）：与 runlog.sha1Text 同口径，供浏览器算 prompt_hash。
 * 不依赖 crypto.subtle（非 localhost 的 http 页面拿不到）。 */
function sha1hex(str) {
  const bytes = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(String(str)) : Buffer.from(String(str), 'utf8');
  const l = bytes.length;
  const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, (l * 8) >>> 0, false);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) { const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]; w[j] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('');
}
// 与 runlog.promptHash 完全一致：texts.join('\n\0\n') 的 sha1 前 12 位
function hashTexts(texts) { return sha1hex(texts.join('\n\0\n')).slice(0, 12); }

function identity(seat) {
  return String((seat && seat.base) || '').replace(/\/+$/, '') + '|' + String((seat && seat.model) || '');
}
function groupKey(m) { return (m.ruleset_hash || '?') + '|' + (m.prompt_hash || '?'); }

function listGroups(matches) {
  const map = new Map();
  for (const m of matches) {
    const k = groupKey(m);
    if (!map.has(k)) map.set(k, { key: k, ruleset_hash: m.ruleset_hash || '?', prompt_hash: m.prompt_hash || '?',
      variant: m.variant || '', rulesName: (m.rules && m.rules.name) || '', n: 0 });
    const g = map.get(k); g.n++;
    if (m.variant) g.variant = m.variant;
    if (m.rules && m.rules.name) g.rulesName = m.rules.name;
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

// 强度筛选：'all' 全收；具体档位只收双方都用了该档的对局（混档局不公平，不进子榜）
function filterEffort(matches, effort) {
  if (!effort || effort === 'all') return matches;
  return matches.filter(m => m.seats && m.seats.A && m.seats.B
    && m.seats.A.effort === effort && m.seats.B.effort === effort);
}

function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

const STAT_KEYS = ['steps', 'calls', 'opens', 'opensCorrect', 'slashes', 'forfeits', 'tokens', 'ms', 'memos'];

/* 按时间顺序打一遍 Elo。matches 应已按组/强度筛过；返回排名数组（四舍五入显示）。 */
function elo(matches) {
  const table = new Map();
  const entry = seat => {
    const key = identity(seat);
    if (!table.has(key)) table.set(key, { key, alias: seat.alias || seat.model || '?', model: seat.model || '',
      base: String(seat.base || '').replace(/\/+$/, ''), rating: INITIAL, wins: 0, losses: 0, draws: 0, games: 0,
      opens: 0, opensCorrect: 0, forfeits: 0, tokens: 0, lastAt: 0 });
    const e = table.get(key);
    if (seat.alias) e.alias = seat.alias;
    return e;
  };
  const sorted = matches.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  for (const m of sorted) {
    if (!m.seats || !m.seats.A || !m.seats.B) continue;
    const draw = !m.winner && !!m.draw;
    if (!m.winner && !draw) continue;   // 未评局不进榜
    const a = entry(m.seats.A), b = entry(m.seats.B);
    const sa = draw ? 0.5 : (m.winner === 'A' ? 1 : 0);
    const d = K * (sa - expected(a.rating, b.rating));
    a.rating += d; b.rating -= d;
    a.games++; b.games++;
    if (draw) { a.draws++; b.draws++; }
    else if (m.winner === 'A') { a.wins++; b.losses++; }
    else { b.wins++; a.losses++; }
    for (const [e, st] of [[a, m.stats && m.stats.A], [b, m.stats && m.stats.B]]) {
      if (!st) continue;
      for (const k of STAT_KEYS) if (typeof st[k] === 'number') e[k] = (e[k] || 0) + st[k];
    }
    a.lastAt = b.lastAt = m.t || 0;
  }
  return [...table.values()].map(e => Object.assign(e, {
    rating: Math.round(e.rating),
    provisional: e.games < PROVISIONAL_GAMES,
    winRate: e.games ? (e.wins + 0.5 * e.draws) / e.games : 0,
    openAcc: e.opens ? e.opensCorrect / e.opens : null,
  })).sort((x, y) => y.rating - x.rating || y.wins - x.wins || x.losses - y.losses || x.key.localeCompare(y.key));
}

const API = { INITIAL, K, PROVISIONAL_GAMES, sha1hex, hashTexts, identity, groupKey, listGroups, filterEffort, expected, elo };
if (NODE) module.exports = API;
else root.ArenaRanking = API;
})(typeof self !== 'undefined' ? self : globalThis);