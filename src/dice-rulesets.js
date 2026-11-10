/* 鬼骰 · 规则集（UMD，浏览器与 Node 共用）
 * 规则不再是写死的一段文本，而是一份可切换、可自定义的配置。
 * 单一真源：引擎合法性 / 行动解析 / 给模型看的规则文本都从这里取参数。
 *
 * 两套内置：
 *   classic —— 原来的规则，逐字保留（点数 1 = 斋、锁死点数、无转斋/破斋/劈），历史 run 可比。
 *   flex    —— 新规则：取半向上取整转斋（点数任意）、斋内同普通规则抬价、
 *              翻倍个数破斋（1 恢复万能，且须大于斋前一手）、劈（双向结算 ±1）；开盅只扣输家血。
 * 用户可在设置里把任意一套另存为自定义套，逐项改参数；规则文本会按参数自动生成。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DiceRulesets = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 经典套：任何字段都不改，保证 buildSystem / buildUser / legalMenu 的经典分支逐字复现旧文本。
  const CLASSIC = {
    id: 'classic', name: '经典 · 喊 1 为斋', builtin: true,
    zhaiMode: 'face1',      // 'face1'=喊点数1即斋（旧规则） | 'half'=取半向上取整转斋
    halfDivisor: 2,         // 转斋个数 = ceil(上一手个数 / halfDivisor)
    faceFree: false,        // 转斋那一手点数是否任意（false=只能喊 1）
    lockFace: true,         // 斋内是否锁死点数（旧规则：只能继续加 1 的个数）
    breakMultiplier: 0,     // 破斋倍数；0=不允许破斋
    breakPlus: 0,           // 破斋门槛再加几（新规 = 倍数×当前个数 + 1）
    breakRestoresWild: true,// 破斋后 1 恢复万能
    firstFace1: false,      // 首喊能否喊点数 1
    firstZhai: false,       // 首喊能否直接喊斋（开局就关掉万能 1）
    firstMin: 2, firstMax: 6,
    maxCount: 10,           // 全场 10 颗，固定不许改
    slash: false,           // 「劈」
    slashStake: 2,          // 劈的积分（零和）
    stake: 1,               // 普通开盅的积分
    openLoserLoses: true,   // 开盅是否双向结算（true=赢家也回血；false=只有输家掉血）
    autoInfer: true,        // 漏写标记时按个数自动识别转斋 / 破斋
  };

  // 新套：用户 2026-11-09 定稿（点数全自由 / 首喊可斋 / 翻倍破斋 / 开盅赢家+1·劈±1）。
  const FLEX = {
    id: 'flex', name: '鬼骰新规 · 取半转斋 / 翻倍破斋 / 劈', builtin: true,
    zhaiMode: 'half', halfDivisor: 2, faceFree: true, lockFace: false,
    breakMultiplier: 2, breakPlus: 1,   // 破斋 = 当前个数 ×2 +1：一条规则既防压价循环，也不用记斋前那一手
    breakRestoresWild: true,
    firstFace1: true,  // 首喊点数可以是 1~6（喊 1 就直接以斋开局）
    firstZhai: true,   // 首喊也能直接喊斋
    firstMin: 2, firstMax: 6, maxCount: 10,
    slash: true, slashStake: 1, stake: 1, autoInfer: true,
    openLoserLoses: false,  // 开盅只赢家 +1，输家不扣；只有劈才双向结算（±1）
  };

  const BUILTIN = Object.freeze({ classic: CLASSIC, flex: FLEX });
  const BUILTIN_LIST = Object.freeze([CLASSIC, FLEX]);

  const INT = (v, lo, hi, d) => {
    const n = Math.round(+v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const BOOL = (v, d) => (typeof v === 'boolean' ? v : d);

  // 归一化：任何来源（内置 / localStorage / presets.json / CLI）都先过这一层，
  // 引擎与提示词只信归一化后的对象，避免非法参数把对局带进不可能的状态。
  function normalize(raw) {
    const src = (typeof raw === 'string') ? (BUILTIN[raw] || BUILTIN.classic) : (raw || {});
    const base = BUILTIN[src.base] || (src.zhaiMode ? (src.zhaiMode === 'face1' ? CLASSIC : FLEX) : CLASSIC);
    const o = Object.assign({}, base, src);
    const out = {
      id: String(o.id || 'custom').slice(0, 40),
      name: String(o.name || '自定义规则').slice(0, 48),
      builtin: !!BUILTIN[o.id] && !!o.builtin,
      zhaiMode: o.zhaiMode === 'half' ? 'half' : 'face1',
      halfDivisor: INT(o.halfDivisor, 2, 4, 2),
      faceFree: BOOL(o.faceFree, base.faceFree),
      lockFace: BOOL(o.lockFace, base.lockFace),
      breakMultiplier: INT(o.breakMultiplier, 0, 4, base.breakMultiplier),
      breakPlus: INT(o.breakPlus, 0, 3, base.breakPlus),
      breakRestoresWild: BOOL(o.breakRestoresWild, base.breakRestoresWild),
      firstFace1: BOOL(o.firstFace1, base.firstFace1),
      firstZhai: BOOL(o.firstZhai, base.firstZhai),
      minCount: 2,        // 任何喊价的个数下限（固定 2，不可配置）：首喊、转斋取半、破斋都一样
      firstMin: INT(o.firstMin, 2, 6, 2),
      firstMax: INT(o.firstMax, INT(o.firstMin, 2, 6, 2), 10, 6),
      maxCount: 10,
      slash: BOOL(o.slash, base.slash),
      slashStake: INT(o.slashStake, 1, 5, 2),
      stake: INT(o.stake, 1, 5, 1),
      openLoserLoses: BOOL(o.openLoserLoses, base.openLoserLoses),
      autoInfer: BOOL(o.autoInfer, true),
    };
    // face1 套里这几个字段不是自由度：强置，避免自定义套改出「喊 1 为斋 + 首喊斋」的怪状态。
    if (out.zhaiMode === 'face1') {
      out.breakMultiplier = 0; out.faceFree = false; out.lockFace = true; out.firstZhai = false;
      out.openLoserLoses = true;   // 经典套必须保持双向零和
    }
    return out;
  }

  function byId(id, customs) {
    if (BUILTIN[id]) return normalize(BUILTIN[id]);
    const c = (customs || []).find(x => x && x.id === id);
    return c ? normalize(c) : null;
  }
  function allRules(customs) {
    return BUILTIN_LIST.map(x => normalize(x)).concat((customs || []).map(normalize));
  }

  // 稳定短哈希：写进 run 清单与 calls.jsonl，用于把结论归因到具体规则配置。
  function hash(rules) {
    const r = normalize(rules);
    const s = [r.id, r.zhaiMode, r.halfDivisor, r.faceFree, r.lockFace, r.breakMultiplier,
      r.breakRestoresWild, r.firstFace1, r.firstMin, r.firstMax, r.slash, r.slashStake, r.stake, r.autoInfer].join('|')
      // firstZhai / openLoserLoses 只在 half 套里才有意义；这样内置 classic 的指纹不因新增参数而漂移。
      + (r.zhaiMode === 'half' ? '|fz=' + r.firstZhai + '|oll=' + (r.openLoserLoses ? 1 : 0) : '')
      // 计分从"积分制"改成"血量制"（输家掉血、归零判负）：输赢口径变了，新旧数据不可比，指纹必须分开。
      + '|hp=1'
      // 破斋语义版本 bv=3：门槛改为「两倍 + 1」（旧：至少翻倍 + 须超斋前那一手）。
      + (r.zhaiMode === 'half' && r.breakMultiplier ? '|bv=3|bp=' + r.breakPlus : '')
      + (r.zhaiMode === 'half' ? '|mn=' + r.minCount : '')
      // 合法动作集合修正（个数不变可以换到点数 1）：合法集变了，指纹必须分开。
      + (r.zhaiMode === 'half' ? '|sv=2' : '')
      // 不许重复喊本轮已出现过的同一手（转斋取半会绕回老价位）：合法集与提示词一起变了。
      // 只对 half 套有意义——经典套本来就严格递增，喊不出重复的一手。
      + (r.zhaiMode === 'half' ? '|nr=1|f1z=1' : '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function describe(r) {
    r = normalize(r);
    const bits = [];
    if (r.zhaiMode === 'half') {
      bits.push('取半转斋(÷' + r.halfDivisor + (r.faceFree ? '·点数任意' : '·只喊1') + ')');
      if (r.breakMultiplier) bits.push('×' + r.breakMultiplier + (r.breakPlus ? '+' + r.breakPlus : '') + '破斋');
      bits.push(r.lockFace ? '斋内锁点数' : '斋内同普通规则');
      if (r.firstZhai) bits.push('首喊可斋');
    } else bits.push('喊1为斋·锁点数');
    if (r.slash) bits.push('劈±' + r.slashStake);
    bits.push('开盅扣输家 ' + r.stake + ' 血' + (r.openLoserLoses ? '·赢家回血' : '·赢家不回'));
    return bits.join(' · ');
  }

  /* 给模型看的规则文本。经典套返回 null —— context.js 会改用逐字未动的 RULES_TPL，
   * 保证提示词指纹与历史 run 完全一致。其它套按参数生成，自定义套改了参数规则就跟着变。 */
  function rulesText(raw) {
    const r = normalize(raw);
    if (r.builtin && r.id === 'classic') return null;   // 经典套走 context.js 的逐字文本，指纹不变
    const L = ['大话骰规则（本桌）：两人各 5 颗骰子，全场 10 颗，你只看自己的 5 颗。'];
    L.push('- 喊价「n 个 m」＝ 全场至少有 n 颗点数是 m。点数大小 2 < 3 < 4 < 5 < 6 < 1。');
    L.push('- 未斋：1 算万能，凑任何点数（除 1）时 1 都顶一个。斋：1 不算万能，只数真的 1。');
    L.push('- 喊点数 1 就是进斋：这一手起本轮就是斋，1 不再万能（不用另外写「斋」）。');
    L.push('- 每手个数不得少于 ' + r.minCount + ' 个。');
    L.push('- 抬价两种：个数加得更多（点数任意换）；或个数不变、点数换成更大的。');
    L.push('- 本轮已经喊过的「X 个 Y」不能原样再喊一遍。');

    if (r.zhaiMode === 'half') {
      L.push('- 转斋：个数改为上一手取半向上取整 ceil(n / ' + r.halfDivisor + ')，点数'
        + (r.faceFree ? ' 1~6 任选' : '只能是 1') + '，本轮从此进斋。这是唯一允许个数变小的喊价，也是不喊 1 就进斋的路子。'
        + '行动写「喊 X 个 Y 斋」'
        + (r.autoInfer ? '；漏写「斋」但个数正好是取半值，也按转斋算。' : '，不写「斋」就按普通抬价判。'));
      if (r.breakMultiplier) {
        L.push('- 破斋：个数要到当前的 ' + r.breakMultiplier + ' 倍'
          + (r.breakPlus ? '再加 ' + r.breakPlus : '') + '（当前 n 个就要 ' + r.breakMultiplier + 'n'
          + (r.breakPlus ? '+' + r.breakPlus : '') + ' 个），并写明「破斋」，才回到未斋；'
          + '点数只能 2~6（喊 1 会立刻又进斋）。个数够了却没写「破斋」，只是斋里的普通抬价。'
          + (r.breakRestoresWild ? '破斋这一手起 1 恢复万能。' : '')
          + '行动写「喊 X 个 Y 破斋」。');
      } else L.push('- 本桌不能破斋：进了斋，本轮剩下的喊价都在斋里。');
      if (r.lockFace) L.push('- 斋里只能加斋那一手的点数，不能换。');
    } else {
      L.push('- 有人喊到点数 1 即进入斋：此后 1 不算万能，且只能继续加 1 的个数（不能换点数）。');
    }

    L.push('- 首喊：个数 ' + r.firstMin + '~' + r.firstMax + '、点数 ' + (r.firstFace1 ? '1~6（喊 1 直接以斋开局）' : '2~6')
      + '；不能开盅' + (r.slash ? '、劈' : '') + '、破斋'
      + (r.zhaiMode === 'half' && r.firstZhai ? '。写「斋」可以直接以斋开局，不取半' : '，也不能转斋') + '。');
    L.push('- 开盅：质疑当前最高价并亮牌。够数 → 开的人输；不够 → 喊的人输。输家 −' + r.stake + ' 血'
      + (r.openLoserLoses ? '、赢家 +' + r.stake + ' 血（封顶）' : '、赢家不回血') + '。');
    if (r.slash) L.push('- 劈：和开盅同一次检验，但双向算账——赢家 +' + r.slashStake + ' 血（封顶）、输家 −' + r.slashStake + ' 血。行动写「劈」。');
    L.push('- 被检验的永远是当前最高价那一手：你抬价之后，对手开盅检验的就是你的价。');
    L.push('- 血量：双方各 {TARGET} 点起，谁先归零谁输掉整局。');
    L.push('- 上一轮输的人先喊，第一轮系统指定。');
    return L.join('\n');
  }

  return { CLASSIC, FLEX, BUILTIN, BUILTIN_LIST, normalize, byId, allRules, hash, describe, rulesText };
});
