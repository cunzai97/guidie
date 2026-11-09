/* LLM 玩家：OpenAI 兼容 chat/completions（非流式，无头跑批更简单）。
 * 提示词两臂（cfg.prompt）：'classic' 逐字保持原版；'probe' 为轻量引导臂（见 context.js）。
 * 输出预算默认 8192：reasoning 长的模型不该因为"想得久"被判负。截断时保留未完思考并续写催决断。
 * 归因原则：解析→规则校验→有限重写（最多 maxAsks 次）；仍给不出合法动作就判负，
 * 绝不让 harness 替模型走棋。连接级错误单独退避重试，不计入"模型答错"。
 *
 * 上下文三种模式（cfg.context）：
 *  - 'chat'（默认）：持久多轮对话。系统提示固定一次，之后每回合只追加"新发生的事+当前局面"，
 *    模型真实给出的判断/行动留在 assistant 历史里 → 模型看到完整局史 + 自己的完整思考链，前缀稳定可复用 KV cache。
 *    重试脚手架（回声/非法手/截断）不入持久历史，避免一次退化输出被逐手放大。
 *  - 'memory'：追加式摘要链。系统提示 + 过往记忆笔记链（backbone，append-only）+ 本轮逐字工作记忆（working）。
 *    轮内增量渲染事实；轮末 runner 调 summarize()，模型看本轮完整过程+双方亮牌写一段复盘反思并入 backbone、清空 working。
 *    跨轮只携带模型自写的压缩笔记（不堆逐字局史）→ 上下文有界；笔记保真度由 harness 另拿真值对照测量。
 *  - 'snapshot'：每回合重建一份窗口快照（旧行为），作为可对比的臂。
 * 每局开始 runner 会调用 reset() 清空对话，避免跨局串味。
 */
