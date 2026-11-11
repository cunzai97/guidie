#!/usr/bin/env node
/* 把引擎真源同步进小程序包（小程序只能 require 包内文件，不能引用 ../src）
 *
 * 单一真源仍是 src/：这里只做复制 + 指纹，不做改写。
 * 任何一次引擎改动后跑：node scripts/sync-vendor.js
 * 想确认小程序里跑的是不是最新规则：node scripts/sync-vendor.js --check
 *
 * 为什么不做软链接：微信开发者工具打不开包外文件，打包时也要真实文件。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.dirname(__dirname);
const SRC = path.join(ROOT, 'src');
const DST = path.join(ROOT, 'miniprogram', 'vendor');
const FILES = ['dice-rulesets.js', 'dice-engine.js', 'dice-rules.js', 'view.js'];
const MANIFEST = path.join(DST, 'MANIFEST.json');

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const check = process.argv.includes('--check');

fs.mkdirSync(DST, { recursive: true });

let drift = 0;
const manifest = { syncedAt: new Date().toISOString(), files: {} };

for (const f of FILES) {
  const srcPath = path.join(SRC, f);
  const dstPath = path.join(DST, f);
  const srcBuf = fs.readFileSync(srcPath);
  const srcHash = md5(srcBuf);
  manifest.files[f] = srcHash;

  let dstHash = null;
  try { dstHash = md5(fs.readFileSync(dstPath)); } catch (e) { /* 还没有 */ }

  if (check) {
    if (srcHash !== dstHash) {
      drift++;
      console.log('  ✗ ' + f + '  drift: src ' + srcHash.slice(0, 8) + ' ≠ vendor ' + (dstHash ? dstHash.slice(0, 8) : '(缺失)'));
    } else {
      console.log('  ✓ ' + f + ' ' + srcHash.slice(0, 8));
    }
  } else {
    fs.writeFileSync(dstPath, srcBuf);
    console.log('  → ' + f);
  }
}

if (check) {
  console.log(drift ? '\n有 ' + drift + ' 个文件漂移，跑 node scripts/sync-vendor.js 同步' : '\nvendor 与 src 一致');
  process.exit(drift ? 1 : 0);
}

// 小程序端要能一眼看出自己带的是哪版规则
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log('\n已同步到 miniprogram/vendor/（指纹写进 MANIFEST.json）');
