/* 玩家页真浏览器自检：无头 Firefox + CDP，真点一遍「开一桌 → 开局 → 喊价 → 对手应答」。
 * 为什么要它：play.js 的逻辑（座位选择器、SSE、视角渲染、合法走子按钮）只有浏览器里才验得动，
 * 光跑接口测试会把「页面打不开 / 按钮点不动 / hidden 被 CSS 盖住」这类问题漏过去。
 *
 * 用法：
 *   PORT=8898 node src/room-server.js &            # 先把平台起来（默认 127.0.0.1:8898）
 *   node tests/ui-check.js                         # 默认用 google-chrome；BROWSER=/path/to/chrome 可换
 * 产出：runs/livedemo/ui-*.png 两张截图 + 控制台报错清单。零 token（对手是内置人机）。
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8898';
const BROWSER = process.env.BROWSER || '/usr/bin/google-chrome';
const PORTDBG = +(process.env.UI_CDP_PORT || 9223);
const PORT0 = PORTDBG;
const PROFILE = process.env.UI_PROFILE || path.join(ROOT, 'runs', 'livedemo', 'ui-profile-' + PORT0);
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
const SHOTS = path.join(ROOT, 'runs', 'livedemo');
fs.mkdirSync(PROFILE, { recursive: true });

const BR_ARGS = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', '--hide-scrollbars', '--user-data-dir=' + PROFILE,
  '--remote-debugging-port=' + PORTDBG, '--window-size=1320,1000', 'about:blank'];

function getJSON(url) {
  return new Promise((res, rej) => http.get(url, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ff;
async function waitTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await getJSON('http://127.0.0.1:' + PORTDBG + '/json/list');
      if (process.env.UI_DEBUG) console.error('调试端口探针:', Array.isArray(j) ? j.map(t => t.type).join(',') : typeof j);
      const p = (Array.isArray(j) ? j : []).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch (e) { }
    await sleep(300);
  }
  throw new Error('连不上 Firefox 的调试端口 ' + PORTDBG);
}

(async () => {
  try { await getJSON(BASE + '/api/ping'); } catch (e) {
    console.log('平台没起来：先跑 PORT=8898 node src/room-server.js（BASE=' + BASE + '）'); process.exit(2);
  }
  ff = spawn(BROWSER, BR_ARGS, { stdio: ['ignore', process.env.UI_DEBUG ? 'inherit' : 'ignore', process.env.UI_DEBUG ? 'inherit' : 'ignore'] });
  ff.on('error', e => console.log('浏览器起不来：', e.message));
  const target = await waitTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [], pageErrors = [];
  const send = (method, params = {}) => new Promise((res, rej) => {
    const my = ++id; pending.set(my, { res, rej }); ws.send(JSON.stringify({ id: my, method, params }));
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 200));
    }
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Log.enable').catch(() => { });
  await send('Page.navigate', { url: BASE + '/web/play.html' });
  await sleep(2600);   // 让 /api/ping 回来、座位选择器和公开桌列表渲染完

  // 把整段操作丢进页面里自己跑，进度写进 window.__ui；这边只短促轮询。
  // （不能在一条 CDP 调用里 await 整局：中途页面切换/上下文变化会让 CDP「无结果返回」）
  await send('Runtime.evaluate', { expression: `(() => {
    const \$ = s => document.querySelector(s);
    const T = window.__ui = { log: [], done: false };
    const ok = (c, m, x) => T.log.push({ ok: !!c, m, extra: c ? undefined : x });
    const wait = (fn, ms) => new Promise(r => { const t0 = Date.now(); const iv = setInterval(() => { if (fn() || Date.now() - t0 > (ms || 15000)) { clearInterval(iv); r(fn()); } }, 90); });
    const txt = el => (el ? (el.innerText || '').trim().slice(0, 110) : null);
    (async () => {
      try {
        ok(document.getElementById('modal').hidden, '「我的配置」弹窗默认隐藏（hidden 没被 CSS 盖住）');
        ok(document.getElementById('pagePlay').hidden, '玩牌页默认不显示');
        ok(document.querySelectorAll('#seatA .segtabs button').length > 0 && document.querySelectorAll('#seatB .segtabs button').length > 0, '两座座位选择器都渲染出来了');
        ok(/^服务在线/.test(document.getElementById('net').textContent), '顶部连接状态正常', document.getElementById('net').textContent);
        $('#hNick').value = '自检甲'; $('#hNick').dispatchEvent(new Event('input', { bubbles: true }));
        const tb = document.querySelector('#seatB .segtabs button[data-k="bot"]'); if (tb) tb.click();
        await wait(() => document.querySelector('#seatB select'), 6000);
        const botSel = document.querySelector('#seatB select');
        ok(!!botSel && botSel.options.length > 0, '乙方选「内置人机」后有列表（来自 /api/ping）');
        const dup = document.getElementById('hDup'); if (dup && dup.checked) dup.click();
        document.getElementById('hHp').value = '3';
        document.getElementById('hTurn').value = '15';
        document.getElementById('hRounds').value = '10';
        $('#btnCreate').click();
        const inRoom = await wait(() => !document.getElementById('pageRoom').hidden || !document.getElementById('pagePlay').hidden, 12000);
        ok(!!inRoom, '点「开桌」后进入了桌台/牌桌页');
        T.code = txt(document.getElementById('pCode')) || txt(document.getElementById('rCode'));
        const sb = Array.from(document.querySelectorAll('button')).find(b => /开局|开始/.test(b.innerText) && b.offsetParent !== null);
        if (sb) { sb.click(); await wait(() => true, 400); T.log.push({ ok: true, m: '点了「' + sb.innerText.trim() + '」' }); }
        const asked = await wait(() => { const a = document.getElementById('action'); return a && a.querySelectorAll('button').length > 0; }, 30000);
        ok(!!asked, '轮到我了：出招区有可点按钮', txt(document.getElementById('action')));
        ok(document.querySelectorAll('#myDice .die').length >= 5, '你的骰子已渲染成点阵骰面（私有视角到手）', document.querySelectorAll('#myDice .die').length);
        ok(document.querySelectorAll('#oppDice .die.back').length >= 5, '对手骰子开盅前只有背面（没偷看）');
        // 真按「个数 → 点数 → 走这一步」走一遍，别只点一个筹码按钮就算落子
        const cnt = Array.from(document.querySelectorAll('#action .chips button')).find(b => /个/.test(b.innerText) && !b.classList.contains('no'));
        const fc = document.querySelectorAll('#action [data-f]');
        const face = Array.from(fc).find(b => !b.classList.contains('no'));
        if (cnt) cnt.click();
        if (face) face.click();
        const go = document.getElementById('btnGo');
        const before = (document.getElementById('seq').querySelectorAll('div').length) || 0;
        if (go) go.click();
        const landed = await wait(() => document.querySelectorAll('#seq div').length > before, 9000);
        ok(!!landed, '按「个数 → 点数 → 走这一步」落子，服务端受理并进行情', { before, now: document.querySelectorAll('#seq div').length });
        const reply = await wait(() => { const b = document.getElementById('bidBox'); return b && (b.innerText || '').length > 2 && !/还没人喊价/.test(b.innerText); }, 20000);
        ok(!!reply, '对手应答，喊价框有内容', txt(document.getElementById('bidBox')));
        const opened = await wait(() => (document.getElementById('history').innerText || '').length > 0, 45000);
        ok(!!opened, '打到开盅结算，历史区出现了结果行');
      } catch (e) { T.log.push({ ok: false, m: '自检脚本自身出错：' + (e && e.message || e) }); }
      T.done = true;
    })();
    return true;
  })()` });

  let r = { log: [], done: false };
  const t0 = Date.now();
  while (!r.done && Date.now() - t0 < 150000) {
    await sleep(1500);
    const q = await send('Runtime.evaluate', { returnByValue: true, expression: 'window.__ui || {log:[],done:false}' });
    if (q.result && q.result.value) r = q.result.value;
  }
  const probe = { result: { value: r } };


  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const f1 = path.join(SHOTS, 'ui-lobby.png');
  // 再看一眼首页（座位选择器展开的样子）
  await send('Runtime.evaluate', { expression: `(document.querySelector('#btnBackRoom') && document.querySelector('#btnBackRoom').click(), true)` });
  await sleep(900);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });

  if (process.env.UI_DEBUG) console.log('probe:', JSON.stringify(r).slice(0, 400));
  fs.writeFileSync(path.join(SHOTS, 'ui-play.png'), Buffer.from(shot.data, 'base64'));
  fs.writeFileSync(f1, Buffer.from(shot2.data, 'base64'));
  let fail = 0;
  console.log('[页面自检] ' + (r ? r.title : ''));
  for (const e of ((r && r.log) || [])) { console.log((e.ok ? '  ✓ ' : '  ✗ ') + e.m + (e.extra == null ? '' : ' ' + JSON.stringify(e.extra))); if (!e.ok) fail++; }
  if (pageErrors.length) { console.log('  ✗ 页面抛错：' + pageErrors.slice(0, 4).join(' | ')); fail++; }
  if (consoleErrors.length) { console.log('  ✗ 控制台报错：' + consoleErrors.slice(0, 4).join(' | ')); fail++; }
  console.log('  截图：' + path.join(SHOTS, 'ui-play.png') + ' / ' + f1);
  console.log(fail === 0 ? '==> UI PASS' : '==> UI FAIL ' + fail);
  try { ws.close(); } catch (e) { }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('自检炸了', e && e.stack || e); process.exit(2); })
  .finally(() => { try { if (ff) ff.kill('SIGTERM'); } catch (e) { } });
