#!/usr/bin/env node
/* 玩家页 · 轮次与开盅回归（真浏览器，零 token，只用内置人机）
 *
 * 目的很窄，但都是真出过的事：
 *  [A] 竞态：提交「开盅 / 喊价」的 POST 回调，会不会把服务端已经推下来的下一手按钮抹掉。
 *      这个 bug 靠自然时序只有一半概率撞上，所以这里把 /api/room/action 的响应人为延迟
 *      RACE_MS（默认 600ms），让「SSE 先到、POST 回调后到」变成必然时序 —— 修好后必须 0 违规。
 *  [B] 不变式：只要有一条「我还没应答的 ask」，出价区就必须有可点按钮；没有就是玩家被卡死。
 *  [C] 开盅记录归属与文案：喊价的人与开盅的人必须是两个名字，判定文案与实际输家一致。
 *  [D] 手机与桌面两种视口都跑（WIN=390,844 或 1400,1100），布局不同但不变式相同。
 *
 * 用法：BASE=http://127.0.0.1:8898 [WIN=390,844] [RACE_MS=600] [ROUNDS=6] node tests/ui-round-cycle.js
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const ROOT = path.join(__dirname, '..');
// 默认自己起一个临时对战服务：不依赖外部进程，也不会和别人的跑批抢限流窗口。
// 想对着已经跑着的桌子验，就显式给 BASE=http://127.0.0.1:8898。
const OWN = !process.env.BASE;
const PORT_SRV = +(process.env.PORT || 18800 + Math.floor(Math.random() * 180));
const BASE = process.env.BASE || 'http://127.0.0.1:' + PORT_SRV;
const WIN = process.env.WIN || '1400,1100';
/* 视口档位。必须在任何用到它的地方之前声明：const 有 TDZ，
 * 之前把 VW 声明放在 CDP 段之后，结果 Emulation 调用直接 ReferenceError。 */
const VW = +(WIN.split(',')[0] || 1200), VH = +(WIN.split(',')[1] || 900);
let NARROW = VW <= 820;              // 真正判定用实测 innerWidth，见 [D]
const RACE_MS = +(process.env.RACE_MS != null ? process.env.RACE_MS : 600);
const ROUNDS = +(process.env.ROUNDS || 6);
const BOT = process.env.BOT || 'oracle';
const PORT = +(process.env.UI_CDP_PORT || 9225);
const SHOTS = path.join(ROOT, 'runs', 'livedemo');
const PROF = path.join(SHOTS, 'ui-profile-' + PORT);
try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) { }
fs.mkdirSync(PROF, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
const gj = u => new Promise((r, j) => { const q = http.get(u, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => { try { r(JSON.parse(b)); } catch (e) { j(e); } }); }); q.on('error', j); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra).slice(0, 400))); } };

