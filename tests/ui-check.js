/* 玩家页真浏览器自检（新席位模型版）：注册 → 建房间 → 放人机到乙方 → 双方准备 → 开局 →
 * 我在甲方的输入区落子 → 对手应答 → 开盅结算。全程零 token（对手是内置人机）。
 *
 * 用法：BASE=http://127.0.0.1:18898 node tests/ui-check.js
 * 产出：runs/livedemo/ui-lobby.png、ui-play.png + 控制台报错清单。
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8898';
const BROWSER = process.env.BROWSER || '/usr/bin/google-chrome';
const PORT = +(process.env.UI_CDP_PORT || 9223);
const PROFILE = process.env.UI_PROFILE || path.join(ROOT, 'runs', 'livedemo', 'ui-profile-' + PORT);
const SHOTS = path.join(ROOT, 'runs', 'livedemo');
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = url => new Promise((res, rej) => http.get(url, r => {
  let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
}).on('error', rej));

const fails = [];
const ok = (c, m, extra) => { console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra == null ? '' : ' ← ' + JSON.stringify(extra))); if (!c) fails.push(m); };

(async () => {
  const chrome = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT, '--window-size=1400,1100',
    BASE + '/web/play.html'], { stdio: ['ignore', 'ignore', 'ignore'] });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { const list = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); target = (list || []).find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch (e) { }
    if (!target) await sleep(300);
  }
  if (!target) { console.log('拿不到 Chrome 调试目标'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((r, j) => { const k = ++id; pend.set(k, { r, j }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.j(new Error(JSON.stringify(m.error))) : q.r(m.result); }
  };
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);

  const ev = async (expr, wait = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: wait });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result && r.result.value;
  };
  const text = async sel => String(await ev(`(function(){const e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent.replace(/\\s+/g,' ').trim():''})()`));
  const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64')); };

  // ---- 注册一个临时账号（账号制：演武场和房间都要登录） ----
  const nick = 'ui' + Date.now().toString(36).slice(-5);
  await ev(`fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nick:'${nick}',pass:'pw-${nick}'})}).then(r=>r.json()).then(j=>{if(j.token)localStorage.setItem('sid',j.token);return 1})`, true);
  await send('Page.reload'); await sleep(2600);
  ok(await ev(`document.getElementById('turfGate').hidden === true`), '登录后进到自己的演武场');
  ok((await ev(`document.querySelectorAll('#turfModels .turf-card').length`)) >= 1, '演武场列出可上桌的模型/人机');
  await shot('ui-lobby.png');

  // ---- 建房间：我坐甲方，乙方空着 ----
  await ev(`document.getElementById('hNick').value='${nick}';document.getElementById('btnCreate').click()`);
  for (let i = 0; i < 30; i++) { await sleep(300); if (await ev(`!document.getElementById('pageRoom').hidden && !!document.getElementById('cardA')`)) break; }
  ok(await ev(`!document.getElementById('pageRoom').hidden`), '建完房间进到席位页');
  ok((await ev(`document.querySelectorAll('.seat-card').length`)) === 5, '房间是 2 个对战席 + 3 个观战席');
  ok(await ev(`document.getElementById('btnStart').disabled === true`), '平时开局是灰的（对局不能随便开）');

  // ---- 把内置人机放到乙方：放上去即准备 ----
  await ev(`(function(){const s=document.querySelector('[data-putsel="B"]');const i=[...s.options].findIndex(o=>o.value.startsWith('bot:'));s.selectedIndex=i;document.querySelector('[data-put="B"]').click()})()`);
  await sleep(900);
  ok(/乙方 已准备/.test(await text('#rReady')), '放上人机 = 乙方自动准备', await text('#rReady'));
  ok(await ev(`document.getElementById('btnStart').disabled === true`), '只有一方准备时仍然开不了局');

  // ---- 我点准备 → 双方准备好 → 开局 ----
  await ev(`document.querySelector('[data-ready="A"]').click()`);
  await sleep(800);
  ok(/甲方 已准备 · 乙方 已准备/.test(await text('#rReady')), '两边都点了准备', await text('#rReady'));
  ok(await ev(`document.getElementById('btnStart').disabled === false`), '双方准备后开局按钮亮起');
  await ev(`document.getElementById('btnStart').click()`);

  let live = false;
  for (let i = 0; i < 40 && !live; i++) { await sleep(400); live = await ev(`!document.getElementById('pagePlay').hidden && document.querySelectorAll('#diceA .die').length > 0`); }
  ok(live, '开局后进到牌桌，甲方的骰子发下来了');

  // ---- 视角：我这一席是输入区，对手那一席是推演区（不能互换） ----
  const view = JSON.parse(await ev(`JSON.stringify({
    myChips: document.querySelectorAll('#actA .action .chips button, #action .chips button').length,
    oppThink: (function(){const b=document.getElementById('thinkBoxB');const s=getComputedStyle(b);return s.display!=='none'})() ,
    oppAct: !!document.querySelector('#actB .action, #thinkBoxB .action'),
    oppDiceBack: document.querySelectorAll('#diceB .die.back').length,
    myDiceUp: document.querySelectorAll('#diceA .die:not(.back)').length })`));
  ok(view.myChips > 0, '我这栏是「个数 → 点数 → 走这一步」的输入按钮区（' + view.myChips + ' 个键）');
  ok(view.oppThink && !view.oppAct, '对手那栏是实时推演，不是我的操作区');
  ok(view.oppDiceBack > 0 && view.myDiceUp > 0, '我只看得见自己的骰面，对手是背面');

  // ---- 按按钮落子 ----
  const rowsBefore = await ev(`document.querySelectorAll('#logList .lg').length`);
  // 按按钮的 id / data 属性点，别靠文案碰运气（"普通抬价"这种文案长得像提交键）
  await ev(`(function(){const b=document.querySelector('[data-c="2"]');return b?(b.click(),1):0})()`);
  await sleep(200);
  await ev(`(function(){const b=document.querySelector('[data-f="2"]');return b?(b.click(),1):0})()`);
  await sleep(200);
  const go = await ev(`(function(){const b=document.getElementById('btnGo');if(!b)return '';const t=b.textContent.trim();b.click();return t})()`);
  await sleep(1500);
  const rowsAfter = await ev(`document.querySelectorAll('#logList .lg').length`);
  ok(rowsAfter > rowsBefore, '落子被服务端受理，全场流水多了一行', { rowsBefore, rowsAfter, go });
  ok(/喊|弃|开|叫/.test(await text('#bidBox')) || (await text('#bidBox')) !== '—', '对手接上了，中央喊价框有内容', await text('#bidBox'));

  // ---- 开盅：看得到亮牌和结算 ----
  // 人机现在有思考延迟：每轮开始时空价喊价没有「开盅」，先喊一手制造可开的局面，
  // 等它回完手轮到我，再点开盅。
  let opened = 0;
  for (let i = 0; i < 24 && !opened; i++) {
    opened = await ev(`(function(){const b=document.getElementById('btnOpen');if(!b)return 0;b.click();return 1})()`);
    if (opened) break;
    const bid = await ev(`(function(){const g=document.getElementById('btnGo');if(!g)return 0;g.click();return 1})()`);
    await sleep(bid ? 2000 : 700);
  }
  ok(opened === 1, '轮到我可以开盅，开盅键在');
  await sleep(2200);
  const settled = await ev(`(function(){const t=document.getElementById('panHist');const s=t?t.textContent:'';return s.length>0})()`);
  ok(settled, '开盅后「开盅记录」里有这一手的结果');
  await shot('ui-play.png');

  ok(errs.length === 0, '页面没有未捕获的脚本异常', errs.slice(0, 2));
  console.log(fails.length ? '==> UI FAIL ' + fails.length : '==> UI ALL PASS');
  console.log('截图：' + SHOTS + '/ui-play.png 与 ui-lobby.png');
  try { chrome.kill(); } catch (e) { }
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log('炸了：', e && e.message); process.exit(1); });
