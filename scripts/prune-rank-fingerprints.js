#!/usr/bin/env node
/* 清理排行榜里的旧指纹：只留「当前代码还能复现」的指纹组。
 *
 * 指纹 = ruleset_hash | prompt_hash（见 web/ranking.js 的 groupKey）。规则文本或
 * 提示词文本改过一版，旧对局的指纹就再也对不上当前代码，它们会在「指纹分组」
 * 下拉框里留一堆没人再打的死组，也把同一批选手拆成好几份 Elo。
 *
 * 用法：
 *   node scripts/prune-rank-fingerprints.js data/matches-live.jsonl --dry
 *   node scripts/prune-rank-fingerprints.js data/matches-live.jsonl
 *   node scripts/prune-rank-fingerprints.js data/matches-live.jsonl --keep a6c5a8ef|d5b83db6dede
 *
 * 默认保留：全部内置规则集在当前代码下的指纹（classic + flex）。这样「换了一版
 * 规则」的旧数据会被清掉，而没改过的 classic 不受牵连。要只留某一组就显式 --keep。
 *
 * 先备份再原子替换（file.bak-<时间戳>）；读不出来的行原样保留，不静默丢。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RS = require(path.join(ROOT, 'src', 'dice-rulesets.js'));
const C = require(path.join(ROOT, 'src', 'context.js'));
const RK = require(path.join(ROOT, 'web', 'ranking.js'));

function currentFingerprints(rulesIds) {
  const B = RS.BUILTIN || {};
  const ids = rulesIds && rulesIds.length ? rulesIds : Object.keys(B);
  const out = new Map();
  for (const id of ids) {
    const r = B[id];
    if (!r) continue;
    // 两个座位默认同一臂，所以两侧文本相同；与 rooms.js 的 record() 同口径
    const t = C.promptTexts(r, 'plain').join('\n');
    out.set(RS.hash(r) + '|' + RK.hashTexts([t, t]), (r.name || id));
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  const dry = argv.includes('--dry');
  const keepArg = (argv.find(a => a.startsWith('--keep=')) || '').slice('--keep='.length);
  const rulesArg = (argv.find(a => a.startsWith('--rules=')) || '').slice('--rules='.length);
  if (!file) {
    console.error('用法: node scripts/prune-rank-fingerprints.js <matches.jsonl> [--dry] [--keep=h|p,...] [--rules=flex,classic]');
    process.exit(2);
  }
  const abs = path.resolve(process.cwd(), file);
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);

  const keep = currentFingerprints(rulesArg ? rulesArg.split(',').map(s => s.trim()).filter(Boolean) : null);
  if (keepArg) {
    for (const k of keepArg.split(',').map(s => s.trim()).filter(Boolean)) keep.set(k, '(cli)');
  }

  const groups = new Map();      // key -> {n, name, keep}
  const out = [];                // 原样保持时间顺序：只把要删的摘掉
  let keptN = 0, droppedN = 0, brokenN = 0;
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch (e) { out.push(line); brokenN++; continue; }
    const key = RK.groupKey(m);
    const g = groups.get(key) || { n: 0, name: (m.rules && m.rules.name) || '', keep: keep.has(key) };
    g.n++; groups.set(key, g);
    if (keep.has(key)) { out.push(line); keptN++; } else droppedN++;
  }

  console.log(`文件 ${abs}`);
  console.log(`共 ${lines.length} 行 · 保留 ${keptN} · 删除 ${droppedN} · 读不出（原样留） ${brokenN}`);
  console.log('\n指纹分组：');
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${g.keep ? '保留' : '删除'}  ${String(g.n).padStart(4)}  ${k}  ${g.name}`);
  }
  console.log('\n当前代码的指纹：');
  for (const [k, name] of keep) console.log(`  ${k}  ${name}`);

  if (dry) { console.log('\n--dry：未写盘'); return; }
  if (!droppedN) { console.log('\n没有要删的行，文件未改动'); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const bak = abs + '.bak-' + stamp;
  fs.copyFileSync(abs, bak);
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, out.join('\n') + '\n');
  fs.renameSync(tmp, abs);
  console.log(`\n已备份到 ${bak}`);
  console.log(`已重写 ${abs}：${out.length} 行`);
}

main();