/* 页面加载前注入：竞态延迟 + 事件抄写 + 违规监视 */
const INJECT = `(function(){
  var RACE = ${RACE_MS};
  window.__viol = [];            // 违规：有未应答的 ask，却没有可点按钮
  window.__opens = [];           // 每条开盅：事件字段 + 那一刻页面「开盅记录」的文本
  window.__answeredAsk = 0;      // 我最近一次提交所应答的那条 ask
  window.__asks = 0;
  var of = window.fetch;
  window.fetch = function(u, o){
    var s = String(u);
    if (s.indexOf('/api/room/action') >= 0) {
      try {
        window.__answeredAsk = (typeof S !== 'undefined' && S.askSeq) || 0;
        if (window.__must && window.__must.askSeq === window.__answeredAsk) window.__must = null;
      } catch (e) {}
      window.__posts = (window.__posts || []);
      var p0 = { body: String((o && o.body) || '').slice(0, 90), askSeq: (typeof S !== 'undefined' && S.askSeq) || 0 };
      var rec = of.apply(window, arguments);
      // 注意：延迟必须在 wrapper 的最外层做。之前在 setTimeout 回调里写 of.apply(window, arguments)，
      // 那个 arguments 是回调自己的，等于把 POST 发成了空参请求 —— 竞态没注入，测试白跑。
      if (RACE > 0) rec = new Promise(function(res){ rec.then(function(r){ setTimeout(function(){ res(r); }, RACE); }); });
      rec.then(function(r){ return r.clone().text().then(function(t){ p0.status = r.status; p0.resp = t.slice(0, 120); window.__posts.push(p0); }); },
        function(err){ p0.resp = 'ERR ' + err; window.__posts.push(p0); });
      return rec;
    }
    return of.apply(window, arguments);
  };
  var ES = window.EventSource;
  window.EventSource = function(u, c){
    var es = new ES(u, c); var add = es.addEventListener.bind(es);
    es.addEventListener = function(n, fn){ return add(n, function(e){
      var d = null; try { d = JSON.parse(e.data || '{}'); } catch (x) {}
      var r0 = fn(e);            // 先让页面自己处理：askSeq 是在它的 handler 里 +1 的，先记就记成上一条
      if (n === 'ask') { window.__asks++; window.__must = { askSeq: (typeof S !== 'undefined' && S.askSeq) || 0, at: Date.now() }; }
      if (n === 'gameover' || n === 'matchover' || n === 'abandon' || n === 'aborted') { window.__must = null; }
      if (n === 'open' && d) {
        setTimeout(function(){
          var row = document.querySelector('#history .rset div') || document.querySelector('#history .rset');
          window.__opens.push({ bidBy: d.bidBy, openedBy: d.openedBy || d.who, loser: d.loser, truth: d.truth,
            round: d.round, text: row ? row.textContent.replace(/\\s+/g,' ').trim() : '',
            reveal: (function(){ var r = document.getElementById('reveal'); return r && !r.hidden ? r.textContent.replace(/\\s+/g,' ').trim() : ''; })() });
        }, 200);
      }
      return r0; }); };
    return es;
  };
  // 精确特征：服务端已经把「轮到我」推进来了（__must 立着），而我一次都没提交，
  // 出价区却变成了「已提交，等这一手落地。」这种占位 —— 玩家被锁死，只能干等到超时。
  function scan(from) {
    try {
      if (!window.__must) return;
      var el = document.getElementById('action'); if (!el) return;
      var txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (el.querySelectorAll('button').length > 0) return;          // 按钮在，正常
      if (!/已提交|等这一手落地|提交中/.test(txt)) return;            // 空着也别急着算违规，交给超时兜底
      window.__viol.push({ round: (typeof S !== 'undefined' && S.view && S.view.roundNo) || null,
        askSeq: (typeof S !== 'undefined' && S.askSeq) || 0, answered: window.__answeredAsk,
        submitted: (typeof S !== 'undefined' && S.submitted), sinceAskMs: Date.now() - window.__must.at,
        why: from, actText: txt.slice(0, 60) });
      window.__must = null;
    } catch (e) {}
  }
  document.addEventListener('DOMContentLoaded', function(){
    var el = document.getElementById('action');
    if (!el) return;
    new MutationObserver(function(){ scan('observer'); }).observe(el, { childList: true, subtree: true, characterData: true });
  });
  // 兜底：ask 之后 2s 还没有按钮也没提交，同样算被锁死
  setInterval(function(){
    try {
      if (!window.__must || Date.now() - window.__must.at < 2000) return;
      var el = document.getElementById('action'); if (!el) return;
      if (el.querySelectorAll('button').length > 0) { window.__must = null; return; }
      window.__viol.push({ askSeq: window.__must.askSeq, answered: window.__answeredAsk, why: 'ask 之后 2s 仍无按钮',
        actText: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
      window.__must = null;
    } catch (e) {}
  }, 250);
})();`;

