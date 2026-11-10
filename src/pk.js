#!/usr/bin/env node
/* 大话骰 PK CLI。
 * 例：
 *   node src/pk.js --p0 threshold --p1 random --deals 30 --out runs/bot-baseline.jsonl
 *   node src/pk.js --p0 llm:1235:avalon-iq3ks-256k --p1 threshold --deals 6 --thinking off
 *   node src/pk.js --p0 llm:1235:avalon --p1 llm:1236:minimax --deals 6 --context memory --prompt probe
 *   node src/pk.js --p0 llm:1235:qwen3.8-27b-7900xtx --p1 llm:1236:swift15-gsq-kvmem-v100 --deals 10
 *   node src/pk.js --p0 threshold --p1 random --deals 6 --rules flex --effort high
 * player 规格：threshold[:阈值] | random | always-open | never-open | oracle（纯数学精确期望）| reader（贝叶斯读喊价）| llm:端口:模型名
 * 规则集：--rules classic|flex|自定义id（自定义套从 presets.json 的 settings.ruleSets 读）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPK, summarize, pairedCI } = require('./runner.js');
const bots = require('./bots.js');
const { makeLLMPlayer } = require('./llm.js');
const E = require('./dice-engine.js');
const RL = require('./runlog.js');
const RS = require('./dice-rulesets.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = name => process.argv.includes('--' + name);

// 网关 api_key：优先 DICE_WB_KEY 环境变量，其次尝试本机 workbuddy 设置。
function wbKey() {
  const env = process.env.DICE_WB_KEY;
  if (env) return env;
  const f = path.join(os.homedir(), 'work/wb-api/hub/accounts/settings.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const k = (d.api_keys || []).find(x => x && x.key && !x.deleted_at && x.enabled !== false);
  if (!k) throw new Error('wb-api settings.json 里没有可用的 api_key（也可用 DICE_WB_KEY 环境变量指定）');
  return k.key;
}

// 网关地址：DICE_WB_BASE 可覆盖（默认本机 8791）。
const WB_BASE = process.env.DICE_WB_BASE || 'http://127.0.0.1:8791';

// 自定义规则套：从 presets.json 的 settings.ruleSets 里按 id 取，找不到就回落到内置套。
function resolveRules(id) {
  if (RS.BUILTIN[id]) return RS.normalize(id);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'presets.json'), 'utf8'));
    const custom = ((j.settings || {}).ruleSets || []).find(x => x && x.id === id);
    if (custom) return RS.normalize(custom);
  } catch (e) { /* 没配置文件时只用内置 */ }
  console.error(`未知规则集「${id}」，回落到 classic`);
  return RS.normalize('classic');
}

function makePlayer(spec, globalOpts, log) {
  if (spec.startsWith('wb:')) {
    const model = spec.slice(3);
    return makeLLMPlayer({
      name: model, baseUrl: WB_BASE + '/v1', model, apiKey: wbKey(),
      thinking: false, thinkingKwargs: false, effort: globalOpts.effort, maxTokens: globalOpts.maxTokens,
      temperature: globalOpts.temperature, coach: globalOpts.coach, context: globalOpts.context,
      prompt: globalOpts.prompt, rules: globalOpts.rules,
    }, log);
  }
  if (spec.startsWith('llm:')) {
    const [, port, model] = spec.split(':');
    return makeLLMPlayer({
      name: model, baseUrl: `http://127.0.0.1:${port}/v1`, model,
      thinking: globalOpts.thinking, effort: globalOpts.effort, maxTokens: globalOpts.maxTokens,
      temperature: globalOpts.temperature, coach: globalOpts.coach, context: globalOpts.context,
      prompt: globalOpts.prompt, rules: globalOpts.rules,
    }, log);
  }
  if (spec.startsWith('threshold')) {
    const th = spec.includes(':') ? parseFloat(spec.split(':')[1]) : 0.5;
    return bots.thresholdBot({ threshold: th });
  }
  if (spec === 'random') return bots.randomBot(E.mulberry32(globalOpts.seed || 1));
  if (spec === 'always-open') return bots.alwaysOpenBot();
  if (spec === 'never-open') return bots.neverOpenBot();
  if (spec === 'oracle') return bots.oracleBot();
  if (spec === 'reader') return bots.readerBot();
  throw new Error('未知 player 规格: ' + spec);
}

let RUN = null;                 // 供异常退出时补写 run-aborted 记录

