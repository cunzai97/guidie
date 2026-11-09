#!/usr/bin/env node
/* 博弈质量分析：从 PK 落盘 jsonl 抽每个模型的判断句，分桶量化博弈深度。
 * 用法: node src/analyze.js runs/avalon-vs-minimax-t10.jsonl [每桶样例数=6] [--all]
 *  - 默认只统计 status=complete 的 run；中断/未完成的 run 会被跳过（--all 可强制纳入）。
 *  - 深度桶是关键词启发式，只作描述性参考；提示词本身也会命中这些桶，别当因果证据。
 *  - 「判断 × 真值」小节依赖 call 与 game.events 的事件主键，是本文件最可信的关联信号。
 * 桶：
 *  opponent-model  提到对手意图/真假/习惯（对手建模）
 *  multi-level     多层博弈（我想对手想我想 / 诱导 / 让对手以为）
 *  self-hand       只陈述自己手牌
 *  probability     算概率/百分比
 *  none            判断句为空或纯复述
 */
const fs = require('fs');
const RL = require('./runlog.js');
const R = require('./dice-rules.js');

const file = process.argv[2];
const N = parseInt(process.argv[3] || '6', 10);
const FORCE_ALL = process.argv.includes('--all');

const { runs } = RL.readRuns(file);
console.log('=== 运行清单 ===');
for (const r of runs) {
  const c = r.config || {};
  console.log(`  run ${r.run_id} [${r.status}] ${r.lines.length} 行` +
    (c.p0 ? `  ${c.p0} vs ${c.p1} deals=${c.deals} ctx=${c.context} mt=${c.maxTokens}` : '') +
    (r.code_hash ? `  code=${r.code_hash} prompt=${r.prompt_hash}` : '  (legacy 无清单)'));
}
const usable = FORCE_ALL ? runs : runs.filter(r => r.status === 'complete');
const skipped = runs.length - usable.length;
if (skipped) console.log(`  [WARN] 跳过 ${skipped} 个不完整 run（无 summary / 显式 aborted）；加 --all 可强制纳入`);
const lines = usable.flatMap(r => r.lines);

const calls = lines.filter(l => l.kind === 'call' && l.phase !== 'summary');   // 落子判断（深度桶）
const noteCalls = lines.filter(l => l.kind === 'call' && l.phase === 'summary'); // 轮末记忆笔记（摘要链模式）
const summary = lines.find(l => l.kind === 'summary');
const games = lines.filter(l => l.kind === 'game');

const RX = {
  multiLevel: /对手.{0,12}(认为|以为|会想|觉得|推断|猜)|让对手.{0,12}(以为|觉得|误判|纠结|被迫|难)|诱|骗|误导|如果我.{0,15}对手|若对手.{0,15}(则|就|可能|会)|反其道|将计就计/,
  oppModel: /对手|对方|它.{0,10}(诈|真|有货|意图|习惯|可能|大概率|推断| bluff)|诈唬| bluff|读.{0,4}(牌|手)/,
  selfHand: /我手里|我手中|我有|我这|我的骰子|我手|自己.{0,4}(骰子|牌|手)/,
  prob: /概率|\d+\s*%|大概率|多半|期望|赔率/,
  situation: /走势|连胜|连败|局势|领先|落后|追分|追上|上一轮|上轮|之前|前面|刚才|前几轮|此前|连续|势头|局面/,
  infoLeak: /暴露|泄露|透露|让对手.{0,10}(知道|察觉|读|看出|以为)|察觉我|读穿|手牌结构|泄露情报|暴露我/,
  revealRef: /亮牌|对手.{0,12}(实际|只有|手里有|真实|骰子)|真实手牌| revealed|开出的/,
};

const judgment = R.extractJudgment;      // 与 context.js 共用同一实现
const isEcho = R.isPromptEcho;           // 与 llm.js 的回声拦截共用同一实现

const byModel = {};
for (const c of calls) {
  const m = c.name || c.model || '?';
  (byModel[m] = byModel[m] || []).push(c);
}