const C = require('./context.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 清理记忆笔记里的聊天模板伪影：thinking=off 时模型偶发吐出残留 </think> 并把整条笔记原样重复一遍
// （实测 5/24 条呈 A</think>\n\nA）。这是模板噪声而非模型判断，折叠重复保留单份，避免 backbone 被翻倍污染、
// 抵消压缩收益。只删标签与机械重复，不改写笔记内容本身（不替模型补充/删减任何所学）。
function cleanNote(raw) {
  let t = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // 成对思考块
    .replace(/<\/?think>/gi, '')                  // 残留单边标签
    .trim();
  const re = /\n\n/g; let m;                      // 整条笔记被原样重复（A\n\nA）→ 折叠成一份
  while ((m = re.exec(t))) {
    const a = t.slice(0, m.index).trim(), b = t.slice(m.index + 2).trim();
    if (a && a === b) { t = a; break; }
  }
  return t;
}

// 重试提示。截断（finish=length）时绝不能说"请简短"——那会直接压掉推理；
// 正确做法是把未完思考留在上下文里，让模型接着想完并立即决断，仍失败才收敛成只输出行动行。
// finish=length 且末行没有完整行动行 ⇒ 视为"想完但还没决断"。
// 8k 长输出里常有假想价（"如果对手喊 3 个 6…"），照常取最后一个候选会把分析里的价当成行动。
// 只有显式标记行、或末行本身就是纯行动行，才在截断时采信。
function unfinished(out, parsed) {
  if (out.finish !== 'length') return false;
  if (parsed.action && parsed.marked) return false;
  const lines = String(out.content || '').split('\n').map(s => s.trim()).filter(Boolean);
  return !C.ACTION_LINE_RE.test(lines[lines.length - 1] || '');
}

function retryMessage(out, echo, ask, variant, rules) {
  const R = require('./dice-rulesets.js').normalize(rules || 'classic');
  const flex = R.zhaiMode === 'half' || R.slash;
  const base = variant === 'probe'
    ? '「行动：喊 X 个 Y」或「行动：开盅」'
    : '「喊 X 个 Y」或「开盅」';
  const act = flex
    ? base + (variant === 'probe'
        ? '（转斋写「行动：喊 X 个 Y 斋」、破斋写「行动：喊 X 个 Y 破斋」、劈写「行动：劈」）'
        : '（转斋写「喊 X 个 Y 斋」、破斋写「喊 X 个 Y 破斋」、劈写「劈」）')
    : base;
  if (out.finish === 'length') {
    return ask === 1
      ? '你刚才的思考在给出决断前被截断了，上一条消息保留着你的原始思路。请接着它往下想完，立即对这一手做出决断：不要从头重来，也不要只写分析；把结论写成最后一行 ' + act + '。'
      : '立即决断：只输出最后一行 ' + act + '，不要任何分析。';
  }
  if (echo) return '你上一次的回答只是复述了局面提示。请按你自己的判断重新给出这一手的行动，最后一行写 ' + act + '。';
  return '你上一次的回答没有给出可执行的行动。请给出这一手的决断，最后一行写 ' + act + '。';
}

function makeLLMPlayer(cfg, log = () => {}) {
  const {
    name, baseUrl, model, apiKey = null,
    thinking = false, effort = (cfg.thinking ? 'high' : 'off'), maxTokens = 8192, temperature = 0.7,
    timeoutMs = 300000, connRetries = 4, maxAsks = 3, coach = false,
    context = 'chat', prompt = 'classic', rules = 'classic',
  } = cfg;
  const RS = require('./dice-rulesets.js');
  const RULE = RS.normalize(rules);

  // 持久对话状态（每局 reset）
  let messages = [];        // chat 模式：[{role, content}]，含 system；只存局面事件+真实判断，重试脚手架不入史
  let backbone = [];        // memory 模式：append-only 记忆笔记链 [user 标记, assistant 笔记, ...]，不含 system
  let working = [];         // memory 模式：本轮逐字工作记忆 [user 局面, assistant 判断, ...]，轮末清空
  let cursor = null;        // buildTurn 的进度游标
  let sys = null;
  let callKey = {};         // 当前调用的事件主键，由 runner 经 decide/summarize 注入

  function reset() { messages = []; backbone = []; working = []; cursor = null; sys = null; callKey = {}; }

  // 思考强度：off=不思考；low/medium/high=逐档加深。
  // 本地 llama-server 认 chat_template_kwargs.enable_thinking + thinking_budget；
  // 远程网关多数认 OpenAI 风格的 reasoning_effort。两套参数都发，端点不认的字段会自行忽略。
  function applyEffort(body) {
    const e = String(effort || 'off').toLowerCase();
    if (e === 'off') {
      if (cfg.thinkingKwargs !== false) body.chat_template_kwargs = { enable_thinking: !!thinking };
      return body;
    }
    if (cfg.thinkingKwargs !== false) {
      const budget = { low: 1024, medium: 4096, high: 12288 }[e] || 4096;
      body.chat_template_kwargs = { enable_thinking: true, thinking_budget: budget };
    }
    body.reasoning_effort = (e === 'low' || e === 'medium' || e === 'high') ? e : 'medium';
    return body;
  }

  async function callMessages(msgs, phase = 'play') {
    const body = applyEffort({ model, messages: msgs, max_tokens: maxTokens, temperature, stream: false });
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    let lastErr = null;
    for (let i = 0; i <= connRetries; i++) {
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', headers,
          body: JSON.stringify(body), signal: ctl.signal,
        });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
        const ch = (j.choices || [{}])[0];
        const msg = ch.message || {};
        const u = j.usage || {};
        const out = {
          content: msg.content || '', reasonChars: (msg.reasoning_content || '').length,
          finish: ch.finish_reason || null, completionTokens: u.completion_tokens || null,
          promptTokens: u.prompt_tokens || null,
          cachedTokens: u.cached_tokens || (u.prompt_tokens_details ? u.prompt_tokens_details.cached_tokens : null) || null,
          ms: Date.now() - t0,
        };
        const lastUser = [...msgs].reverse().find(m => m.role === 'user');
        log({ kind: 'call', name, model, thinking, effort, ruleset: RULE.id, maxTokens, context, phase, ...callKey,
              sys: msgs[0] ? msgs[0].content : '', user: lastUser ? lastUser.content : '', turns: msgs.length, ...out });
        return out;
      } catch (e) {
        lastErr = e;
        log({ kind: 'conn-error', name, attempt: i + 1, ...callKey, error: String(e).slice(0, 200), ms: Date.now() - t0 });
        if (i < connRetries) await sleep(2000 * (i + 1));
      } finally {
        // 连接失败/超时分支也必须清掉定时器，否则默认 300s 的句柄会一直挂住进程
        clearTimeout(timer);
      }
    }
    throw new Error(`连接失败（已重试 ${connRetries} 次）: ${lastErr}`);
  }

  // 持久对话模式：复用前文，模型掌握完整局史与自身思考链。
  // 关键：持久历史只保留"局面事件 + 模型真实给出的判断/行动"。重试脚手架（退化回声、非法手、
  // 截断）只在临时副本 work 上堆叠供当回合纠正，绝不写入 messages——否则一次随机回声会被持久
  // 上下文逐手照抄，放大成整局判负（实测：game2 一次回声 → 5 轮连判）。判负也只留一条中性记录。
  async function decideChat(match, who) {
    if (!sys) { sys = C.buildSystem(match.roundTarget, { coach, variant: prompt, rules: RULE }); messages.push({ role: 'system', content: sys }); }
    const turn = C.buildTurn(match, who, cursor, { variant: prompt, rules: RULE });
    cursor = turn.next;
    messages.push({ role: 'user', content: turn.text });   // 局面事件入史
    const attempts = [];
    let work = messages.slice();                            // 当回合重试的临时副本
    for (let ask = 1; ask <= maxAsks; ask++) {
      callKey = { ...callKey, ask };        // 每次重写都是独立一步，落盘主键带 ask
      let out;
      try { out = await callMessages(work); }
      catch (e) { return { type: 'error', error: String(e), attempts }; }  // 连接彻底失败：未评，不算模型输
      const promptNow = work.length ? work[work.length - 1].content : turn.text;   // 模型这一手实际看到的最后一条用户消息
      const echo = C.isPromptEcho(out.content, promptNow);
      const parsed = echo ? { action: null, text: '' } : C.parseAction(out.content);   // 回声先拦截：避免提示里的"开始/开盅"被误解析成行动
      attempts.push({ ask, raw: out.content, finish: out.finish, parsed: parsed.action, echo, ms: out.ms, reasonChars: out.reasonChars,
                      promptTokens: out.promptTokens, completionTokens: out.completionTokens, cachedTokens: out.cachedTokens, ambiguous: parsed.ambiguous });
      if (parsed.action && !unfinished(out, parsed)) {
        const why = C.checkLegal(match.round, parsed.action);
        if (!why) {
          messages.push({ role: 'assistant', content: out.content });   // 只把真实判断+行动入史
          return { ...parsed.action, attempts, asks: ask, judgment: C.extractJudgment(out.content) };
        }
        work.push({ role: 'assistant', content: out.content });
        work.push({ role: 'user', content: '你上次的行动「' + (parsed.text || '') + '」不合规则：' + why + '\n请重新给出一个合法行动。' });
        continue;
      }
      // 无合法行动：回声用中性标记替换（不让模型照抄上一手的退化模式），其余保留原文供纠正。
      // finish_reason=length 且没解析出行动 → 静默截断，显式当作无效重写。
      // 截断时完整保留未完思考（不能换成中性标记），供模型接着想完
      work.push({ role: 'assistant', content: out.finish === 'length' ? out.content : (echo ? '（输出无效：复述了局面提示，没有给出行动）' : out.content) });
      work.push({ role: 'user', content: retryMessage(out, echo, ask, prompt, RULE) });
    }
    // 有限重写后仍非法 → 判负（harness 不替它走棋）；持久历史只留中性判负记录，不留回声。
    messages.push({ role: 'assistant', content: '（本回合我未能给出合法行动，判负。）' });
    return { type: 'forfeit', attempts, asks: maxAsks, judgment: '' };
  }

  // 摘要链模式：轮内逐字工作记忆（working）+ 跨轮压缩笔记链（backbone）。重试脚手架同样不入 working。
  async function decideMemory(match, who) {
    if (!sys) sys = C.buildSystem(match.roundTarget, { coach, variant: prompt, rules: RULE });
    const turn = C.buildTurn(match, who, cursor, { noHistory: true, variant: prompt, rules: RULE });   // 逐字局史由 backbone 笔记携带，不在此堆积
    cursor = turn.next;
    working.push({ role: 'user', content: turn.text });
    const base = [{ role: 'system', content: sys }, ...backbone, ...working];
    const attempts = [];
    let work = base.slice();
    for (let ask = 1; ask <= maxAsks; ask++) {
      callKey = { ...callKey, ask };        // 每次重写都是独立一步，落盘主键带 ask
      let out;
      try { out = await callMessages(work, 'play'); }
      catch (e) { return { type: 'error', error: String(e), attempts }; }
      const promptNow = work.length ? work[work.length - 1].content : turn.text;
      const echo = C.isPromptEcho(out.content, promptNow);
      const parsed = echo ? { action: null, text: '' } : C.parseAction(out.content);
      attempts.push({ ask, raw: out.content, finish: out.finish, parsed: parsed.action, echo, ms: out.ms, reasonChars: out.reasonChars,
                      promptTokens: out.promptTokens, completionTokens: out.completionTokens, cachedTokens: out.cachedTokens, ambiguous: parsed.ambiguous });
      if (parsed.action && !unfinished(out, parsed)) {
        const why = C.checkLegal(match.round, parsed.action);
        if (!why) {
          working.push({ role: 'assistant', content: out.content });   // 只把真实判断入工作记忆
          return { ...parsed.action, attempts, asks: ask, judgment: C.extractJudgment(out.content) };
        }
        work.push({ role: 'assistant', content: out.content });
        work.push({ role: 'user', content: '你上次的行动「' + (parsed.text || '') + '」不合规则：' + why + '\n请重新给出一个合法行动。' });
        continue;
      }
      // 截断时完整保留未完思考（不能换成中性标记），供模型接着想完
      work.push({ role: 'assistant', content: out.finish === 'length' ? out.content : (echo ? '（输出无效：复述了局面提示，没有给出行动）' : out.content) });
      work.push({ role: 'user', content: retryMessage(out, echo, ask, prompt, RULE) });
    }
    working.push({ role: 'assistant', content: '（本回合我未能给出合法行动，判负。）' });
    return { type: 'forfeit', attempts, asks: maxAsks, judgment: '' };
  }

  // 轮末复盘：模型看本轮完整喊价过程 + 双方真实亮牌 + 结算，自主写一段复盘总结（内容/方向由模型自定，harness 不预设）
  // 并入 backbone，然后清空 working。含真值的复盘提示只在此刻短暂存在；持久链里只留最小轮次标记 + 模型复盘总结
  // （纯压缩，真值由 harness 另存供保真度对照）。
  async function summarize(match, who, result, meta) {
    if (meta) callKey = { ...meta };
    if (!sys) sys = C.buildSystem(match.roundTarget, { coach, variant: prompt, rules: RULE });
    const roundNo = match.roundNo;
    const summaryPrompt = C.buildSummaryPrompt(match, who, result, { variant: prompt, rules: RULE });
    let work = [{ role: 'system', content: sys }, ...backbone, ...working, { role: 'user', content: summaryPrompt }];
    let note = '';
    for (let ask = 1; ask <= maxAsks; ask++) {
      callKey = { ...callKey, ask };        // 每次重写都是独立一步，落盘主键带 ask
      let out;
      try { out = await callMessages(work, 'summary'); }
      catch (e) { break; }   // 总结连接失败不致命：本轮少一条笔记，下一轮照常（不影响比分归因）
      const echo = C.isPromptEcho(out.content, summaryPrompt);
      const text = cleanNote(out.content);
      if (!echo && text) { note = text; break; }
      work.push({ role: 'assistant', content: echo ? '（输出无效：复述了提示）' : out.content });
      work.push({ role: 'user', content: '请只写一段你自己的复盘总结，别复述提示。' });
    }
    if (!note) note = '（本轮未能形成复盘反思。）';
    backbone.push({ role: 'user', content: C.memoryMarker(roundNo) }, { role: 'assistant', content: note });
    working = [];          // 清空本轮逐字工作记忆
    cursor = null;         // 下一轮 buildTurn 视为新轮
  }

  // 快照模式（旧行为，对比臂）
  async function decideSnapshot(match, who, ownMemo) {
    const sysS = C.buildSystem(match.roundTarget, { coach, variant: prompt, rules: RULE });
    const uopts = { ownMemo: ownMemo || [], variant: prompt, rules: RULE };
    let user = C.buildUser(match, who, uopts);
    const attempts = [];
    for (let ask = 1; ask <= maxAsks; ask++) {
      callKey = { ...callKey, ask };        // 每次重写都是独立一步，落盘主键带 ask
      let out;
      try { out = await callMessages([{ role: 'system', content: sysS }, { role: 'user', content: user }]); }
      catch (e) { return { type: 'error', error: String(e), attempts }; }
      const parsed = C.parseAction(out.content);
      attempts.push({ ask, raw: out.content, finish: out.finish, parsed: parsed.action, ms: out.ms, reasonChars: out.reasonChars,
                      promptTokens: out.promptTokens, completionTokens: out.completionTokens, cachedTokens: out.cachedTokens, ambiguous: parsed.ambiguous });
      if (!parsed.action || unfinished(out, parsed)) {
        // snapshot 每回合重建窗口；截断时把未完思考尾部拼回本回合窗口，同样实现"带原思考续写"
        const carry = out.finish === 'length'
          ? '\n\n【你上一次的思考在决断前被截断了，原文附在下面，请接着它想完】\n' + out.content.slice(-1200) + '\n【原文结束】\n'
          : '';
        user = C.buildUser(match, who, uopts) + carry + '\n\n' + retryMessage(out, false, ask, prompt, RULE);
        continue;
      }
      const why = C.checkLegal(match.round, parsed.action);
      if (!why) return { ...parsed.action, attempts, asks: ask, judgment: C.extractJudgment(out.content) };
      user = C.buildUser(match, who, uopts) + '\n\n你上次的行动「' + (parsed.text || '') + '」不合规则：' + why + '\n请重新给出一个合法行动。';
    }
    return { type: 'forfeit', attempts, asks: maxAsks, judgment: '' };
  }

  return {
    name, isLLM: true, model, context, reset,
    async decide(match, who, ownMemo, meta) {
      if (meta) callKey = { ...meta };        // runner 注入 { run_id, deal, swap, game, round, step, seat }
      if (context === 'snapshot') return decideSnapshot(match, who, ownMemo);
      if (context === 'memory') return decideMemory(match, who);
      return decideChat(match, who);
    },
    ...(context === 'memory' ? { summarize } : {}),   // 仅摘要链模式有轮末总结；runner 据此挂载
  };
}

module.exports = { makeLLMPlayer, cleanNote };