(async () => {
  let srv = null, dataDir = null;
  if (OWN) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dice-roundcycle-'));
    srv = spawn(process.execPath, [path.join(ROOT, 'src', 'room-server.js')], {
      env: Object.assign({}, process.env, {
        PORT: String(PORT_SRV), HOST: '127.0.0.1', DICE_DATA_DIR: dataDir,
        DICE_RATE_CREATE: '400', DICE_RATE_SIGNUP: '400', DICE_RATE_LOGIN: '400',
        DICE_BOT_DELAY_MS: process.env.DICE_BOT_DELAY_MS || '260',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { const j = await gj(BASE + '/api/ping'); up = j && j.ok; } catch (e) { } if (!up) await sleep(150); }
    ok(up, '临时对战服务已起来（端口 ' + PORT_SRV + '，限流放宽，人机零思考延迟）');
    if (!up) { console.log('服务日志：', (srv.stdout ? srv.stdout.toString() : '').slice(0, 500)); process.exit(1); }
  }
  const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--user-data-dir=' + PROF, '--remote-debugging-port=' + PORT, '--window-size=' + WIN, BASE + '/web/play.html'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { try { const j = await gj('http://127.0.0.1:' + PORT + '/json/list'); target = (j || []).find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch (e) { } await sleep(300); }
  if (!target) { console.log('拿不到 Chrome 调试目标'); chrome.kill(); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((r, j) => { const k = ++id; pend.set(k, { r, j }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.j(new Error(JSON.stringify(m.error))) : q.r(m.result); }
  };
  await send('Runtime.enable'); await send('Page.enable');
  /* 视口必须显式设定。之前只靠 --window-size，headless 里页面的 innerWidth 其实只有 500x701，
   * 于是「桌面档 WIN=1400,1100」一直在偷偷测手机档，桌面断言形同虚设。 */
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: VW <= 820 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
  /* BREAK='<js>'：进牌桌后执行一段 JS，故意打破某条适配规则，用来证明 [D] 的探针真会报警。
   * 例：BREAK="document.querySelector('.topright').style.flexWrap='nowrap'" 应当报出顶栏按钮被裁。 */
  await send('Page.navigate', { url: BASE + '/web/play.html' }); await sleep(2600);
  const ev = async (x, w = false) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: w });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text); return r.result && r.result.value; };

  console.log('视口 ' + WIN + (NARROW ? '（手机档）' : '（桌面档）') + '，把 /api/room/action 的响应延迟 ' + RACE_MS + 'ms（强制「SSE 先到、POST 回调后到」）');

  /* 布局探针。目的：手机模式下「看不清 / 按不准 / 要横着滚 / 出价键在屏幕外」这四类问题
   * 一旦漂回去，在他手机上都是实打实的用不下去，所以它们和游戏逻辑一样是回归对象。
   * 阈值来自手机适配那一轮的审计结果：可见文字 >=12px、可点元素 >=44px、不横向溢出。 */
  const LAYOUT = `(function () {
    const seen = {}, tiny = [], tap = [], clip = [];
    /* 用 clientWidth 而不是 innerWidth：内容超宽时移动端布局视口会跟着胀，
     * innerWidth 反而看不出溢出——顶栏按钮被裁掉就是这么漏掉的 */
    const cw = document.documentElement.clientWidth;
    const painted = el => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
    const path = el => { let s = el.tagName.toLowerCase(), c = el, d = 0;
      while (c && d < 3) { if (c.className && typeof c.className === 'string') s = c.tagName.toLowerCase() + '.' + c.className.trim().split(/\\s+/).slice(0, 2).join('.') + ' ' + s; c = c.parentElement; d++; }
      return s.slice(0, 60); };
    for (const el of document.querySelectorAll('body *')) {
      if (!el.textContent.trim() || !painted(el)) continue;
      const f = parseFloat(getComputedStyle(el).fontSize);
      if (f < 11.9) { const k = f.toFixed(1) + '|' + path(el); if (!seen[k]) { seen[k] = 1; tiny.push(f.toFixed(1) + 'px ' + path(el) + ' 「' + el.textContent.trim().slice(0, 10) + '」'); } }
      if (el.tagName === 'BUTTON' || el.tagName === 'A') {
        const r = el.getBoundingClientRect();
        if (r.height < 43 || r.width < 30) tap.push((el.textContent.trim().slice(0, 8) || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    }
    for (const el of document.querySelectorAll('body *')) {
      if (!painted(el)) continue;
      /* 只管有内容或可点的东西：背景装饰（光晕、渐变块）本来就该出血，不该算裁切 */
      if (!el.textContent.trim() && !['BUTTON', 'A', 'INPUT', 'SELECT', 'IMG'].includes(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      /* 被祖先 overflow:hidden 包住的装饰（如卡片光晕）本来就会被裁，不算问题；
         只有「没被任何容器接住、直接伸出视口」的才算。 */
      let inside = false;
      for (let pp = el.parentElement; pp && pp !== document.documentElement; pp = pp.parentElement) {
        const o = getComputedStyle(pp).overflowX;
        if (o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll') { inside = true; break; }
      }
      if (!inside && r.width > 6 && r.right > cw + 1) { const k = 'clip|' + path(el); if (!seen[k]) { seen[k] = 1; clip.push(path(el) + ' 右缘 ' + Math.round(r.right) + ' > 视口 ' + cw + '「' + el.textContent.trim().slice(0, 8) + '」'); } }
    }
    return { overflow: Math.max(0, Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - cw), cw, tiny, tap, clip };
  })()`;

  // 出价区位置探针：窄屏必须吸底且轮到我时键在视口内；桌面必须仍在我方卡片里（placeAction 的桌面分支）
  const GEO = `(function () {
    const bar = document.querySelector('.actionbar'), act = document.getElementById('action');
    const go = document.getElementById('btnGo') || document.getElementById('btnOpen');
    const r = go ? go.getBoundingClientRect() : null;
    const ar = document.getElementById('arena');
    let order = null;
    if (ar) { ar.classList.add('me-b');
      order = [...ar.children].map(e => ({ k: e.id || String(e.className).split(' ')[0], t: Math.round(e.getBoundingClientRect().top + window.scrollY) }))
        .sort((a, b) => a.t - b.t).map(x => x.k).join('>');
      ar.classList.remove('me-b'); }
    return { barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
      actionParent: act && (act.parentElement.id || String(act.parentElement.className)),
      barPos: bar ? getComputedStyle(bar).position : null,
      goInView: r ? (r.top >= 0 && r.bottom <= innerHeight + 1) : null,
      goH: r ? Math.round(r.height) : null, order };
  })()`;
  const nick = 'rc' + Date.now().toString(36).slice(-5);
  await ev(`fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nick:'${nick}',pass:'pw-${nick}'})}).then(r=>r.json()).then(j=>{if(j.token)localStorage.setItem('sid',j.token);return 1})`, true);
  await send('Page.navigate', { url: BASE + '/web/play.html' }); await sleep(2600);
  await ev(`(function(){var b=document.querySelector('[data-fight="bot:${BOT}"]');if(b)b.click()})()`);
  let inPlay = false;
  for (let i = 0; i < 40 && !inPlay; i++) { await sleep(400); inPlay = await ev(`!document.getElementById('pagePlay').hidden`); }
  ok(inPlay, '进到牌桌（跟内置人机 ' + BOT + ' 开练）', { homeMsg: (await ev(`(document.getElementById('homeMsg')||{}).textContent || ''`)) });
  if (process.env.BREAK) { await ev(process.env.BREAK); console.log('  已故意打破适配规则（探针应当报警）：' + process.env.BREAK); }

  const state = () => ev(`JSON.stringify({msg:(document.getElementById('actMsg')||{}).textContent,submitted:S.submitted,round:S.view&&S.view.roundNo,turn:S.view&&S.view.turn,btns:document.querySelectorAll('#action button').length,
    askSeq:S.askSeq||0,answered:window.__answeredAsk,viol:(window.__viol||[]).length,opens:(window.__opens||[]).length,
    over:S.view&&S.view.over,state:S.room&&S.room.state,hp:S.room&&S.room.hp})`);

  // 打够 ROUNDS 轮：轮到我就有开盅就开盅（结算路径要真被打到），否则喊一手
  let acted = 0, lastRound = 0, waited = 0, geo = null;
  while (waited++ < 240) {
    const s = JSON.parse(await state());
    if (s.viol > 0) break;                            // 已经违规，别再往下走，留着现场
    if (s.over || s.state === 'finished' || s.round > ROUNDS) break;
    if (s.turn !== 'me' || s.btns === 0) { await sleep(300); continue; }
    const opened = await ev(`(function(){var b=document.getElementById('btnOpen');if(!b)return 0;b.click();return 1})()`);
    if (!opened) {
      await ev(`(function(){var b=document.querySelector('[data-c="3"]');if(b)b.click()})()`); await sleep(150);
      await ev(`(function(){var b=document.querySelector('[data-f="4"]');if(b)b.click()})()`); await sleep(150);
      await ev(`(function(){var b=document.getElementById('btnGo');if(b)b.click()})()`);
    }
    if (!geo) { try { geo = await ev(GEO, true); } catch (e) { geo = { err: e.message }; } }
    acted++; lastRound = s.round;
    await sleep(400);
  }
  const fin = JSON.parse(await state());
  console.log('  打了 ' + acted + ' 手，走到第 ' + (fin.round || lastRound) + ' 轮，开盅 ' + fin.opens + ' 次，违规 ' + fin.viol + ' 次');

  const viol = JSON.parse(await ev('JSON.stringify(window.__viol||[])', true));
  const opens = JSON.parse(await ev('JSON.stringify(window.__opens||[])', true));
  const names = JSON.parse(await ev(`JSON.stringify({A:(S.gameAt&&S.gameAt.A)||((S.room&&S.room.seats.A)||{}).nick,B:(S.gameAt&&S.gameAt.B)||((S.room&&S.room.seats.B)||{}).nick})`, true));

  console.log('[A/B] 竞态与不变式');
  ok(acted > 0, '确实动手打了（' + acted + ' 手）', fin);
  ok(fin.opens >= 2, '开盅路径被打到 ' + fin.opens + ' 次（竞态就发生在这一手之后）', fin);
  ok(viol.length === 0, '没有任何一次「未应答的 ask 却没有可点按钮」（违规 ' + viol.length + ' 次）', viol.slice(0, 3));
  const posts = JSON.parse(await ev('JSON.stringify(window.__posts||[])', true));
  ok(errs.length === 0, '页面无未捕获脚本异常', errs.slice(0, 2));

  if (viol.length || fin.acted === undefined) console.log('  最后几次提交：', JSON.stringify(posts.slice(-4)));
  console.log('[C] 开盅记录：归属与判定文案');
  if (!opens.length || !(opens[0].text || opens[0].reveal)) console.log('  开盅事件原文：', JSON.stringify(opens.slice(0, 2)));
  const checked = opens.filter(o => o.text || o.reveal);
  ok(checked.length > 0, '开盅记录被读到 ' + checked.length + ' 条');
  let attrBad = [], wordBad = [];
  for (const o of checked) {
    const bidName = o.bidBy === 'A' ? names.A : names.B;
    const openName = o.openedBy === 'A' ? names.A : names.B;
    const txt = o.reveal || o.text;
    if (o.bidBy && o.openedBy && o.bidBy !== o.openedBy) {
      if (!(txt.includes(bidName) && txt.includes(openName)) || bidName === openName) attrBad.push({ round: o.round, names: [bidName, openName], txt: txt.slice(0, 90) });
    }
    const want = o.truth ? '开的人输' : '喊的人输';
    const other = o.truth ? '喊的人输' : '开的人输';
    if (!txt.includes(want) || txt.includes(other)) wordBad.push({ round: o.round, truth: o.truth, want, txt: txt.slice(0, 110) });
  }
  ok(attrBad.length === 0, '喊价人与开盅人印的是两个名字（错 ' + attrBad.length + ' 条）', attrBad.slice(0, 2));
  ok(wordBad.length === 0, '判定文案与实际输家一致：够数→开的人输 / 不够→喊的人输（错 ' + wordBad.length + ' 条）', wordBad.slice(0, 2));

  const realW = await ev('innerWidth');
  NARROW = realW <= 820;
  ok(realW === VW, '视口真的是 ' + VW + 'px 宽（实测 ' + realW + '，不实测就会偷偷测错档）', { realW, VW });
  console.log('[D] 布局（' + (NARROW ? '手机档 ' + realW + 'px' : '桌面档 ' + realW + 'px') + '）');
  console.log('  几何：' + JSON.stringify(geo) + '　innerWidth=' + await ev('innerWidth + "x" + innerHeight + " compact=" + isCompact()'));
  /* 先把状态牌撑成真实最坏情况再测布局：房号 + 长昵称都塞进去。
   * 不加这一步，「顶栏被挤出屏幕」这类问题只在内容长的时候出现，测试会假绿。 */
  await ev(`(()=>{const n=document.getElementById('net'),w=document.getElementById('who');
    if(n){n.dataset.t=n.textContent;n.textContent='已连接 · 房 AB12CD';}
    if(w){w.dataset.t=w.textContent;w.textContent='wang-er-dayu-1991';}
    const b=document.getElementById('btnAuth'); if(b){b.dataset.t=b.textContent;b.textContent='退出登录';} return 1})()`, true);
  const lay = await ev(LAYOUT, true);
  const rawDbg = await ev(`({VW:${VW}, innerWidth:innerWidth, docElClient:document.documentElement.clientWidth,
    docElScroll:document.documentElement.scrollWidth, bodyScroll:document.body.scrollWidth,
    topClient:(document.querySelector('.top')||{}).clientWidth, topScroll:(document.querySelector('.top')||{}).scrollWidth,
    trClient:(document.querySelector('.topright')||{}).clientWidth, trScroll:(document.querySelector('.topright')||{}).scrollWidth,
    authRight:Math.round((document.getElementById('btnAuth')||{getBoundingClientRect:()=>({right:-1})}).getBoundingClientRect().right),
    bodyOverflowX:getComputedStyle(document.body).overflowX, trWrap:(document.querySelector('.topright')?getComputedStyle(document.querySelector('.topright')).flexWrap:'-'),
    trKids:[...document.querySelectorAll('.topright > *')].map(e=>e.tagName[0]+':'+Math.round(e.getBoundingClientRect().width)).join(','),
    trRight:Math.round((function(){const k=document.querySelectorAll('.topright > *');return k.length?k[k.length-1].getBoundingClientRect().right:0})())})`, true, true);   // 必须在恢复文案之前采样，否则测的是压力解除后的样子
  await ev(`(()=>{const n=document.getElementById('net'),w=document.getElementById('who'),b=document.getElementById('btnAuth');
    if(n&&n.dataset.t)n.textContent=n.dataset.t; if(w&&w.dataset.t)w.textContent=w.dataset.t; if(b&&b.dataset.t)b.textContent=b.dataset.t; return 1})()`, true);
  if (lay.tiny.length) console.log('  过小字号：', lay.tiny.slice(0, 6).join(' / '));
  if (lay.tap.length) console.log('  过小触控：', lay.tap.slice(0, 6).join(' / '));
  if (lay.clip && lay.clip.length) console.log('  被裁掉的内容：', lay.clip.slice(0, 5).join(' / '));
  console.log('  宽度原始值（压力状态下）：', JSON.stringify(rawDbg));

  ok(lay.overflow === 0, '没有横向溢出（内容比视口宽 ' + lay.overflow + 'px，视口 ' + lay.cw + '）', { overflow: lay.overflow, cw: lay.cw });
  ok((lay.clip || []).length === 0, '没有内容伸出视口被裁掉（发现 ' + (lay.clip || []).length + ' 处）', (lay.clip || []).slice(0, 4));
  if (NARROW) {
    ok(lay.tiny.length === 0, '可见文字都 >=12px（超标 ' + lay.tiny.length + ' 处）', lay.tiny.slice(0, 4));
    ok(lay.tap.length === 0, '可点元素都 >=43px 高（超标 ' + lay.tap.length + ' 处）', lay.tap.slice(0, 4));
    ok(geo && geo.actionParent === 'actionbar', '出价区留在吸底操作条里（实际 ' + (geo && geo.actionParent) + '）', geo);
    ok(geo && geo.barPos === 'sticky', '操作条是 sticky 吸底（实际 ' + (geo && geo.barPos) + '）', geo);
    ok(geo && geo.goInView === true, '轮到我时「走这一步」在首屏视口内，不用滚（几何 ' + JSON.stringify(geo) + '）', geo);
    ok(geo && /^fighterB.*table.*fighterA|fighterA.*table.*fighterB$/.test(String(geo.order)) && String(geo.order).indexOf('fighterB') === 0,
      '我坐乙方时我方卡片排在牌桌与对手之上（顺序 ' + (geo && geo.order) + '）', geo);
  } else {
    ok(/^act[AB]$/.test(String(geo.actionParent)), '桌面上出价区仍在我方卡片的 act 位里（实际 ' + (geo && geo.actionParent) + '）', geo);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(SHOTS, 'round-cycle-' + WIN.replace(/,/g, 'x') + '.png'), Buffer.from(shot.data, 'base64'));
  console.log(fail ? '==> ROUND CYCLE FAIL ' + fail : '==> ALL PASS');
  console.log('通过 ' + pass + ' / 失败 ' + fail + '　截图 runs/livedemo/round-cycle-' + WIN.replace(/,/g, 'x') + '.png');
  try { chrome.kill(); } catch (e) { }
  if (srv) { try { srv.kill('SIGKILL'); } catch (e) { } }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('炸了：', e && e.message); process.exit(1); });
