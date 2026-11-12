/* 实验运行账本：run_id、配置清单、代码/提示词指纹、事件主键、run 完整性。
 * 不改任何模型可见文本；只负责把"这次跑的到底是什么"和"每条记录属于哪一手"钉死。
 * 事件主键统一为：{ run_id, deal, swap, game, round, step, seat, phase, ask }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SOURCE_FILES = ['dice-rulesets.js', 'dice-engine.js', 'dice-rules.js', 'context.js', 'bots.js', 'llm.js', 'runner.js', 'pk.js', 'runlog.js'];
const EVENT_KEYS = ['run_id', 'deal', 'swap', 'game', 'round', 'step', 'seat', 'phase', 'ask'];

function sha1Text(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

function makeRunId(config) {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return stamp + '-' + sha1Text(JSON.stringify(config) + '|' + Date.now() + '|' + Math.random()).slice(0, 6);
}

// 工程源码指纹：规则/解析/渲染/编排任一改动都会变，便于跨文件回溯结论对应的代码版本
function codeHash() {
  const h = crypto.createHash('sha1');
  for (const f of SOURCE_FILES.slice().sort()) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    h.update(f + '\0');
    h.update(fs.readFileSync(p));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

// 静态提示词模板指纹：只覆盖写进 system / 复盘提示的固定文本，按 (臂, 规则集) 取。
// 经典套的文本顺序与旧版完全一致，历史 run 的指纹仍可对照；规则集一变指纹必变，
// 避免把不同规则下的胜负混进同一组 A/B。
function promptHash(variant, rules) {
  const C = require('./context.js');
  return sha1Text(C.promptTexts(rules, variant).join('\n\0\n'));
}
function rulesHash(rules) { return require('./dice-rulesets.js').hash(rules || 'flex'); }

function startRecord(runId, config) {
  return {
    t: Date.now(), kind: 'run-start', status: 'running', schema: 2,
    run_id: runId, config, prompt_hash: promptHash(config && config.prompt, config && config.rules),
    ruleset_hash: rulesHash(config && config.rules), code_hash: codeHash(),
    node: process.version,
  };
}

function endRecord(runId, config, result, seconds) {
  return {
    t: Date.now(), kind: 'summary', status: 'complete', schema: 2,
    run_id: runId, ...config, prompt_hash: promptHash(config && config.prompt, config && config.rules),
    ruleset_hash: rulesHash(config && config.rules), code_hash: codeHash(),
    seconds, summary: result,
  };
}

function abortRecord(runId, err) {
  return { t: Date.now(), kind: 'run-aborted', status: 'aborted', schema: 2, run_id: runId, error: String(err).slice(0, 400) };
}

/* 把一份 jsonl 按 run 切开，标出哪些 run 是完整的。
 * 兼容旧文件（无 run_id）：整份视为一个 legacy run，status 由是否有 summary 推断。
 */
function readRuns(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    .map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const runs = new Map();
  for (const l of lines) {
    const id = l.run_id || 'legacy';
    if (!runs.has(id)) runs.set(id, { run_id: id, legacy: !l.run_id, status: 'unknown', config: null, lines: [] });
    const r = runs.get(id);
    r.lines.push(l);
    if (l.kind === 'run-start') { r.status = 'running'; r.config = l.config; r.code_hash = l.code_hash; r.prompt_hash = l.prompt_hash; }
    if (l.kind === 'run-aborted') r.status = 'aborted';
    if (l.kind === 'summary') { r.status = l.status || 'complete'; r.summary = l; if (l.config) r.config = l.config; }
    if (!l.run_id && l.kind === 'summary') r.status = 'complete';
  }
  return { lines, runs: [...runs.values()] };
}

module.exports = {
  EVENT_KEYS, SOURCE_FILES, sha1Text, makeRunId, codeHash, promptHash, rulesHash,
  startRecord, endRecord, abortRecord, readRuns,
};
