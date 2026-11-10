/* 上下文消息流（UMD）：CLI 的 llm.js 与竞技场 arena.js 共用这一份。
 *
 * 设计目标只有一个：**前缀永不回改，每手只追加**，让 llama.cpp / 任何前缀缓存都能命中。
 *
 * 消息骨架（一局之内）：
 *   [0] system            规则 + 赢的秘诀 —— 一局只写一次，之后任何操作都不碰
 *   [1] user 【第 N 轮复盘】        固定标题，只作 assistant 输出的锚点
 *   [2] assistant <复盘正文>       复盘是模型自己的输出，角色必须是 assistant
 *   ...
 *   [k] user 【本轮 · 第 M 手】     当前轮的逐手事实（只有这一手新发生的事）
 *   [k+1] assistant <这一手的回答>
 *
 * 四个生命周期：
 *   appendUser / appendAssistant  每一手追加，前缀不动 → 全命中
 *   finalizeRound(复盘)           删掉「当前轮」的逐手消息，追加一条复盘对
 *                                 （删的是尾部，历史前缀不受影响）
 *   applyReflection(反思)         整段历史被替换成「一条反思」：只剩 system + 反思
 *   compact()                     复盘总量到上下文 80% 时，把最老的复盘合并成一条
 *
 * 角色约定：复盘 / 反思 / 压缩摘要一律 assistant；它们前面的 user 消息只放固定措辞的标题，
 * 不承载指令内容，系统提示词里也不出现任何转述。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiceCtxLog = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // token 估算（无 tokenizer 时的工程近似）：CJK 约 1 token/字，其余约 4 字符/token。
  const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;
  function estTokens(txt) {
    const s = String(txt || '');
    const cjk = (s.match(CJK) || []).length;
    return cjk + (s.length - cjk) / 4;
  }

  const MARK_ROUND = n => '【第 ' + n + ' 轮复盘】';
  const MARK_REFLECT = '【连败反思 · 取代此前所有复盘】';
  const MARK_COMPACT = '【压缩摘要 · 早期轮次】';

  function create(opts) {
    opts = opts || {};
    const system = String(opts.system || '');
    const ctxLimit = Math.max(2048, +(opts.ctxLimit || 32768));      // 上下文窗口（token）
    const compactAt = opts.compactAt == null ? 0.8 : +opts.compactAt; // 80% 触发
    let hist = [];      // 已定稿：[{ kind:'round'|'reflect'|'compact', round, text }]
    let cur = [];       // 当前轮：逐手消息 [{ role, content }]
    let roundNo = 0;

    const msgs = () => {
      const out = [{ role: 'system', content: system }];
      for (const h of hist) {
        out.push({ role: 'user', content: h.kind === 'round' ? MARK_ROUND(h.round)
          : h.kind === 'reflect' ? MARK_REFLECT : MARK_COMPACT });
        out.push({ role: 'assistant', content: h.text });
      }
      for (const m of cur) out.push(m);
      return out;
    };
    const tokensOf = list => list.reduce((s, m) => s + estTokens(m.content) + 4, 0);

    const api = {
      // ---------- 读 ----------
      // 发给模型的消息（深拷贝，调用方随便改不影响内部状态）
      snapshot() { return msgs().map(m => ({ role: m.role, content: m.content })); },
      tokens() { return tokensOf(msgs()); },
      ctxLimit() { return ctxLimit; },
      round() { return roundNo; },
      // 前缀指纹：system + 已定稿历史。相邻两次相同 = 前缀没被动过（缓存可命中）。
      // 只对「已定稿」部分取哈希，当前轮的追加不影响它。
      prefixHash() {
        const pre = [{ role: 'system', content: system }];
        for (const h of hist) pre.push({ role: 'user', content: h.kind === 'round' ? MARK_ROUND(h.round) : h.kind === 'reflect' ? MARK_REFLECT : MARK_COMPACT },
          { role: 'assistant', content: h.text });
        const s = pre.map(m => m.role + '\u0000' + m.content).join('\u0001');
        let h1 = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0; }
        return ('0000000' + h1.toString(16)).slice(-8);
      },
      // 已定稿历史的 token 量（前缀部分），便于日志里对比「前缀有没有被重算」
      prefixTokens() { const list = api.snapshot(); return tokensOf(list.slice(0, list.length - cur.length)); },
      curTurns() { return cur.length; },
      historyRounds() { return hist.filter(h => h.kind === 'round').map(h => h.round); },

      // ---------- 写 ----------
      beginRound(n) { roundNo = n == null ? roundNo + 1 : n; return roundNo; },
      appendUser(text) { cur.push({ role: 'user', content: String(text || '') }); return api; },
      appendAssistant(text) { cur.push({ role: 'assistant', content: String(text || '') }); return api; },

      // 轮末：把当前轮的逐手消息换成一条复盘（模型自己的输出）
      finalizeRound(summaryText) {
        const text = String(summaryText || '').trim();
        cur = [];
        if (text) hist.push({ kind: 'round', round: roundNo, text });
        return api;
      },

      // 连败特殊反思：整段历史（含当前轮原文）被这一条取代 —— 下一轮只剩 system + 反思
      applyReflection(text) {
        const t = String(text || '').trim();
        hist = [];
        cur = [];
        if (t) hist.push({ kind: 'reflect', round: roundNo, text: t });
        return api;
      },
      // 手动清空（新开局）
      reset(n) { hist = []; cur = []; roundNo = n || 0; return api; },

      // 压缩：总量超过 80% 上下文时，把最老的复盘合并成一条（大动作、低频）
      compactIfNeeded() {
        if (tokensOf(msgs()) <= ctxLimit * compactAt) return null;
        const rounds = hist.filter(h => h.kind === 'round');
        if (rounds.length < 3) return null;                    // 轮数太少，合并没意义
        const keep = Math.ceil(rounds.length / 2);             // 留最近一半
        const drop = rounds.slice(0, rounds.length - keep);
        const kept = hist.filter(h => h.kind !== 'round' || drop.indexOf(h) < 0);
        const merged = drop.map(h => '第 ' + h.round + ' 轮：' + h.text).join('\n\n');
        const note = { kind: 'compact', round: drop[drop.length - 1].round, text: merged };
        hist = [note].concat(kept);
        return { merged: drop.length, keptRounds: keep, tokens: tokensOf(msgs()) };
      },
    };
    return api;
  }

  return { create, estTokens, MARK_ROUND, MARK_REFLECT, MARK_COMPACT };
});