console.log('\n=== 对局结果 ===');
if (summary) console.log(JSON.stringify(summary.summary, null, 2));
if (summary && summary.paired) console.log('配对 bootstrap:', JSON.stringify(summary.paired));
console.log(`\n共 ${games.length} 局，${calls.length} 次模型调用`);

// ---- 预算健康度：截断/歧义/成本，截断率高时胜负归因不可信 ----
console.log('\n=== 预算健康度 ===');
const trunc = calls.filter(c => c.finish === 'length');
const tokIn = calls.reduce((s, c) => s + (c.promptTokens || 0), 0);
const tokOut = calls.reduce((s, c) => s + (c.completionTokens || 0), 0);
const tokCached = calls.reduce((s, c) => s + (c.cachedTokens || 0), 0);
const msSum = calls.reduce((s, c) => s + (c.ms || 0), 0);
const pct = (x, d) => d ? (100 * x / d).toFixed(0) + '%' : 'n/a';
console.log(`  静默截断: ${trunc.length}/${calls.length} (${pct(trunc.length, calls.length)})  | 平均 prompt ${calls.length ? Math.round(tokIn / calls.length) : 0} tok / completion ${calls.length ? Math.round(tokOut / calls.length) : 0} tok`);
console.log(`  KV 缓存命中: ${pct(tokCached, tokIn)}  | 平均单次调用 ${calls.length ? Math.round(msSum / calls.length) : 0} ms  | 封顶局 ${games.filter(g => g.capped).length} / 平局 ${games.filter(g => g.draw).length}`);
if (summary && summary.summary) {
  for (const [m, s] of Object.entries(summary.summary))
    console.log(`  ${m}: 截断率 ${s.truncRate == null ? 'n/a' : (100 * s.truncRate).toFixed(0) + '%'}  解析歧义率 ${s.ambiguousRate == null ? 'n/a' : (100 * s.ambiguousRate).toFixed(0) + '%'}  forfeit ${s.forfeits}  平均重写 ${s.avgAsks}`);
}

// ---- 判断 × 真值：靠事件主键把"这一手说了什么"与"这一手对不对"对齐 ----
function key(run, game, round, step, seat) { return [run || 'legacy', game, round, step, seat].join('|'); }
const evIndex = new Map();
for (const g of games) for (const e of (g.events || []))
  evIndex.set(key(g.run_id, g.game, e.round, e.step, e.who || e.seat), e);
