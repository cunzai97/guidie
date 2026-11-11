/* 鬼骰 · 实时对战前端（无框架、无依赖）
 * 只认三样东西：房间信息（脱敏）、自己那份视角（ask 事件）、公开事件流（SSE）。
 * 骰子真值、合法动作集合、结算全在服务端算；这里的按钮列表直接来自视角里的 legal 字段。
 */
'use strict';
// 允许 $('homeMsg') 和 $('#homeMsg') 两种写法：这套代码里两种都出现过，
// 直接 getElementById 会把 '#xxx' 当 id 取不到 → 后面 .textContent 就炸（页面静默半瘫）。
const $ = id => document.getElementById(String(id).replace(/^#/, ''));
const FACE_LABEL = { 1: '1（最大·斋）', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6' };
const KIND_LABEL = { open: '空位·等邀请', me: '真人', llm: '大模型', preset: '平台模型', bot: '内置人机' };

const S = {
  sid: localStorage.getItem('sid') || '', me: null, ping: null,
  room: null, plan: null, seatToken: '', role: 'spec',
  view: null, es: null, gameAt: { A: '甲方', B: '乙方' },
  stats: null, timer: null, sel: null, submitted: false,
};

async function api(path, body, method) {
  const opt = { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' } };
  if (S.sid) opt.headers.Authorization = 'Bearer ' + S.sid;
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}
function msg(el, text, cls) { const e = typeof el === 'string' ? $(el) : el; e.textContent = text || ''; e.className = 'msg ' + (cls || ''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function show(page) { for (const p of ['pageHome', 'pageRoom', 'pagePlay']) $(p).hidden = (p !== page); }
function sec(n) { return n >= 1000 ? (n / 1000).toFixed(0) + 's' : n + 's'; }

// 骰面用 3×3 点阵，跟 web/arena.js 的 PIPS 同一张表、同一画法：
// 两个页面并排看是同一副骰子，而不是「一个显示数字、一个显示点」。
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function diceHtml(list, zhai) {
  return (list || []).map(d => {
    let cells = '';
    for (let i = 0; i < 9; i++) cells += `<i class="${(PIPS[d] || []).includes(i) ? 'on' : ''}"></i>`;
    return `<div class="die ${d === 1 && !zhai ? 'wild' : ''}">${cells}</div>`;
  }).join('');
}

/* ---------------- 座位选择器 ---------------- */
function seatPicker(host, opts) {
  // $() 是按 id 取的简写，别把 '#seatA' 当选择器传进来（取不到就是 null，整块座位选择器会静默不出）
  const el = typeof host === 'string' ? $(host.replace(/^#/, '')) : host;
  if (!el) { console.error('座位选择器找不到容器：', host); return { get: () => ({ kind: 'open' }) }; }
  const kinds = opts.kinds;
  let kind = kinds[0];
  let st = { kind, nick: opts.nick || '', configId: '', baseUrl: '', model: '', apiKey: '', alias: '', bot: '', presetId: '', guideText: '', effort: 'medium' };

  function render() {
    const cfgs = (S.me && S.me.configs || []).filter(c => c.kind === 'llm');
    el.innerHTML = `
      <div class="segtabs">${kinds.map(k => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${KIND_LABEL[k]}</button>`).join('')}</div>
      <div class="body"></div>`;
    el.querySelectorAll('.segtabs button').forEach(b => b.onclick = () => { kind = b.dataset.k; st.kind = kind; render(); });
    const b = el.querySelector('.body');
    if (kind === 'open') {
      b.innerHTML = `<div class="hint">这一座留空，把邀请链接发给朋友，他点进来自动入座。</div>`;
      return;
    }
    if (kind === 'me') {
      b.innerHTML = `<div class="field"><input class="nick" placeholder="你的昵称" maxlength="24" value="${esc(st.nick)}"></div>
        <div class="hint">你本人手打。每手有思考时限，超时按桌规自动接手或判负。</div>`;
      b.querySelector('.nick').oninput = e => { st.nick = e.target.value; if (opts.onNick) opts.onNick(st.nick); };
      return;
    }
    if (kind === 'bot') {
      const bots = (S.ping && S.ping.bots) || [];
      b.innerHTML = `<div class="field"><select class="bot">${bots.map(x => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select>
        <div class="hint">${esc((bots[0] || {}).desc || '')}</div></div>`;
      b.querySelector('.bot').onchange = e => { st.bot = e.target.value; };
      st.bot = st.bot || (bots[0] && bots[0].id) || 'reader';
      b.querySelector('.bot').value = st.bot;
      return;
    }
    if (kind === 'preset') {
      const ms = (S.ping && S.ping.models) || [];
      b.innerHTML = `<div class="field"><select class="pm">${ms.map(x => `<option value="${esc(x.id)}">${esc(x.alias)} · ${esc(x.model)}${x.hasKey ? '' : '（无 Key）'}</option>`).join('')}</select>
        <div class="hint">平台预设：端点与 Key 都在服务器侧，不下发给你，也不消耗你的额度。可以另填你的必胜秘诀。</div></div>
        <div class="field"><textarea class="guide" rows="5" maxlength="2000" placeholder="这一座的必胜秘诀（可选，留空用平台默认「这局怎么赢」）">${esc(st.guideText)}</textarea></div>`;
      b.querySelector('.pm').onchange = e => { st.presetId = e.target.value; };
      b.querySelector('.guide').oninput = e => { st.guideText = e.target.value; };
      st.presetId = st.presetId || (ms[0] && ms[0].id) || '';
      if (ms[0]) b.querySelector('.pm').value = ms[0].id;
      return;
    }
    // llm
    if (S.me && cfgs.length) {
      b.innerHTML = `<div class="field"><select class="cfg"><option value="">用我保存的配置…</option>${cfgs.map(c => `<option value="${c.id}">${esc(c.name)} · ${esc(c.model)}${c.hasKey ? ' · 有 Key' : ' · 无 Key'}</option>`).join('')}</select></div>
        <div class="field"><textarea class="guide" rows="5" maxlength="2000" placeholder="必胜秘诀（默认沿用配置里的）">${esc(st.guideText)}</textarea></div>
        <div class="hint">Key 从你账号里解密取用，界面与战绩里都不出现明文；换座位换桌都要重新上桌，Key 不写进房间快照。</div>`;
      b.querySelector('.cfg').onchange = e => {
        st.configId = e.target.value;
        const c = cfgs.find(x => x.id === st.configId);
        if (c && !st.guideText) { b.querySelector('.guide').value = c.guideText || ''; st.guideText = c.guideText || ''; }
      };
      b.querySelector('.guide').oninput = e => { st.guideText = e.target.value; };
      return;
    }
    b.innerHTML = `<div class="field"><input class="base" placeholder="Base URL，例如 https://api.xxx.com/v1" value="${esc(st.baseUrl)}"></div>
      <div class="field"><input class="model" placeholder="模型 ID" value="${esc(st.model)}"></div>
      <div class="field"><input class="key" placeholder="API Key（只进服务器内存，不落盘）" value=""></div>
      <div class="field"><textarea class="guide" rows="5" maxlength="2000" placeholder="你的必胜秘诀（只替换策略段）">${esc(st.guideText)}</textarea></div>
      <div class="hint">没登录：Key 只活在这一桌，桌散即焚。登录后可存进账号反复用（落盘加密）。</div>`;
    b.querySelector('.base').oninput = e => { st.baseUrl = e.target.value; };
    b.querySelector('.model').oninput = e => { st.model = e.target.value; };
    b.querySelector('.key').oninput = e => { st.apiKey = e.target.value; };
    b.querySelector('.guide').oninput = e => { st.guideText = e.target.value; };
  }
  render();
  return {
    get kind() { return kind; },
    refresh: render,
    async spec() {
      if (kind === 'open') return { kind: 'open' };
      if (kind === 'me') return { kind: 'me', nick: st.nick || opts.nick || '玩家' };
      if (kind === 'bot') return { kind: 'bot', bot: st.bot };
      if (kind === 'preset') return { kind: 'preset', presetId: st.presetId, guideText: st.guideText || null };
      if (st.configId) return { kind: 'llm', configId: st.configId, guideText: st.guideText || null };
      if (!st.baseUrl || !st.model) throw new Error('模型座位要填 Base URL 与模型 ID');
      const r = await api('/api/secret', { baseUrl: st.baseUrl, model: st.model, apiKey: st.apiKey || null, guideText: st.guideText || null });
      return { kind: 'llm', secretToken: r.secretToken, baseUrl: st.baseUrl, model: st.model, guideText: st.guideText || null };
    },
  };
}

/* ---------------- 首页 ---------------- */
async function initHome() {
  const q = new URLSearchParams(location.search);
  if (q.get('room')) { $('jCode').value = q.get('room').toUpperCase(); }
  $('hNick').value = (S.me && S.me.nick) || localStorage.getItem('nick') || '';
  $('jNick').value = $('hNick').value;
  const rules = (S.ping && S.ping.rules) || [];
  $('hRules').innerHTML = rules.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  if (S.me && S.me.prefs) {
    if (S.me.prefs.hpMax) $('hHp').value = S.me.prefs.hpMax;
    if (S.me.prefs.turnMs) $('hTurn').value = Math.round(S.me.prefs.turnMs / 1000);
    if (S.me.prefs.maxRounds) $('hRounds').value = S.me.prefs.maxRounds;
    $('hDup').checked = !!S.me.prefs.duplicate;
  }
  pickA = seatPicker('seatA', { kinds: ['me', 'llm', 'bot', 'preset'], nick: $('hNick').value });
  pickB = seatPicker('seatB', { kinds: ['open', 'llm', 'bot', 'preset', 'me'], nick: '' });
  loadRooms(); loadMatches();
}
let pickA = null, pickB = null;

$('hBudgetWrap') && 0;
function wireHome() {
  $('hToken').onchange = e => { $('hBudgetWrap').style.display = e.target.checked ? '' : 'none'; };
  $('btnCreate').onclick = async () => {
    msg('#homeMsg', '建桌中…');
    try {
      const seats = { A: await pickA.spec(), B: await pickB.spec() };
      const r = await api('/api/room/create', {
        title: $('hTitle').value, seats, rules: $('hRules').value,
        hpMax: +$('hHp').value, turnMs: (+$('hTurn').value) * 1000, maxRounds: +$('hRounds').value,
        duplicate: $('hDup').checked, pass: $('hPass').value || null,
        tokenBudget: $('hToken').checked ? +$('hBudget').value : 0,
      });
      localStorage.setItem('nick', seats.A.nick || '');
      enterRoom(r.code, r.you ? r.you.seat : 'spec', r.you ? r.you.token : '', r.room);
      msg('#homeMsg', '');
    } catch (e) { msg('#homeMsg', e.message, 'bad'); }
  };
  $('btnJoin').onclick = async () => {
    const code = $('jCode').value.trim().toUpperCase();
    if (!code) return msg('#homeMsg', '先填房间码', 'bad');
    try {
      // 先试入座乙方；乙方满了就试甲方；都不行则观战
      let r = null, err = '';
      for (const seat of ['B', 'A']) {
        try { r = await api('/api/room/join', { code, seat, nick: $('jNick').value, pass: $('jPass').value }); break; }
        catch (e) { err = e.message; }
      }
      const info = await api('/api/room/' + code);
      enterRoom(code, r ? r.seat : 'spec', r ? r.token : '', info.room);
      if (!r) msg('#roomMsg', '没能入座（' + err + '），先进来看战。');
    } catch (e) { msg('#homeMsg', e.message, 'bad'); }
  };
}
async function loadRooms() {
  try {
    const r = await api('/api/rooms');
    $('roomList').innerHTML = r.rooms.length ? r.rooms.map(x =>
      `<div class="row"><b>${esc(x.code)}</b><span>${esc(x.title || '')}</span>
       <span class="chip">${esc(x.rulesId)} · ${x.hpMax}血</span>
       <span class="chip ghost">${x.seats.A === 'open' ? '甲空' : '甲有人'}/${x.seats.B === 'open' ? '乙空' : '乙有人'}</span>
       <button class="btn sm" data-c="${esc(x.code)}">进</button></div>`).join('') : '<div class="hint">还没有公开桌在等。</div>';
    $('roomList').querySelectorAll('button').forEach(b => b.onclick = () => { $('jCode').value = b.dataset.c; $('btnJoin').click(); });
  } catch (e) { }
}
async function loadMatches() {
  try {
    const r = await api('/api/matches?limit=12');
    $('matchList').innerHTML = r.matches.length ? r.matches.map(m => {
      const w = m.draw ? '平' : (m.winner ? (m.seats[m.winner] || {}).alias + ' 胜' : '—');
      return `<div class="row"><span class="chip ghost">${new Date(m.t).toLocaleTimeString()}</span>
        <span>${esc((m.seats.A || {}).alias || '?')} vs ${esc((m.seats.B || {}).alias || '?')}</span>
        <span class="chip">${w}</span><span class="chip ghost">${m.rounds}轮 · ${esc((m.rules && m.rules.name) || '')}</span></div>`;
    }).join('') : '<div class="hint">还没有战绩。</div>';
  } catch (e) { }
}

/* ---------------- 房间 ---------------- */
function enterRoom(code, plan, token, room) {
  S.room = room; S.plan = plan; S.seatToken = token || ''; S.role = plan;
  if (token) localStorage.setItem('seat:' + code, token);
  show('pageRoom');
  $('rCode').textContent = code;
  connect();
  renderRoom();
}
function renderRoom() {
  const r = S.room; if (!r) return;
  $('rTitle').textContent = r.title ? '· ' + r.title : '';
  $('rState').textContent = { lobby: '等待开局', playing: '正在打', finished: '打完了', aborted: '中断' }[r.state] || r.state;
  const card = p => {
    const s = r.seats[p];
    const me = S.plan === p;
    return `<div class="card" style="margin:0 0 8px">
      <h3>${p === 'A' ? '甲方' : '乙方'} ${me ? '<span class="chip on">你</span>' : ''}</h3>
      <div class="kv"><b>${esc(s.nick || '（空位·等邀请）')}</b> · ${KIND_LABEL[s.kind]}</div>
      <div class="kv">${s.model ? '模型 ' + esc(s.model) : ''}${s.bot ? '人机 ' + esc(s.bot) : ''}
        ${s.armLabel ? '<br>秘诀：' + esc(s.armLabel) + (s.guideChars ? '（' + s.guideChars + ' 字）' : '') : ''}
        ${s.hasKey ? '<br>Key：已带（服务器内存）' : ''}
        ${s.effort && s.model ? ' · 思考 ' + esc(s.effort) : ''}</div>
      <div class="kv">${s.kind === 'me' ? (s.connected ? '<span class="chip on">在线</span>' : '<span class="chip">离线</span>') : '<span class="chip ghost">AI 座位</span>'}</div>
    </div>`;
  };
  $('seatCards').innerHTML = card('A') + card('B');
  $('rCfg').innerHTML = `规则 <b>${esc(r.rulesName)}</b>（${esc(r.rulesHash)}） · 血量 <b>${r.hpMax}</b> · 每手 <b>${sec(Math.round(r.turnMs / 1000))}</b>
    · 超时 <b>${r.onTimeout === 'forfeit' ? '判负' : '自动接手'}</b> · ${r.duplicate ? '<b>复式</b>（同骰换座）' : '单局'} · 最多 ${r.maxRounds} 轮
    ${r.tokenBudget ? ' · token 预算 ' + r.tokenBudget + '（已用 ' + r.usedTokens + '）' : ''}`;
  $('ruleNote').innerHTML = '邀请链接：<code>' + location.origin + location.pathname + '?room=' + r.code + '</code><br>'
    + '把它发给朋友，他点进来自动填房号；若你设了口令，他得填口令才能入座。'
    + (S.plan === 'spec' ? '<br><b>你现在是观战</b>：看不到任何人的骰子，结算才亮牌。' : '');
  $('btnStart').disabled = !(r.state === 'lobby') || S.plan === 'spec' || r.seats.A.kind === 'open' || r.seats.B.kind === 'open';
}
$('btnCopy') && 0;
function wireRoom() {
  $('btnCopy').onclick = () => {
    const url = location.origin + location.pathname + '?room=' + S.room.code;
    navigator.clipboard && navigator.clipboard.writeText(url);
    msg('#roomMsg', '已复制：' + url, 'ok');
  };
  $('btnStart').onclick = async () => {
    msg('#roomMsg', '开局中…');
    try { const r = await api('/api/room/start', { code: S.room.code, token: S.seatToken }); S.room = r.room; renderRoom(); msg('#roomMsg', ''); }
    catch (e) { msg('#roomMsg', e.message, 'bad'); }
  };
  $('btnLeave').onclick = () => { disconnect(); S.room = null; show('pageHome'); loadRooms(); loadMatches(); };
  $('btnBackRoom').onclick = () => show('pageRoom');
  $('btnResign').onclick = async () => {
    try { await api('/api/room/resign', { code: S.room.code, seat: S.plan, token: S.seatToken }); } catch (e) { msg('#actMsg', e.message, 'bad'); }
  };
}

/* ---------------- SSE ---------------- */
function connect() {
  disconnect();
  const r = S.room;
  const q = 'role=' + encodeURIComponent(S.plan || 'spec') + (S.seatToken ? '&token=' + encodeURIComponent(S.seatToken) : '');
  const es = new EventSource('/api/room/' + r.code + '/stream?' + q);
  S.es = es;
  es.onopen = () => { $('net').textContent = '已连接 · 房 ' + r.code; $('net').className = 'chip on'; };
  es.onerror = () => { $('net').textContent = '重连中…'; $('net').className = 'chip'; };
  // EventSource 自己也会发一个原生 'open'（连接刚建立时），那条没有 data；
  // 服务端这边恰好也有个叫 open 的「开盅」事件——没 data 的一律当原生事件丢掉，不然会把 null 传进结算渲染。
  const on = (name, fn) => es.addEventListener(name, e => {
    if (e.data == null) return;
    let d = null; try { d = JSON.parse(e.data); } catch (err) { }
    if (d == null) return;
    fn(d);
  });
  on('hello', d => {
    if (d.room) S.room = d.room;
    if (d.view) { S.view = d.view; if (d.view && !d.view.over && S.plan !== 'spec') show('pagePlay'); }
    renderRoom(); if (S.view) renderView();
  });
  on('room', d => { if (d.room) S.room = d.room; renderRoom(); if (d.kind === 'rearm') { $('over').hidden = true; show('pageRoom'); } });
  on('state', d => { S.room = d.room; renderRoom(); });
  on('presence', d => { if (S.room && S.room.seats[d.seat]) { S.room.seats[d.seat].connected = d.online ? 1 : 0; renderRoom(); } });
  on('game', d => {
    S.gameAt = d.at || S.gameAt; S.stats = null;
    $('pGame').textContent = '第 ' + d.game + ' 把' + (d.deals > 1 ? '（deal ' + d.deal + '/' + d.deals + '）' : '') + (d.swap ? ' · 已换座位' : '');
    $('history').innerHTML = ''; $('seq').innerHTML = ''; $('over').hidden = true;
    showPlay();
  });
  on('round', d => {
    if (S.room) S.room.hp = d.hp;
    $('pRound').textContent = '第 ' + d.roundNo + ' 轮 · ' + (d.firstBidder === S.plan ? '你先喊' : '对手先喊');
    renderHp();
  });
  on('ask', d => { S.view = d.view; S.submitted = false; S.revealed = false; showPlay(); renderView(); startTimer(d.deadline); });
  on('bid', d => { appendSeq(d); });
  on('open', d => { settleRound(d); });
  on('acted', d => { if (d.seat === S.plan) stopTimer(); });
  on('notice', d => { msg('#actMsg', (d.kind === 'timeout' ? '超时' : '') + '：' + (d.seat === S.plan ? '你' : d.nick) + ' 被自动接手为 ' + actText(d.action), d.seat === S.plan ? 'bad' : ''); });
  on('note', d => { if (d.kind === 'summary-error' || d.kind === 'reflect-error') msg('#actMsg', '复盘/反思出错（不影响比分）：' + d.error, 'bad'); });
  on('abandon', d => { msg('#actMsg', (d.nick || d.seat) + ' 认输或无法行动', 'bad'); });
  on('aborted', d => { msg('#actMsg', '这桌中断：' + d.reason, 'bad'); });
  on('gameover', d => { S.stats = d.stats; renderStats(d); if (d.hp && S.room) S.room.hp = d.hp; renderHp(); });
  on('matchover', d => showMatchOver(d));
}
function disconnect() { if (S.es) { try { S.es.close(); } catch (e) { } S.es = null; } stopTimer(); }
// 桌面下方四个页签：本轮流水 / 你的动作 / 开盅记录 / 心理账本，一次只看一块，别把牌桌压满
function wireStage() {
  const tabs = $('stageTabs'); if (!tabs) return;
  const pans = { seq: 'panSeq', my: 'panMy', hist: 'panHist', stats: 'panStats' };
  tabs.querySelectorAll('button').forEach(b => b.onclick = () => {
    tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    for (const k in pans) $(pans[k]).hidden = (k !== b.dataset.t);
  });
}
function showPlay() { if (!$('pagePlay').hidden) return; show('pagePlay'); }

/* ---------------- 视角渲染 ---------------- */
function actText(a) {
  if (!a) return '';
  if (a.type === 'open') return a.slash ? '劈' : '开盅';
  return '喊 ' + a.count + ' 个 ' + a.face + (a.mode === 'toZhai' ? ' 斋' : a.mode === 'breakZhai' ? ' 破斋' : '');
}
// 左右对坐：左边永远是「你」，右边永远是「对手」——换座（复式第二把）不用重新适应界面，
// 座位是甲是乙写在徽章上，谁干了什么各归各栏，一眼看得出对面那手是谁落的。
function seatOfMe() { return S.plan === 'B' ? 'B' : 'A'; }
function seatOfOpp() { return S.plan === 'B' ? 'A' : 'B'; }
function seatMeta(p) {
  const st = (S.room && S.room.seats) ? S.room.seats[p] : null;
  if (!st) return '—';
  if (st.kind === 'me') return '真人手打';
  if (st.kind === 'bot') return '内置人机 · ' + (st.bot || '');
  return (st.model || '模型') + (st.effort ? ' · ' + st.effort : '');
}
function renderHp() {
  const r = S.room; if (!r) return;
  const hp = r.hp || { A: r.hpMax, B: r.hpMax };
  const put = (side, p) => {
    const nm = $(side + 'Name'), mt = $(side + 'Meta'), bar = $(side + 'Hp'), val = $(side + 'HpV'), badge = $(side + 'Badge');
    if (!nm) return;
    nm.textContent = (r.seats[p] && r.seats[p].nick) || (side === 'me' ? '你' : '对手');
    if (mt) mt.textContent = seatMeta(p);
    const v = hp[p] == null ? r.hpMax : hp[p];
    if (bar) bar.style.width = Math.max(0, Math.min(100, v / r.hpMax * 100)) + '%';
    if (val) val.textContent = v + '/' + r.hpMax;
    if (badge) badge.textContent = p === 'A' ? '甲' : '乙';
  };
  put('me', seatOfMe()); put('opp', seatOfOpp());
}
// 对手的骰子在开盅前只有背面：服务端从不发过来，这里画的是「那有五颗」而不是偷看
function backsHtml(n) {
  let out = '';
  for (let i = 0; i < (n || 5); i++) out += '<div class="die back"></div>';
  return out;
}
function revealDice(dice) {
  const box = $('oppDice'); if (!box || !dice) return;
  box.innerHTML = dice.map(d => {
    let cells = '';
    for (let i = 0; i < 9; i++) cells += `<i class="${(PIPS[d] || []).includes(i) ? 'on' : ''}"></i>`;
    return `<div class="die">${cells}</div>`;
  }).join('');
}

function renderView() {
  const v = S.view; if (!v) return;
  renderHp();
  $('pCode').textContent = S.room ? S.room.code : '';
  const wild = v.zhai ? false : true;
  $('myDice').innerHTML = diceHtml(v.dice, v.zhai) || '<div class="hint">这局没开始</div>';
  $('myCounts').innerHTML = v.counts ? [1, 2, 3, 4, 5, 6].map(f => f + '×' + v.counts[f]).join(' ') + (v.zhai ? ' · 斋：1 只算 1' : ' · 未斋：1 万能') : '';
  if ($('roundChip')) $('roundChip').textContent = (v.over ? '这一轮结束' : '第 ' + (v.roundNo || (S.view.round || 0)) + ' 轮 · ' + (v.zhai ? '斋' : '未斋'));
  const dot = $('stateDot'); if (dot) dot.className = 'dot ' + (v.over ? 'wait' : 'live');
  $('bidBox').innerHTML = v.bid
    ? `喊 ${v.bid.count} 个 ${v.bid.face}<small>${v.bid.zhai ? ' 斋' : ''}</small><em>${v.bid.by === 'me' ? '你' : '对手'}叫的 · 该${v.turn === 'me' ? '你' : '对手'}走</em>`
    : `还没人喊价<small>${v.turn === 'me' ? ' 轮到你首喊' : ' 等对手首喊'}</small>`;
  if ($('turnLine')) $('turnLine').textContent = v.over ? '这一轮结束了' : (v.turn === 'me' ? '轮到你' : '等对手落子…');
  if ($('oppDice') && !S.revealed) $('oppDice').innerHTML = backsHtml((v.dice || [1, 2, 3, 4, 5]).length);
  if ($('oppDiceTip')) $('oppDiceTip').textContent = S.revealed ? '已开盅亮牌' : '开盅后亮牌';
  $('seq').innerHTML = (v.seq || []).map(s => `<div class="${s.by === 'me' ? 'mine' : ''}">${s.at}. ${s.by === 'me' ? '你' : '对手'} 喊 ${s.count} 个 ${s.face}${s.zhai ? '（斋）' : ''}</div>`).join('');
  // 新一轮开始：各栏流水重来、对手骰子重新盖回去
  if ($('mySeq')) $('mySeq').innerHTML = (v.seq || []).filter(s => s.by === 'me').map(s => `<div class="mine">${s.at}. ${s.count} 个 ${s.face}${s.zhai ? '（斋）' : ''}</div>`).join('');
  if ($('oppSeq')) $('oppSeq').innerHTML = (v.seq || []).filter(s => s.by !== 'me').map(s => `<div>${s.at}. ${s.count} 个 ${s.face}${s.zhai ? '（斋）' : ''}</div>`).join('');
  if (!S.revealed && $('oppDice')) $('oppDice').innerHTML = backsHtml((v.dice || [1, 2, 3, 4, 5]).length);
  renderAction(v);
}
function appendSeq(d) {
  const div = document.createElement('div');
  div.className = d.seat === S.plan ? 'mine' : '';
  div.textContent = (S.gameAt[d.seat] || d.seat) + ' 喊 ' + d.count + ' 个 ' + d.face + (d.zhai ? '（斋）' : '');
  const own = document.createElement('div');
  own.className = d.seat === S.plan ? 'mine' : '';
  own.textContent = d.count + ' 个 ' + d.face + (d.zhai ? '（斋）' : '');
  $('seq').appendChild(div);
  const box = d.seat === S.plan ? $('mySeq') : $('oppSeq');
  if (box) box.appendChild(own);
}
function settleRound(d) {
  const div = document.createElement('div');
  div.className = 'row';
  const r = d.reveal;
  const dice = r && r.dice ? ['A', 'B'].map(k => `<div>${esc(r[k] || k)}: ${(r.dice[k] || []).map(x => `<i class="die-sm">${x}</i>`).join('')}</div>`).join('') : '';
  div.innerHTML = `<div>第 ${d.round} 轮：${esc(S.gameAt[d.seat] || d.seat)} 喊 ${d.bid.count} 个 ${d.bid.face}${d.bid.zhai ? '（斋）' : ''} → `
    + `${esc(S.gameAt[d.who] || d.who)} ${d.slash ? '劈' : '开盅'} · 实际 ${d.actual} 个 → `
    + `<b style="color:${d.truth ? 'var(--ok)' : 'var(--bad)'}">${d.truth ? '够（喊的人输）' : '不够（喊的人赢）'}</b> · `
    + `输家 ${esc(S.gameAt[d.loser] || d.loser)}</div>${dice}`;
  $('history').appendChild(div);
  if (r && r.dice && r.dice.B !== undefined) {
    const oppSeat = seatOfOpp();
    S.revealed = true;
    revealDice(r.dice[oppSeat]);
    if ($('oppDiceTip')) $('oppDiceTip').textContent = '已开盅亮牌';
  }
  if (d.hp && S.room) { S.room.hp = d.hp; renderHp(); }
}
function renderStats(d) {
  const rows = ['A', 'B'].map(p => {
    const s = (d.stats || {})[p] || {};
    return `<div class="row"><b>${esc(S.gameAt[p] || p)}</b>
      <span class="chip ghost">喊 ${s.bids || 0}</span><span class="chip ghost">诈 ${s.bluffs || 0}</span>
      <span class="chip ghost">被识破 ${s.bluffCaught || 0}</span><span class="chip ghost">被骗 ${s.fooled || 0}</span>
      <span class="chip ghost">开中 ${s.opensCorrect || 0}/开错 ${s.opensWrong || 0}</span>
      <span class="chip ghost">转斋 ${s.toZhai || 0} 破斋 ${s.breakZhai || 0} 劈 ${s.slashes || 0}</span></div>`;
  });
  $('stats').innerHTML = rows.join('') + `<div class="hint">「诈」= 你喊出去但实际不够；「被骗」= 对手上一手是假的、你却跟着喊没开。这局谁在读谁，看这里。</div>`;
}
function showMatchOver(d) {
  const net = d.net || { A: 0, B: 0 };
  const name = p => (S.room && S.room.seats[p].nick) || p;
  const win = d.winner;
  $('over').innerHTML = `<div class="box">
    <h2>${win ? esc(name(win)) + ' 拿下这桌' : '打平'}</h2>
    <div class="hint">${d.duplicate ? '复式：同一副骰子各打一次并换座位，比的是净胜血之和。' : '单局。'}</div>
    <div class="kv">${['A', 'B'].map(p => `<div>${esc(name(p))}：净胜血 <b>${net[p] > 0 ? '+' : ''}${net[p]}</b>${S.plan === p ? '（你）' : ''}</div>`).join('')}</div>
    <div class="kv">共 ${d.games.length} 把 · token 用量 ${d.usedTokens || 0}</div>
    <div style="margin-top:12px"><button class="btn primary" id="btnAgain">再来一局</button>
      <button class="btn ghost" id="btnClose">散桌</button></div>
  </div>`;
  $('over').hidden = false;
  $('btnAgain').onclick = async () => {
    $('over').hidden = true;
    try { const r = await api('/api/room/start', { code: S.room.code, token: S.seatToken }); S.room = r.room; show('pageRoom'); renderRoom(); }
    catch (e) { msg('#roomMsg', e.message, 'bad'); show('pageRoom'); }
  };
  $('btnClose').onclick = async () => { try { await api('/api/room/close', { code: S.room.code, token: S.seatToken }); } catch (e) { } S.room = null; disconnect(); show('pageHome'); loadRooms(); loadMatches(); };
}

/* ---------------- 行动面板 ---------------- */
function renderAction(v) {
  const box = $('action');
  const bids = (v.legal || []).filter(a => a.type === 'bid');
  const opens = (v.legal || []).filter(a => a.type === 'open');
  if (v.over) { box.innerHTML = '<div class="hint">这局结束了。</div>'; return; }
  if (v.turn !== 'me') { box.innerHTML = '<div class="hint">现在不该你走，等对手。你上一手的判断可以留在心里，界面不替你记。</div>'; return; }
  if (!S.sel || !bids.some(a => a.count === S.sel.count && a.face === S.sel.face)) {
    const first = bids[0];
    S.sel = first ? { count: first.count, face: first.face, mode: first.mode || 'normal' } : { count: 0, face: 0, mode: 'normal' };
  }
  const counts = [...new Set(bids.map(a => a.count))].sort((x, y) => x - y);
  const faces = [...new Set(bids.map(a => a.face))].sort((x, y) => (x === 1 ? 7 : x) - (y === 1 ? 7 : y));
  const modesFor = (c, f) => [...new Set(bids.filter(a => a.count === c && a.face === f).map(a => a.mode || 'normal'))];
  const modeLabel = { normal: '普通抬价', toZhai: '转斋（进斋）', breakZhai: '破斋（回未斋）' };

  const chips = (arr, cur, on) => arr.map(x => `<button class="${x === cur ? 'on' : ''}" data-v="${x}">${typeof x === 'number' ? x : x}</button>`).join('');
  box.innerHTML = `
    ${bids.length ? `<div class="grp"><div class="lab">个数</div><div class="chips counts-chips">${
      counts.map(c => `<button class="${c === S.sel.count ? 'on' : ''}" data-c="${c}">${c} 个</button>`).join('')}</div></div>
      <div class="grp"><div class="lab">点数（2&lt;3&lt;4&lt;5&lt;6&lt;1）</div><div class="chips faces-chips">${
      faces.map(f => {
        const ok = modesFor(S.sel.count, f).length;
        return `<button class="${f === S.sel.face ? 'on' : ''} ${ok ? '' : 'no'}" data-f="${f}">${FACE_LABEL[f]}</button>`;
      }).join('')}</div></div>
      <div class="grp"><div class="lab">这手怎么走</div><div class="chips modes-chips">${
      modesFor(S.sel.count, S.sel.face).map(m => `<button class="${m === S.sel.mode ? 'on' : ''}" data-m="${m}">${modeLabel[m] || m}</button>`).join('')}</div></div>
      <div class="preview">落子预览：<b id="pv"></b></div>` : '<div class="hint">已无价可喊，只能开盅。</div>'}
    <div class="grp"><div class="chips">
      <button class="big primary" id="btnGo">走这一步</button>
      ${opens.filter(o => !o.slash).length ? '<button class="big open" id="btnOpen">开盅</button>' : ''}
      ${opens.filter(o => o.slash).length ? '<button class="big slash" id="btnSlash">劈（双向算账）</button>' : ''}
    </div></div>`;
  const upd = () => { const a = { type: 'bid', count: S.sel.count, face: S.sel.face, mode: S.sel.mode }; const pv = $('pv'); if (pv) pv.textContent = actText(a); };
  box.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { S.sel.count = +b.dataset.c; if (!modesFor(S.sel.count, S.sel.face).length) { const alt = bids.find(a => a.count === S.sel.count); if (alt) S.sel.face = alt.face; S.sel.mode = (alt && alt.mode) || 'normal'; } renderAction(v); });
  box.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { if (b.classList.contains('no')) return; S.sel.face = +b.dataset.f; const ms = modesFor(S.sel.count, S.sel.face); if (!ms.includes(S.sel.mode)) S.sel.mode = ms[0] || 'normal'; renderAction(v); });
  box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { S.sel.mode = b.dataset.m; renderAction(v); });
  upd();
  const go = $('btnGo'); if (go) go.onclick = () => submit({ type: 'bid', count: S.sel.count, face: S.sel.face, mode: S.sel.mode === 'normal' ? null : S.sel.mode });
  const op = $('btnOpen'); if (op) op.onclick = () => submit({ type: 'open', slash: false });
  const sl = $('btnSlash'); if (sl) sl.onclick = () => submit({ type: 'open', slash: true });
}
async function submit(action) {
  if (S.submitted) return;
  msg('#actMsg', '提交中…');
  try {
    await api('/api/room/action', { code: S.room.code, seat: S.plan, token: S.seatToken, action });
    S.submitted = true; stopTimer(); msg('#actMsg', '已提交：' + actText(action) + ' · 等对手', 'ok');
    $('action').innerHTML = '<div class="hint">已提交，等这一手落地。</div>';
  } catch (e) { msg('#actMsg', e.message, 'bad'); }
}
function startTimer(deadline) {
  stopTimer();
  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    $('pTimer').textContent = '还剩 ' + left + 's';
    $('pTimer').className = 'chip' + (left < 10 ? ' on' : '');
    if (left <= 0) stopTimer();
  };
  tick(); S.timer = setInterval(tick, 500);
}
function stopTimer() { if (S.timer) clearInterval(S.timer); S.timer = null; $('pTimer').textContent = ''; }

/* ---------------- 我的配置 / 登录 ---------------- */
function openModal(which) {
  $('modal').hidden = false;
  $('paneAuth').hidden = which !== 'auth';
  $('paneMe').hidden = which !== 'me';
  if (which === 'me') renderMe();
}
function renderMe() {
  const me = S.me; if (!me) return openModal('auth');
  const bots = (S.ping && S.ping.bots) || [];
  $('cBot').innerHTML = bots.map(b => `<option value="${b.id}">${esc(b.label)}</option>`).join('');
  $('cfgList').innerHTML = me.configs.length ? me.configs.map(c => `<div class="row">
      <b>${esc(c.name)}</b><span class="chip ghost">${c.kind === 'llm' ? esc(c.model || '') : c.kind === 'bot' ? esc(c.bot || '') : '本人'}</span>
      ${c.hasKey ? `<span class="chip">Key ${esc(c.keyMask)}</span>` : ''}
      ${c.guideChars ? `<span class="chip ghost">秘诀 ${c.guideChars} 字</span>` : ''}
      <button class="btn sm" data-id="${c.id}">改</button><button class="btn sm danger" data-drop="${c.id}">删</button></div>`).join('')
    : '<div class="hint">还没有配置。新建一条：填端点与 Key，写下你的必胜秘诀，之后上桌直接选它。</div>';
  $('cfgList').querySelectorAll('[data-id]').forEach(b => b.onclick = () => fillCfg(b.dataset.id));
  $('cfgList').querySelectorAll('[data-drop]').forEach(b => b.onclick = async () => {
    try { await api('/api/profile/drop', { id: b.dataset.drop }); S.me = (await api('/api/me')).me; renderMe(); } catch (e) { }
  });
  $('pRules').innerHTML = ((S.ping && S.ping.rules) || []).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  if (me.prefs) { $('pHp').value = me.prefs.hpMax || 8; $('pTurn').value = Math.round((me.prefs.turnMs || 45000) / 1000); $('pDup').checked = !!me.prefs.duplicate; }
  $('cGuideN').textContent = ($('cGuide').value || '').length;
}
function fillCfg(id) {
  const c = S.me.configs.find(x => x.id === id); if (!c) return;
  $('cName').value = c.name; $('cKind').value = c.kind; syncKindPane();
  if (c.bot) $('cBot').value = c.bot;
  $('cBase').value = c.baseUrl || ''; $('cModel').value = c.model || ''; $('cKey').value = '';
  $('cEffort').value = c.effort || 'medium'; $('cMax').value = c.maxTokens || 8192;
  $('cGuide').value = c.guideText || ''; $('cGuideN').textContent = ($('cGuide').value || '').length;
  $('cName').dataset.id = id;
}
function syncKindPane() {
  const k = $('cKind').value;
  $('cBotWrap').style.display = k === 'bot' ? '' : 'none';
  $('cLlmWrap').style.display = k === 'llm' ? '' : 'none';
}
function wireModal() {
  $('btnMe').onclick = () => openModal(S.me ? 'me' : 'auth');
  $('btnAuth').onclick = () => openModal(S.me ? 'me' : 'auth');
  $('mClose').onclick = () => { $('modal').hidden = true; if (pickA) pickA.refresh(); if (pickB) pickB.refresh(); };
  $('btnLogin').onclick = async () => {
    try {
      const r = await api('/api/login', { nick: $('lNick').value, pass: $('lPass').value });
      S.sid = r.token; localStorage.setItem('sid', r.token); S.me = r.me; setWho(); openModal('me');
    } catch (e) { alert(e.message); }
  };
  $('btnSignup').onclick = async () => {
    try {
      const r = await api('/api/signup', { nick: $('sNick').value, pass: $('sPass').value });
      if (r.token) { S.sid = r.token; localStorage.setItem('sid', r.token); }
      const me = await api('/api/me'); S.me = me.me; setWho(); openModal('me');
    } catch (e) { alert(e.message); }
  };
  $('cKind').onchange = syncKindPane;
  $('cGuide').oninput = e => { $('cGuideN').textContent = (e.target.value || '').length; };
  $('btnSaveCfg').onclick = async () => {
    try {
      const body = { config: {
        id: $('cName').dataset.id || null, name: $('cName').value, kind: $('cKind').value, bot: $('cBot').value,
        baseUrl: $('cBase').value, model: $('cModel').value, effort: $('cEffort').value, maxTokens: +$('cMax').value,
        guideText: $('cGuide').value,
      }, key: $('cKey').value || null };
      const r = await api('/api/profile/config', body);
      S.me = (await api('/api/me')).me; $('cName').dataset.id = r.config.id; $('cKey').value = ''; renderMe();
      alert('已保存：' + r.config.name);
    } catch (e) { alert(e.message); }
  };
  $('btnTest').onclick = async () => {
    msg('#testOut', '测试中…');
    try {
      const body = { baseUrl: $('cBase').value, model: $('cModel').value, apiKey: $('cKey').value || null };
      if ($('cName').dataset.id) body.configId = $('cName').dataset.id;
      const r = await api('/api/model/test', body);
      msg('#testOut', (r.ok ? '通了 ' + r.ms + 'ms · ' + (r.content || '') : '不通：' + r.error), r.ok ? 'ok' : 'bad');
    } catch (e) { msg('#testOut', e.message, 'bad'); }
  };
  $('btnSavePrefs').onclick = async () => {
    try { await api('/api/profile/prefs', { prefs: { rules: $('pRules').value, hpMax: +$('pHp').value, turnMs: (+$('pTurn').value) * 1000, duplicate: $('pDup').checked } }); alert('已保存偏好'); }
    catch (e) { alert(e.message); }
  };
}
function setWho() {
  $('who').textContent = S.me ? S.me.nick : '';
  $('btnAuth').textContent = S.me ? '账号' : '登录';
}

/* ---------------- 起 ---------------- */
async function boot() {
  try {
    S.ping = await api('/api/ping');
    $('net').textContent = '服务在线 · ' + (S.ping.rooms || 0) + ' 桌 · ' + (S.ping.users || 0) + ' 账号';
    $('net').className = 'chip on';
  } catch (e) { $('net').textContent = '连不上服务'; $('net').className = 'chip danger'; }
  try { if (S.sid) S.me = (await api('/api/me')).me; } catch (e) { S.sid = ''; localStorage.removeItem('sid'); }
  setWho();
  wireHome(); wireRoom(); wireModal();
  await initHome();
  wireStage();
  show('pageHome');
}
boot();
