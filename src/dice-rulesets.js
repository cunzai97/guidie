/* 鬼骰 · 规则集（UMD，浏览器与 Node 共用）
 * 规则不再是写死的一段文本，而是一份可切换、可自定义的配置。
 * 单一真源：引擎合法性 / 行动解析 / 给模型看的规则文本都从这里取参数。
 *
 * 两套内置：
 *   classic —— 原来的规则，逐字保留（点数 1 = 斋、锁死点数、无转斋/破斋/劈），历史 run 可比。
 *   flex    —— 新规则：取半向上取整转斋（点数任意）、斋内同普通规则抬价、
 *              翻倍个数破斋（1 恢复万能，且须大于斋前一手）、劈（双向结算 ±1）；开盅只赢家加分。
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
    breakRestoresWild: true,// 破斋后 1 恢复万能
    firstFace1: false,      // 首喊能否喊点数 1
    firstZhai: false,       // 首喊能否直接喊斋（开局就关掉万能 1）
    firstMin: 2, firstMax: 6,
    maxCount: 10,           // 全场 10 颗，固定不许改
    slash: false,           // 「劈」
    slashStake: 2,          // 劈的积分（零和）
    stake: 1,               // 普通开盅的积分
    openLoserLoses: true,   // 开盅是否双向零和（true=输家也扣分；false=只有赢家得分）
    autoInfer: true,        // 漏写标记时按个数自动识别转斋 / 破斋
  };

  // 新套：用户 2026-11-09 定稿（点数全自由 / 首喊可斋 / 翻倍破斋 / 开盅赢家+1·劈±1）。
  const FLEX = {
    id: 'flex', name: '鬼骰新规 · 取半转斋 / 翻倍破斋 / 劈', builtin: true,
    zhaiMode: 'half', halfDivisor: 2, faceFree: true, lockFace: false,
    breakMultiplier: 2, breakRestoresWild: true,
    breakMustExceed: true,  // 破斋还须严格大于斋前一手；不给关掉它的自由度，否则转斋→破斋可压价死循环
    firstFace1: false, firstZhai: true, firstMin: 2, firstMax: 6, maxCount: 10,
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
      breakRestoresWild: BOOL(o.breakRestoresWild, base.breakRestoresWild),
      breakMustExceed: true,   // half 套强制开：这是漏洞修复不是可选参数（同 maxCount 固定 10）
      firstFace1: BOOL(o.firstFace1, base.firstFace1),
      firstZhai: BOOL(o.firstZhai, base.firstZhai),
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
      out.breakMustExceed = false; out.openLoserLoses = true;   // 经典套必须保持双向零和
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
      // firstZhai / breakMustExceed / openLoserLoses 只在 half 套里才有意义；这样内置 classic 的指纹不因新增参数而漂移。
      // breakMustExceed 入哈希是语义版本：破斋判定修过（须超斋前），新旧 flex 数据不可比，指纹必须分开。
      + (r.zhaiMode === 'half' ? '|fz=' + r.firstZhai + '|bme=' + (r.breakMustExceed ? 1 : 0) + '|oll=' + (r.openLoserLoses ? 1 : 0) : '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function describe(r) {
    r = normalize(r);
    const bits = [];
    if (r.zhaiMode === 'half') {
      bits.push('取半转斋(÷' + r.halfDivisor + (r.faceFree ? '·点数任意' : '·只喊1') + ')');
      if (r.breakMultiplier) bits.push('×' + r.breakMultiplier + '破斋' + (r.breakMustExceed ? '·须超斋前' : ''));
      bits.push(r.lockFace ? '斋内锁点数' : '斋内同普通规则');
      if (r.firstZhai) bits.push('首喊可斋');
    } else bits.push('喊1为斋·锁点数');
    if (r.slash) bits.push('劈±' + r.slashStake);
    bits.push('开盅+' + r.stake + (r.openLoserLoses ? '/−' + r.stake : '·输家不扣'));
    return bits.join(' · ');
  }

  /* 给模型看的规则文本。经典套返回 null —— context.js 会改用逐字未动的 RULES_TPL，
   * 保证提示词指纹与历史 run 完全一致。其它套按参数生成，自定义套改了参数规则就跟着变。 */
  function rulesText(raw) {
    const r = normalize(raw);
    if (r.builtin && r.id === 'classic') return null;
    const L = ['大话骰规则（两人对决，本桌采用这一套）：'];
    L.push('- 每人一个骰盅、5 颗骰子，全场共 10 颗。每轮开始两人各自摇骰；你只能看见自己的 5 颗，看不见对手的 5 颗。');
    L.push('- 两人轮流喊价，喊价形如"n 个 m"，意思是：全场 10 颗骰子里，点数 m 至少有 n 个。');
    L.push('- 点数大小顺序：2 < 3 < 4 < 5 < 6 < 1。');
    L.push('- 本轮有一个"斋"状态，开局为"未斋"。未斋时 1 是万能牌：凑任意点数 m（m≠1）的个数时，全场任意一颗 1 都算作 m，你自己的和对手的都算；喊点数 1 时只数真实的 1。斋状态下 1 不再万能，任何点数都只数真实的该点数。');

    if (r.zhaiMode === 'half') {
      const c = '取半向上取整：把当前最高价的个数 n 换成 ceil(n / ' + r.halfDivisor + ')';
      L.push('- 转斋（从"未斋"进入"斋"）：轮到你时，可以不抬价而改喊"斋"——个数按' + c
        + '，点数' + (r.faceFree ? ' 1~6 任意选，不必喊 1' : '只能喊 1')
        + '。这是全场唯一允许个数变小的喊价；喊出这一手后本轮进入斋状态，1 不再万能。'
        + '行动行写「行动：喊 X 个 Y 斋」。'
        + '已经在斋里时，普通抬价写不写「斋」都按普通抬价处理（写「斋」不会被当成转斋）。'
        + (r.autoInfer ? '漏写「斋」但个数正好等于取半值时，也按转斋处理。' : '必须写出「斋」字，否则按普通喊价判非法。')
        + (r.firstZhai ? ' 首喊是唯一例外：开局第一手也能直接喊斋，且不用取半，见下面「首喊」那一条。' : ''));
      if (r.breakMultiplier) {
        L.push('- 破斋（从"斋"回到"未斋"）：斋状态下，喊出个数正好等于当前个数 × ' + r.breakMultiplier
          + ' 的一手，且这一手严格大于斋前那一手（转斋前的最高价：个数更多，或个数相同但点数更大），才能破斋。'
          + '只翻倍、不超过斋前一手是非法的——否则转斋再破斋就能把价越喊越低、无限循环。破斋这一手起 1 '
          + (r.breakRestoresWild ? '恢复万能' : '仍不算万能')
          + '。行动行写「行动：喊 X 个 Y 破斋」。'
          + (r.autoInfer ? '漏写「破斋」但个数正好等于翻倍值时，也按破斋处理；翻倍这一手固定算破斋，不再算留在斋里的普通抬价。' : '必须写出「破斋」二字。')
          + (r.firstZhai ? '首喊直接喊斋的那一轮没有斋前一手，翻倍即可破斋，不受这条限制。' : ''));
      } else L.push('- 本桌不允许破斋：一旦进入斋，本轮剩余喊价都在斋状态内。');
      L.push('- 除上面两种状态切换外，任何一手新喊价都必须严格大于上一手：①把个数加得比上一手多（加几个都行，可一次跳加好几个，此时点数 1~6 任意换）；②个数不变、点数换成更大的（按 2<3<4<5<6<1）。'
        + (r.lockFace ? '斋内例外：只能继续加斋那一手点数的个数，不能换点数。' : '斋内同样适用这两条，唯一区别是 1 始终不算万能。'));
    } else {
      L.push('- 一旦有人喊到点数 1（称为"斋"）：从这一手起 1 不再万能，且之后只能继续加 1 的个数（不能换别的点数）。');
      L.push('- 新喊价必须严格大于上一手，两种方式之一：①把个数加得比上一手多——加几个都行，可以一次跳加好几个（此时点数 2~6 可任意换，也可喊 1 转斋）；②个数不变、点数换成更大的（按 2<3<4<5<6<1）。');
    }

    L.push('- 首喊（本轮第一手）：个数只能 ' + r.firstMin + '~' + r.firstMax
      + '、点数只能 ' + (r.firstFace1 ? '1~6' : '2~6') + '，不能开盅' + (r.slash ? '、不能劈' : '')
      + '，也不能破斋'
      + (r.zhaiMode === 'half' && r.firstZhai ? '；但可以直接喊斋（见下一条）' : '或转斋') + '。');
    if (r.zhaiMode === 'half' && r.firstZhai) {
      L.push('- 首喊也可以直接喊斋：仍按上一条的个数与点数选一手，在末尾写上「斋」即可（行动行「行动：喊 X 个 Y 斋」）。'
        + '首喊没有上一手，所以不需要取半；但这一手起本轮就是斋状态，1 不再万能，对手照样可以用翻倍个数破斋把 1 变回万能。');
    }
    L.push('- 轮到你时，你可以喊价，也可以不喊而改为"开盅"。开盅就是质疑此刻全场最新的那一手喊价（也就是当前最高价），本轮随即结束、双方亮牌结算。');
    if (r.slash) L.push('- 你也可以改为「劈」：劈和开盅完全一样（质疑同一手、同样亮牌结算），区别是双向结算——赢家 +' + r.slashStake + ' 分、输家 −' + r.slashStake + ' 分'
      + (r.openLoserLoses ? '' : '（开盅时输家不扣分，劈是唯一让对手掉分的手段）')
      + '。行动行写「行动：劈」。');
    L.push('- 被质疑、被检验的只有"开盅或劈之前最近的一手"，更早的喊价一概不参与结算。轮到你时，那一手是对手刚喊的；但只要你抬出一手新价，最新一手就换成你喊的——此后对手开盅或劈，被检验的就是你这一手，输赢也按你这一手算。');
    L.push('- 结算：亮出全场 10 颗，只数被质疑那一手喊的"n 个 m"里点数 m 的个数（该手未斋且 m≠1 时 1 也算 m，双方都算；该手在斋状态下 1 不算 m）。够 n 个或更多 → 喊价成立，开盅/劈的一方输、喊那一手的人赢；不足 n 个 → 喊价不成立，喊那一手的人输、开盅/劈的一方赢。');
    L.push('- 每轮结算积分：开盅时赢家 +' + r.stake + ' 分' + (r.openLoserLoses ? '、输家 −' + r.stake + ' 分' : '、输家不扣分')
      + (r.slash ? '；劈时赢家 +' + r.slashStake + ' 分、输家 −' + r.slashStake + ' 分' : '')
      + '。率先达到 +{TARGET} 分者赢下整个对局。');
    L.push('- 每轮由上一轮输的人先喊；第一轮由系统指定。');
    return L.join('\n');
  }

  return { CLASSIC, FLEX, BUILTIN, BUILTIN_LIST, normalize, byId, allRules, hash, describe, rulesText };
});