const finalCalls = new Map();
for (const c of calls) {
  const k = key(c.run_id, c.game, c.round, c.step, c.seat);
  const prev = finalCalls.get(k);
  if (!prev || (c.ask || 1) >= (prev.ask || 1)) finalCalls.set(k, c);
}
if (evIndex.size) {
  const groups = { '开盅·正确': [], '开盅·错误': [], '跟价': [], '判负': [] };
  for (const [k, c] of finalCalls) {
    const e = evIndex.get(k);
    if (!e) continue;
    const j = judgment(c.content);
    const tag = e.kind === 'open' ? (e.truth ? '开盅·错误' : '开盅·正确') : e.kind === 'bid' ? '跟价' : '判负';
    if (groups[tag]) groups[tag].push(j);
  }
  console.log('\n=== 判断 × 真值（按事件主键对齐，取每手最后一次 ask）===');
  for (const [tag, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    const hit = rx => pct(arr.filter(j => j && rx.test(j)).length, arr.length);
    console.log(`  ${tag.padEnd(9)} n=${String(arr.length).padStart(3)}  对手建模 ${hit(RX.oppModel)}  多层 ${hit(RX.multiLevel)}  算概率 ${hit(RX.prob)}  局势 ${hit(RX.situation)}  空判断 ${pct(arr.filter(j => !j).length, arr.length)}`);
  }
}

for (const [m, cs] of Object.entries(byModel)) {
  const buckets = { multiLevel: [], oppModel: [], selfHand: [], prob: [], situation: [], infoLeak: [], revealRef: [], none: [] };
  let emptyJudge = 0, truncated = 0, echoes = 0;
  const real = [];
  for (const c of cs) {
    if (isEcho(c.content, c.user)) { echoes++; continue; }   // 退化回声单独计，不进深度桶
    real.push(c);
    const j = judgment(c.content);
    if (c.finish === 'length') truncated++;
    if (!j) { emptyJudge++; buckets.none.push('(空判断)'); continue; }
    let tagged = false;
    if (RX.multiLevel.test(j)) { buckets.multiLevel.push(j); tagged = true; }
    if (RX.oppModel.test(j)) { buckets.oppModel.push(j); tagged = true; }
    if (RX.selfHand.test(j)) { buckets.selfHand.push(j); tagged = true; }
    if (RX.prob.test(j)) { buckets.prob.push(j); tagged = true; }
    if (RX.situation.test(j)) { buckets.situation.push(j); tagged = true; }
    if (RX.infoLeak.test(j)) { buckets.infoLeak.push(j); tagged = true; }
    if (RX.revealRef.test(j)) { buckets.revealRef.push(j); tagged = true; }
    if (!tagged) buckets.none.push(j);
  }
  const n = real.length || 1;
  // 上下文复用度量（持久对话模式）
  const modes = [...new Set(cs.map(c => c.context || 'snapshot'))].join('/');
  const avgTurns = (cs.reduce((s, c) => s + (c.turns || 2), 0) / (cs.length || 1)).toFixed(1);
  const maxTurns = Math.max(...cs.map(c => c.turns || 2));
  const sumPrompt = cs.reduce((s, c) => s + (c.promptTokens || 0), 0);
  const sumCached = cs.reduce((s, c) => s + (c.cachedTokens || 0), 0);
  const cacheRate = sumPrompt ? (100 * sumCached / sumPrompt).toFixed(0) + '%' : 'n/a';
  console.log(`\n========== ${m}  （${n} 次调用）==========`);
  console.log(`上下文模式: ${modes}  | 平均对话长度: ${avgTurns} 条  最长: ${maxTurns} 条  | prompt缓存命中: ${cacheRate}（KV复用）  | 回声退化: ${echoes}/${cs.length}`);
  console.log(`判断句覆盖率(非回声${real.length}条): ${pct(n - emptyJudge, n)}  | 多层博弈: ${pct(buckets.multiLevel.length, n)}  对手建模: ${pct(buckets.oppModel.length, n)}  局势变化: ${pct(buckets.situation.length, n)}  信息透露: ${pct(buckets.infoLeak.length, n)}  引用亮牌: ${pct(buckets.revealRef.length, n)}  算概率: ${pct(buckets.prob.length, n)}  截断: ${truncated}`);
  for (const [b, arr] of Object.entries(buckets)) {
    if (!arr.length) continue;
    console.log(`\n  [${b}] ${arr.length} 条，样例：`);
    const uniq = [...new Set(arr)].sort((a, b) => b.length - a.length).slice(0, N);
    uniq.forEach((s, i) => console.log(`    ${i + 1}. ${s.slice(0, 220)}`));
  }
}

// 摘要链模式：轮末记忆笔记（与落子判断分开看）。笔记是模型显式的信念状态，供保真度抽查。
if (noteCalls.length) {
  console.log(`\n========== 记忆笔记（轮末总结，共 ${noteCalls.length} 条）==========`);
  const byM = {};
  for (const c of noteCalls) { const k = c.name || c.model || '?'; (byM[k] = byM[k] || []).push(c); }
  for (const [m, cs] of Object.entries(byM)) {
    const notes = cs.map(c => String(c.content || '').trim()).filter(Boolean);
    const avgLen = notes.length ? Math.round(notes.reduce((s, x) => s + x.length, 0) / notes.length) : 0;
    const echoN = cs.filter(c => isEcho(c.content, c.user)).length;
    const failed = notes.filter(x => /未能形成复盘反思|未能形成记忆笔记/.test(x)).length;
    console.log(`\n  ${m}: ${cs.length} 次总结  笔记均长 ${avgLen} 字  回声 ${echoN}  失败 ${failed}`);
    notes.slice(0, N).forEach((s, i) => console.log(`    ${i + 1}. ${s.slice(0, 240)}`));
  }
}
