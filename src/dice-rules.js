/* 自由文本解析、合法性校验与退化检测 —— Node 与浏览器共用的唯一实现（UMD）。
 * 合法性真值来自 dice-engine.js 的 legalActions（按局面里那份规则集），
 * 由 test-rules.js 全枚举锁定。checkLegal 的返回文本会直接回给模型，措辞保持稳定。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./dice-engine.js'));
  else root.DiceRules = factory(root.DiceEngine);
})(typeof self !== 'undefined' ? self : globalThis, function (E) {
  'use strict';
  const CN = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const toNum = t => (/^[0-9]+$/.test(t) ? +t : (CN[t] || NaN));
  const OPEN_RE = /开盅|开骰|开他|掀|质疑|不信|开(?=[。！!.，,\s]|$)/g;
  const SLASH_RE = /劈(?:盅|骰|开)?|反劈/g;
  const BID_RE = /([0-9]{1,2}|[一二两三四五六七八九十])\s*个\s*([0-9]|[一二两三四五六])\s*(转斋|破斋|斋|飞)?/g;
  // 显式行动标记行（probe 臂用）。8k 长思考里常出现多个「N 个 M」，
  // 靠"取最后一个匹配"会误命中分析中的假想价；标记行让行动有唯一真源。
  // 尾部允许「斋 / 转斋 / 破斋 / 飞」标记（也可加括号），决定状态切换。
  const ACTION_MARK_RE = /^(?:行动|决断)\s*[:：]\s*(?:喊\s*([0-9]{1,2}|[一二两三四五六七八九十])\s*个\s*([0-9]|[一二两三四五六])\s*(.*)|(开盅|开|劈))\s*$/;
  const ACTION_LINE_RE = /^(?:(?:行动|决断)\s*[:：]\s*)?(?:喊\s*(?:\d+|[一二两三四五六七八九十]+)\s*个\s*(?:\d+|[一二两三四五六]+)\s*(?:转斋|破斋|斋|飞)?|开盅|开|劈)\s*[（(]?\s*(?:转斋|破斋|斋|飞)?\s*[）)]?\s*[。.!！]?$/;

  // 把尾部自由文本归一成动作模式：破斋优先判断（"破斋"里也含"斋"）。
  function markerMode(t) {
    const s = String(t || '').replace(/[（()）\s。.!！,，]/g, '');
    if (!s) return null;
    if (/破斋|飞|破/.test(s)) return 'breakZhai';
    if (/转斋|斋/.test(s)) return 'toZhai';
    return null;
  }
  // 括号标记预处理：把「（斋）」「（破斋）」折成裸标记，便于 BID_RE 捕获。
  function flat(t) {
    return String(t || '').replace(/[（(]\s*(转斋|破斋|斋|飞)\s*[）)]/g, '$1');
  }

  function parseAction(raw) {
    const t = flat(String(raw || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
    // 优先采信显式标记行；取最后一条，避免分析中偶尔写到「行动：」时抢跑
    let marked = null;
    for (const ln of t.split('\n')) {
      const mm = ACTION_MARK_RE.exec(ln.trim());
      if (mm) marked = {
        line: ln.trim(),
        count: mm[1] ? toNum(mm[1]) : null,
        face: mm[2] ? toNum(mm[2]) : null,
        mode: mm[1] ? markerMode(mm[3]) : null,
        slash: !mm[1] && mm[4] === '劈',
      };
    }
    if (marked) {
      return {
        action: marked.count == null
          ? { type: 'open', slash: !!marked.slash }
          : { type: 'bid', count: marked.count, face: marked.face, mode: marked.mode },
        ambiguous: false, text: marked.line, dropped: 0, marked: true,
      };
    }
    // 无标记行：回退到经典"取最后一个候选"，兼容 classic 臂、浏览器页与历史数据
    const cand = []; let m;
    BID_RE.lastIndex = 0;
    while ((m = BID_RE.exec(t))) cand.push({ pos: m.index, type: 'bid', count: toNum(m[1]), face: toNum(m[2]), mode: markerMode(m[3]), text: m[0] });
    OPEN_RE.lastIndex = 0;
    while ((m = OPEN_RE.exec(t))) cand.push({ pos: m.index, type: 'open', slash: false, text: m[0] });
    SLASH_RE.lastIndex = 0;
    while ((m = SLASH_RE.exec(t))) cand.push({ pos: m.index, type: 'open', slash: true, text: m[0] });
    // 回溯只看同一行：判断句（如"对手在诈。"）另起一行后不应污染行动行的解析
    const before = p => { const s = t.slice(Math.max(0, p - 6), p); const nl = s.lastIndexOf('\n'); return nl >= 0 ? s.slice(nl + 1) : s; };
    const pool = cand.filter(c => {
      const pre = before(c.pos);
      if (/对手|对方|上家|别人|它的|他的|其/.test(pre)) return false;
      if (c.type === 'open' && /[不别没勿]/.test(pre.slice(-2))) return false;
      return true;
    });
    if (!pool.length) return { action: null, ambiguous: false, text: '', dropped: cand.length };
    pool.sort((x, y) => x.pos - y.pos);
    const last = pool[pool.length - 1];
    return {
      action: last.type === 'open'
        ? { type: 'open', slash: !!last.slash }
        : { type: 'bid', count: last.count, face: last.face, mode: last.mode },
      ambiguous: pool.length > 1, text: last.text, dropped: cand.length - pool.length,
    };
  }

  // 合法性校验：只讲规则不讲策略。返回 null 表示合法，否则返回给模型的重写原因。
  // 真值仍由引擎的 legalActionSet 判定，这里只负责把常见错误翻译成稳定措辞。
  function checkLegal(r, a) {
    const R = E.rulesOf(r), p = r.bid;
    const norm = E.normalizeAction(r, a);
    const legal = E.legalActionSet(r);
    if (norm.type === 'open') {
      if (!p) return '本轮还没人喊过价，你是首喊，不能开盅，也不能劈。';
      if (norm.slash && !R.slash) return '本桌没有「劈」这一手；只能「开盅」，或继续喊价。';
      return legal.has(E.actionKey(norm)) ? null : '这一手不合法。';
    }
    const count = norm.count, face = norm.face;
    if (!(count >= 1 && count <= R.maxCount)) return '个数要在 1 到 ' + R.maxCount + ' 之间（全场一共 10 颗骰子）。';
    if (!(face >= 1 && face <= 6)) return '点数只能是 1 到 6。';
    if (norm.mode === 'toZhai') {
      if (R.zhaiMode !== 'half') return '本桌不支持转斋：这里只有喊点数 1 才叫斋。';
      if (!p) {
        if (!R.firstZhai) return '首喊不能转斋，先喊一个普通价。';
        // 首喊直接喊斋：没有上一手，不取半；个数/点数范围交给下面的首喊分支统一校验。
      } else {
        // 已在斋里的「斋」标记已被 normalizeAction 折成普通抬价，这里只处理真正的转斋。
        const zc = E.zhaiCount(r);
        if (count !== zc) return '转斋的个数必须取上一手 ' + p.count + ' 个的一半向上取整，也就是 ' + zc + ' 个。';
        if (!R.faceFree && face !== 1) return '本桌转斋时点数只能喊 1。';
      }
    } else if (norm.mode === 'breakZhai') {
      if (R.zhaiMode !== 'half' || !R.breakMultiplier) return '本桌不允许破斋。';
      if (!r.zhai) return '本轮还没进斋，谈不上破斋。';
      const bc = E.breakCount(r);
      if (bc == null) return '翻倍后会超过 10 颗，这一手破不了斋。';
      if (count !== bc) return '破斋的个数必须是当前 ' + p.count + ' 个的 ' + R.breakMultiplier + ' 倍，也就是 ' + bc + ' 个。';
      const bf = E.breakFaces(r);
      if (bf && bf.indexOf(face) < 0) {
        const pre = r.preZhai;
        if (pre && bc === pre.count) return '破斋翻倍后和斋前那一手（' + pre.count + ' 个 ' + pre.face + '）一样多，点数就必须比 ' + pre.face
          + ' 更大（顺序 2<3<4<5<6<1）；否则转斋再破斋能把价越喊越低，无限循环。';
        return '破斋这一手还必须严格大于斋前那一手' + (pre ? '（' + pre.count + ' 个 ' + pre.face + '）' : '') + '，翻倍到 ' + bc + ' 个超不过它，破不了斋。';
      }
    }
    if (!p) {
      if (count < R.firstMin) return '首喊个数至少 ' + R.firstMin + ' 个。';
      if (count > R.firstMax) return '本桌规矩：首喊个数最多 ' + R.firstMax + ' 个。';
      if (!R.firstFace1 && face === 1) return '首喊不能喊 1。';
      return legal.has(E.actionKey(norm)) ? null : '这一手不是本桌的合法首喊。';
    }
    if (R.zhaiMode === 'face1' && p.face === 1 && !(count > p.count && face === 1))
      return '上一手喊的是 1（斋），之后只能继续加 1 的个数。';
    if (legal.has(E.actionKey(norm))) return null;
    if (norm.mode === 'normal') {
      if (count < p.count) return '个数不能比上一手少（上一手是 ' + p.count + ' 个）；要多就加到 ' + (p.count + 1)
        + ' 个或更多（可以一次跳加）'
        + (R.zhaiMode === 'half' && !r.zhai ? '；想转斋则喊 ' + E.zhaiCount(r) + ' 个并写上「斋」' : '') + '。';
      if (count === p.count && R.zhaiMode === 'half' && r.zhai && R.lockFace)
        return '斋内不能换点数，只能继续加 ' + p.face + ' 的个数。';
      if (count === p.count) return '个数没变，点数就得换成比 ' + p.face + ' 更大的（顺序 2<3<4<5<6<1）。';
      return '这一手不合法：按本桌规则抬价（加个数、或个数不变换更大点数）。';
    }
    return '这一手不合法：按本桌规则给出行动。';
  }

  // 引擎视角的合法动作集合（真值）。applyBid 也应以此为准。
  function legalActionSet(round) { return E.legalActionSet(round); }
  // 与 legalActionSet 同一口径的动作主键：传 round 时会做「漏写标记按个数自动推断」的归一，
  // 否则只按动作里显式写的 mode 取键。
  function actionKey(a, round) { return E.actionKey(E.normalizeAction(round || { bid: null, zhai: false }, a)); }

  // 退化回声检测：照抄局面提示开头然后 EOS，没有判断内容。
  function isPromptEcho(content, userText) {
    const c = String(content || '').trim();
    if (!c) return false;
    if (/^【第\s*\d+\s*轮开始】/.test(c)) return true;
    const head = c.slice(0, 24);
    return head.length >= 16 && String(userText || '').includes(head);
  }

  // 从模型完整输出里抽出判断句（去掉纯行动行）
  function extractJudgment(content) {
    const lines = String(content || '').split('\n').map(s => s.trim()).filter(Boolean);
    const j = lines.filter(s => !ACTION_LINE_RE.test(s));
    return j.join(' ').trim();
  }

  return { parseAction, checkLegal, legalActionSet, actionKey, isPromptEcho, extractJudgment,
           ACTION_LINE_RE, ACTION_MARK_RE, markerMode };
});
