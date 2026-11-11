#!/usr/bin/env node
/* 小程序静态自检：在没有微信开发者工具的环境里，把「一定会在真机上炸」的低级错误先抓出来。
 *
 * 查六件事：
 *   1. app.json 里的页面 = 磁盘上的页面四件套，tabBar 指向的页面也存在
 *   2. 每个 .js 能过 node --check（语法错在小程序里是白屏，不报行号）
 *   3. wxml 里 bind / catch 绑的方法在对应 js 里真的存在（点了没反应最常见的成因）
 *   4. require 的相对路径都存在（小程序不给你模糊解析）
 *   5. vendor 引擎副本与 src 一致（改了规则忘了同步 → 界面和服务端判两套规则）
 *   6. wxml 里用 <i>/<div> 这类 HTML 标签（小程序只认内置组件，写了就是报错）
 *
 * 用法：node tests/test-miniprogram.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.dirname(__dirname);
const MP = path.join(ROOT, 'miniprogram');
const SRC = path.join(ROOT, 'src');

let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const read = p => fs.readFileSync(p, 'utf8');

console.log('· 小程序静态自检');

// —— 1. 页面清单 ——
const appJson = JSON.parse(read(path.join(MP, 'app.json')));
const pages = appJson.pages || [];
ok(pages.length >= 3, 'app.json 声明了 ' + pages.length + ' 个页面');
for (const pg of pages) {
  const base = path.join(MP, pg);
  const files = ['.js', '.json', '.wxml'].map(ext => base + ext);
  const missing = files.filter(f => !fs.existsSync(f));
  ok(!missing.length, pg + ' 四件套齐全', missing.map(f => path.basename(f)).join(','));
}
for (const item of (appJson.tabBar ? appJson.tabBar.list || [] : [])) {
  ok(pages.includes(item.pagePath), 'tabBar 指向的 ' + item.pagePath + ' 在 pages 里');
}

// —— 2. 语法 ——
const jsFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
})(MP);
let syntaxBad = [];
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { syntaxBad.push(path.relative(MP, f)); }
}
ok(!syntaxBad.length, jsFiles.length + ' 个 js 全部通过语法检查', syntaxBad.join(','));

// —— 3. 事件绑定 → 方法存在 ——
const BIND = /\b(?:bind|catch)(?:tap|input|change|confirm|blur|longpress|submit|scrolltolower)="([A-Za-z_$][\w$]*)"/g;
let bindMissing = [];
for (const pg of pages) {
  const wxml = read(path.join(MP, pg + '.wxml'));
  const js = read(path.join(MP, pg + '.js'));
  const names = new Set();
  let m;
  while ((m = BIND.exec(wxml))) names.add(m[1]);
  BIND.lastIndex = 0;
  for (const n of names) {
    // 支持 `onX() {` / `onX: function` / `onX: (` 三种写法
    const re = new RegExp('(^|[^\\w$])' + n + '\\s*[:(]', 'm');
    if (!re.test(js)) bindMissing.push(pg + ' → ' + n);
  }
}
ok(!bindMissing.length, 'wxml 里的事件绑定都能在 js 里找到方法', bindMissing.join(', '));

// —— 4. require 路径 ——
let reqMissing = [];
for (const f of jsFiles) {
  const src = read(f);
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const rel = m[1];
    if (!rel.startsWith('.')) continue;          // 只查相对路径
    const target = path.resolve(path.dirname(f), rel);
    const cands = [target, target + '.js', path.join(target, 'index.js')];
    if (!cands.some(c => fs.existsSync(c))) reqMissing.push(path.relative(MP, f) + ' → ' + rel);
  }
}
ok(!reqMissing.length, 'require 的相对路径都存在', reqMissing.join(', '));

// —— 5. vendor 与 src 一致 ——
const VENDOR = ['dice-rulesets.js', 'dice-engine.js', 'dice-rules.js', 'view.js'];
const drift = VENDOR.filter(f => {
  const a = path.join(SRC, f), b = path.join(MP, 'vendor', f);
  return !fs.existsSync(b) || md5(a) !== md5(b);
});
ok(!drift.length, 'vendor 引擎副本与 src 一致', drift.join(',') + '（跑 node scripts/sync-vendor.js）');

// —— 6. 不许出现 HTML 标签 ——
// input / button / view / text 是小程序内置组件，别误伤；这里只抓真正的 HTML 标签
const HTML_TAGS = /<\/?(div|span|i|b|em|small|p|ul|li|h1|h2|h3|section|br|img|a)\b/g;
let htmlTags = [];
for (const pg of pages) {
  const wxml = read(path.join(MP, pg + '.wxml'));
  const hit = wxml.match(HTML_TAGS);
  if (hit) htmlTags.push(pg + ' → ' + [...new Set(hit)].join(' '));
}
ok(!htmlTags.length, 'wxml 没混进 HTML 标签（小程序只认内置组件）', htmlTags.join('; '));

// —— 7. 每页都在 app.json 里有标题 / 页面 json 合法 ——
let jsonBad = [];
for (const pg of pages) {
  try { JSON.parse(read(path.join(MP, pg + '.json'))); }
  catch (e) { jsonBad.push(pg); }
}
ok(!jsonBad.length, '页面 json 都能解析', jsonBad.join(','));

// —— 8. config.js 的地址不是 127.0.0.1（手机访问不到本机） ——
const cfg = read(path.join(MP, 'config.js'));
ok(!/dev:\s*'https?:\/\/127\.0\.0\.1/.test(cfg), 'dev 地址不是 127.0.0.1（真机访问不到）');

console.log('\n' + (fail ? 'FAIL' : 'ALL PASS') + '  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
