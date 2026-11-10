#!/usr/bin/env node
/* 理解力探针：把规则文本原样丢给模型，只问「这个游戏该怎么玩」，看模型是否真的读懂。
 * 不给输出格式、不给提示词臂、不给任何策略暗示——测的是规则理解，不是打得好不好。
 * 用法:
 *   node src/probe-understand.js --rules flex --hp 10 --models wb:minimax-m3.1-flash,llm:1235:avalon-iq3ks-256k
 * 输出: runs/understand-<runid>.jsonl（每条含完整回答，便于人工挑选错误），并打印全文。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RS = require('./dice-rulesets.js');
const C = require('./context.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function wbKey() {
  if (process.env.DICE_WB_KEY) return process.env.DICE_WB_KEY;
  const f = path.join(os.homedir(), 'work/wb-api/hub/accounts/settings.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const k = (d.api_keys || []).find(x => x && x.key && !x.deleted_at && x.enabled !== false);
  if (!k) throw new Error('没有可用的网关 api_key');
  return k.key;
}
const WB_BASE = process.env.DICE_WB_BASE || 'http://127.0.0.1:8791';

// 问法：只问怎么玩 + 请复述 + 允许指出规则里说不清的地方（照着念和真懂，差别就会露出来）
const QUESTION = `下面是大话骰的完整规则。请回答两件事：
1）用你自己的话把这个游戏怎么玩说清楚：一轮怎么运转、喊价的合法边界是什么、一轮怎么结束、怎么算赢下整局。
2）你觉得这份规则里有哪一处说得不严谨、可能被误解，或者你自己没把握？如果有，直接指出来。`;

// 追问卷：几个具体局面，答案唯一，用来验算它到底算不算懂了（不是难它，是验它）
const QUIZ = `下面是大话骰的完整规则。先读规则，然后只回答下面 5 个具体问题，每题一句话给出结论。

问题：
Q1. 本轮首喊，可以喊「1 个 3」吗？为什么？
Q2. 转斋前那一手是「6 个 3」，之后有人取半转斋喊「3 个 2 斋」。轮到你时，你现在处在斋（1 不算万能）还是未斋？
Q3. 接着 Q2 的局面：你喊「6 个 3 破斋」，合法吗？
Q4. 接着 Q2 的局面：你喊「6 个 4 破斋」，合法吗？
Q5. 接着 Q2 的局面：你喊「4 个 4」，什么都没写（没写斋、也没写破斋），这一手合法吗？喊完之后本轮是斋还是未斋？`;

// 对高手卷：只给规则 + 一句「对手是高手」，不给任何关于对手打法的提示。
// 验的是：模型拿到规则后，自己能不能推出「高手会怎么打」，并给出能赢高手的打法。
const EXPERT = `你的对手是一个高手。

请回答三件事：
1）在你看来，这套规则下的高手会怎么打？高手的打法和普通打法差别在哪？
2）你打算怎么打，才算是高手的打法？
3）面对这样的对手，你靠什么才能赢它？

只写你的想法，不要复述规则。`;

const CORRECT = `【参考答案（不发给模型）】
Q1 不可以：首喊个数最少 2 个。
Q2 斋。
Q3 不合法：整手要严格大于斋前「6 个 3」，个数同为 6 时点数要比 3 大。（但可作为留在斋里的普通抬价）
Q4 合法：个数 6 ≥ 3×2，且 6 个 4 严格大于 6 个 3。
Q5 合法（个数 4 > 当前 3），喊完后仍是斋：没写「破斋」就不算破斋。`;

function buildPrompt(rules, hpMax, mode) {
  const rt = C.rulesTextFor(rules).split('{TARGET}').join(String(hpMax));
  const q = mode === 'quiz' ? QUIZ : mode === 'expert' ? EXPERT : QUESTION;
  return rt + '\n\n' + q;
}

async function call(model, base, key, prompt, maxTokens) {
  const t0 = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const body = { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.7, stream: false };
  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  const ch = (j.choices || [{}])[0], msg = ch.message || {}, u = j.usage || {};
  return {
    content: msg.content || '', reasonChars: (msg.reasoning_content || '').length,
    finish: ch.finish_reason || null, promptTokens: u.prompt_tokens || null,
    completionTokens: u.completion_tokens || null, ms: Date.now() - t0,
  };
}

(async () => {
  const rules = RS.normalize(arg('rules', 'flex'));
  const hpMax = parseInt(arg('hp', '10'), 10);
  const specs = String(arg('models', 'llm:1235:avalon-iq3ks-256k')).split(',').map(s => s.trim()).filter(Boolean);
  const maxTokens = parseInt(arg('max-tokens', '4096'), 10);
  const mode = process.argv.includes('--quiz') ? 'quiz' : process.argv.includes('--vs-expert') ? 'expert' : 'open';
  const prompt = buildPrompt(rules, hpMax, mode);
  if (mode === 'quiz') console.log(CORRECT);
  const label = { quiz: '追问卷', expert: '对高手作战计划', open: '开放提问' }[mode];
  console.log(`# 规则 ${rules.id}(${RS.hash(rules)}) · 血量 ${hpMax} · ${label} · 提问 ${prompt.length} 字\n`);
  const out = path.join(__dirname, '..', 'runs', 'understand-' + Date.now().toString(36) + '.jsonl');
  const stream = fs.createWriteStream(out, { flags: 'a' });

  for (const spec of specs) {
    let base, model, key = null;
    if (spec.startsWith('llm:')) {
      const [, port, m] = spec.split(':');
      base = `http://127.0.0.1:${port}/v1`; model = m;
    } else if (spec.startsWith('wb:')) {
      base = WB_BASE + '/v1'; model = spec.slice(3); key = wbKey();
    } else { console.error('跳过未知规格 ' + spec); continue; }
    let rec;
    try { rec = await call(model, base, key, prompt, maxTokens); }
    catch (e) { rec = { error: String(e).slice(0, 300) }; }
    stream.write(JSON.stringify({ t: Date.now(), spec, model, ruleset: rules.id, ruleset_hash: RS.hash(rules), hpMax, mode, prompt, ...rec }) + '\n');
    console.log('\n========== ' + spec + ' ==========');
    if (rec.error) { console.log('调用失败: ' + rec.error); continue; }
    console.log(`finish=${rec.finish} completion=${rec.completionTokens} reason=${rec.reasonChars}字 ${rec.ms}ms`);
    console.log(rec.content);
  }
  stream.end();
  console.log('\n明细已写入 ' + out);
})().catch(e => { console.error(e); process.exit(1); });