async function main() {
  const p0spec = arg('p0', 'threshold');
  const p1spec = arg('p1', 'random');
  const deals = parseInt(arg('deals', '10'), 10);
  const seed = parseInt(arg('seed', '12345'), 10);
  const target = parseInt(arg('target', '10'), 10);
  const maxRounds = parseInt(arg('max-rounds', '30'), 10);
  const out = arg('out', null);
  const globalOpts = {
    thinking: arg('thinking', 'off') === 'on',
    effort: arg('effort', 'off'),   // off | low | medium | high | xhigh
    maxTokens: parseInt(arg('max-tokens', '8192'), 10),
    temperature: parseFloat(arg('temperature', '0.7')),
    coach: has('coach'), seed,
    context: arg('context', 'chat'),   // chat=持久逐字对话(默认) | memory=追加式摘要链(轮末自总结压缩) | snapshot=窗口快照(对比臂)
    prompt: arg('prompt', 'classic'),  // classic=原版兵书(默认，与历史可比) | probe=轻量引导(不给结论+轮间软提示复盘)
    rules: resolveRules(arg('rules', 'classic')),
  };

  const append = has('append');
  const cfg = {
    p0: p0spec, p1: p1spec, deals, seed, target, maxRounds,
    out: out || null, append,
    thinking: globalOpts.thinking, effort: globalOpts.effort, maxTokens: globalOpts.maxTokens,
    temperature: globalOpts.temperature, coach: globalOpts.coach, context: globalOpts.context,
    prompt: globalOpts.prompt, rules: globalOpts.rules,
  };
  const runId = RL.makeRunId(cfg);
  RUN = { runId, out };
  // 默认覆盖写：以前 --out 是追加，同一文件重跑两次会把两个实验的 calls 混在一起。
  // 需要续写时显式加 --append。
  const outStream = out ? fs.createWriteStream(out, { flags: append ? 'a' : 'w' }) : null;
  const log = rec => { if (outStream) outStream.write(JSON.stringify({ t: Date.now(), run_id: runId, ...rec }) + '\n'); };
  if (outStream) outStream.write(JSON.stringify(RL.startRecord(runId, cfg)) + '\n');

  const p0 = makePlayer(p0spec, globalOpts, log);
  const p1 = makePlayer(p1spec, globalOpts, log);
  console.error(`PK: ${p0.name}  vs  ${p1.name} | run=${runId} deals=${deals} seed=${seed} target=${target} maxRounds=${maxRounds} context=${globalOpts.context} prompt=${globalOpts.prompt} rules=${globalOpts.rules.id}(${RS.hash(globalOpts.rules)}) effort=${globalOpts.effort} maxTokens=${globalOpts.maxTokens} thinking=${globalOpts.thinking ? 'on' : 'off'} coach=${globalOpts.coach}`);

  const t0 = Date.now();
  const { agg, games } = await runPK(p0, p1, {
    deals, seed, roundTarget: target, maxRounds, runId, rules: globalOpts.rules,
    onGame: (g, d, swap) => {
      if (outStream) outStream.write(JSON.stringify({ t: Date.now(), kind: 'game', ...g }) + '\n');
      const w = g.winner ? (g.winner === g.seatOf.p0 ? p0.name : p1.name) : '未评';
      console.error(`  deal ${d + 1}/${deals} ${swap ? '交换' : '原座'} seed=${g.seed} → ${w} (${g.rounds}轮${g.capped ? ',封顶' : ''}, 积分 ${g.points.A}:${g.points.B})`);
    },
  });

  const summary = summarize(agg);
  const paired = pairedCI(games);
  const seconds = +((Date.now() - t0) / 1000).toFixed(1);
  const rec = RL.endRecord(runId, cfg, summary, seconds);
  rec.p0spec = p0spec; rec.p1spec = p1spec;
  rec.p0 = p0.name; rec.p1 = p1.name; rec.paired = paired;
  if (outStream) { outStream.write(JSON.stringify(rec) + '\n'); outStream.end(); }
  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(summary, null, 2));
  if (paired) console.log(`配对 bootstrap (${paired.deals} 个 deal): 胜率 ${paired.point}，95% CI [${paired.winRateCI95.join(', ')}]`);
  console.log(`耗时 ${seconds}s，明细${out ? '已写入 ' + out : '未落盘（加 --out 文件）'}`);
  RUN = null;
}

main().catch(e => {
  if (RUN && RUN.out) {
    try { fs.appendFileSync(RUN.out, JSON.stringify(RL.abortRecord(RUN.runId, e)) + '\n'); } catch { }
  }
  console.error(e);
  process.exit(1);
});