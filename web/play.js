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
// 列表卡片上用的短标签：一眼分清这一座是「真人 / 模型 / 人机 / 空」，而不是笼统的「有人」
const KIND_SHORT = { open: '空', me: '真人', llm: '模型', preset: '平台模型', bot: '人机', relay: '接力' };

const S = {
  sid: localStorage.getItem('sid') || '', me: null, ping: null,
  room: null, plan: null, seatToken: '', role: 'spec',
  view: null, es: null, gameAt: { A: '甲方', B: '乙方' },
  stats: null, timer: null, sel: null, submitted: false,
  // askSeq：收到「轮到我」的次数。提交行动的回调要靠它判断「我提交之后，服务端是不是已经
  // 把下一手推给我了」——不能无条件覆盖出价区，否则会把刚渲染好的下一轮按钮抹掉。
  askSeq: 0,
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
function msg(el, text, cls) {
  const e = typeof el === 'string' ? $(el) : el;
  e.textContent = text || ''; e.className = 'msg ' + (cls || '');
  /* 说人话的话必须被看见。手机上提示正好掉在屏幕下沿之外的情况很常见（实测差 29px 就等于没有），
     这时候把它刚好滚进视口（block:'nearest'），不然解释了个寂寞。 */
  try {
    if (text && e.scrollIntoView) {
      const r = e.getBoundingClientRect();
      if (r.bottom > innerHeight || r.top < 0) e.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } catch (err) { }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function show(page) {
  try { if (typeof renderDock === 'function') setTimeout(renderDock, 0); } catch (e) { }
  // 目标页当前藏着 = 真的要切页。切页必须回顶：不然上一页的滚动位置会带过来 ——
  // 手机上点「跟它打」时 homeMsg 先把大厅滚到底，牌桌一开就停在 scrollY≈1073，自己的骰子全在屏外。
  const changed = $(page) && $(page).hidden;
  for (const p of ['pageHome', 'pageMatches', 'pageRank', 'pageRoom', 'pagePlay']) $(p).hidden = (p !== page);
  // 顶栏导航高亮：房间 / 牌桌不属于三个平台页，回落「大厅」作主场标记
  const navKey = { pageHome: 'home', pageMatches: 'matches', pageRank: 'rank' }[page] || 'home';
  document.querySelectorAll('#mainnav [data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === navKey));
  try { document.body.dataset.page = page; } catch (e) { }
  if (changed) { try { window.scrollTo(0, 0); } catch (e) { } }
}
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

/* ---------------- 配色：默认浅色（潘潘这套），可切深色 ---------------- */
function setTheme(t) {
  const th = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = th;
  try { localStorage.setItem('theme', th); } catch (e) { }
  const b = $('btnTheme');
  if (b) {
    const ico = b.querySelector('.tb-ico'), txt = b.querySelector('.tb-txt');
    if (ico) ico.textContent = th === 'light' ? '☀' : '☾';
    if (txt) txt.textContent = th === 'light' ? '日场' : '夜场';
    b.title = th === 'light' ? '现在是日场，点一下切到夜场' : '现在是夜场，点一下切到日场';
  }
}
function wireTheme() {
  // 默认跟系统（head 里已预热过一次，这里把按钮文案对齐）；没有手动选过：系统浅色才用日场，否则夜场
  let t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { }
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  setTheme(t);
  if ($('btnTheme')) $('btnTheme').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}

/* ---------------- 演武场（首页） ---------------- */
// 对打台上挑好的两台（存 key：'cfg:<id>' / 'bot:<id>'）
let duelSlots = { A: null, B: null };
// 我这台机器上能上桌的东西：我自己配的大模型 + 平台内置人机
function turfRows() {
  const cfgs = ((S.me && S.me.configs) || []).filter(c => c.kind === 'llm')
    .map(c => ({
      key: 'cfg:' + c.id, label: c.name, sub: c.model || '', guideChars: c.guideChars || 0, cfgId: c.id,
      spec: { kind: 'llm', configId: c.id },
    }));
  const bots = ((S.ping && S.ping.bots) || [])
    .map(b => ({ key: 'bot:' + b.id, label: b.label, sub: b.desc || '内置人机', spec: { kind: 'bot', bot: b.id } }));
  return cfgs.concat(bots);
}
function specOf(key) { const row = turfRows().find(r => r.key === key); return row ? row.spec : null; }

// 演武场的桌规：直接取首页那三个框，缺省值也在
function soloCfg() {
  return {
    rules: ($('hRules') || {}).value || 'flex',
    hpMax: +($('hHp') || {}).value || 8,
    maxRounds: +($('hRounds') || {}).value || 60,
    turnMs: (+($('hTurn') || {}).value || 45) * 1000,
  };
}

function paintDuel() {
  const row = k => duelSlots[k] ? (turfRows().find(r => r.key === duelSlots[k]) || {}).label : null;
  if ($('duelA')) $('duelA').textContent = row('A') || '还没挑';
  if ($('duelB')) $('duelB').textContent = row('B') || '还没挑';
  if ($('duelA')) $('duelA').className = 'duel-pick' + (duelSlots.A ? ' on' : '');
  if ($('duelB')) $('duelB').className = 'duel-pick' + (duelSlots.B ? ' on' : '');
}

function renderTurf() {
  const gated = !S.me;
  if ($('turfGate')) $('turfGate').hidden = !gated;
  if ($('turfBody')) $('turfBody').hidden = gated;
  if (gated) return;
  const rows = turfRows();
  if ($('turfModels')) {
    $('turfModels').innerHTML = rows.length ? rows.map(x => `
      <div class="turf-card">
        <div class="turf-name">${esc(x.label)}</div>
        <div class="turf-meta">${esc(x.sub)}</div>
        <div class="turf-meta">提示词 ${x.guideChars ? x.guideChars + ' 字' : '未写'}</div>
        <div class="turf-acts">
          <button class="btn sm" data-fight="${esc(x.key)}">跟它打</button>
          <button class="btn sm ghost" data-stage="${esc(x.key)}">让它上台</button>
          ${x.cfgId ? `<button class="btn sm ghost" data-prompt="${esc(x.cfgId)}">改提示词</button>` : ''}
        </div>
      </div>`).join('')
      : '<div class="hint">还没有模型。去「我的配置」加一条大模型配置，或者先用内置人机练手 —— 人机在下面。</div>';
    $('turfModels').querySelectorAll('[data-fight]').forEach(b => b.onclick = () => soloFight(b.dataset.fight));
    // 每个模型的提示词是独立的：点这里直接打开那条配置去改
    $('turfModels').querySelectorAll('[data-prompt]').forEach(b => b.onclick = () => { openModal('me'); setTimeout(() => fillCfg(b.dataset.prompt), 60); });
    $('turfModels').querySelectorAll('[data-stage]').forEach(b => b.onclick = () => {
      const k = b.dataset.stage;
      // 轮着放：先补甲方，甲方有了就补乙方，两个都满了就从甲方换起
      if (!duelSlots.A) duelSlots.A = k; else if (!duelSlots.B) duelSlots.B = k; else duelSlots.A = k;
      paintDuel();
      const label = (turfRows().find(r => r.key === k) || {}).label || '';
      msg('#homeMsg', '上台了：' + label + '（' + (duelSlots.B === k ? '乙方' : '甲方') + '）', 'ok');
    });
  }
  paintDuel();
}

async function soloFight(key) {
  const spec = specOf(key); if (!spec) return;
  msg('#homeMsg', '开练…');
  try {
    const r = await api('/api/solo', Object.assign({ mode: 'vs-model', seatSpec: spec }, soloCfg()));
    msg('#homeMsg', '');
    // 我坐甲方：亲自出马，只能看自己那一侧
    enterRoom(r.code, 'A', r.you && r.you.token, r.room, r.host);
  } catch (e) { msg('#homeMsg', e.message, 'bad'); }
}

async function duelFight() {
  if (!duelSlots.A || !duelSlots.B) return msg('#homeMsg', '先给甲方、乙方各挑一台', 'bad');
  msg('#homeMsg', '两台模型开打…');
  try {
    const r = await api('/api/solo', Object.assign({
      mode: 'model-vs-model', seatSpecA: specOf(duelSlots.A), seatSpecB: specOf(duelSlots.B),
    }, soloCfg()));
    msg('#homeMsg', '');
    // 没有真人上桌：以观战身份进去，全知
    enterRoom(r.code, 'spec', '', r.room, r.host);
  } catch (e) { msg('#homeMsg', e.message, 'bad'); }
}

async function initHome() {
  const q = new URLSearchParams(location.search);
  if (q.get('room')) $('jCode').value = q.get('room').toUpperCase();
  $('hNick').value = (S.me && S.me.nick) || localStorage.getItem('nick') || '';
  $('jNick').value = $('hNick').value;
  const rules = (S.ping && S.ping.rules) || [];
  $('hRules').innerHTML = rules.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  if (S.me && S.me.prefs) {
    if (S.me.prefs.hpMax) $('hHp').value = S.me.prefs.hpMax;
    if (S.me.prefs.turnMs) $('hTurn').value = Math.round(S.me.prefs.turnMs / 1000);
    if (S.me.prefs.maxRounds) $('hRounds').value = S.me.prefs.maxRounds;
  }
  renderTurf();
  loadRooms(); loadMatches();
  // 朋友点邀请链接进来：直接落到这张桌的观战席；自己建的那桌则恢复自己的座位
  const code = (q.get('room') || '').toUpperCase();
  if (code) {
    const seen = localStorage.getItem('seattk:' + code);
    const host = localStorage.getItem('host_' + code);
    setTimeout(async () => {
      try {
        if (seen || host) {
          const r = await api('/api/room/info?code=' + encodeURIComponent(code)).catch(() => null);
          const room = (r && r.room) || null;
          const plan = localStorage.getItem('seat:' + code) || (host ? 'A' : 'spec');
          enterRoom(code, plan, seen || '', room, host || '');
          if (!room) connect();   // 先连上，room 状态由事件流补
        } else {
          const w = await api('/api/room/watch', { code, nick: $('jNick').value || '' });
          S.watchSlot = w.slot || null;
          if (w.reason) setTimeout(() => msg('#roomMsg', w.reason), 600);
          enterRoom(code, 'spec', '', w.room, '');
        }
      } catch (e) { /* 房间没了就留在大厅 */ }
    }, 60);
  }
}

function wireHome() {
  if ($('btnGateLogin')) $('btnGateLogin').onclick = () => openModal('auth');
  if ($('btnDuel')) $('btnDuel').onclick = duelFight;
  if ($('btnDuelClear')) $('btnDuelClear').onclick = () => { duelSlots = { A: null, B: null }; paintDuel(); };
  $('hNick').oninput = e => { $('jNick').value = e.target.value; localStorage.setItem('nick', e.target.value); };
  // 建房间：我坐甲方，对面留空等邀请；观战席三张空着谁都能进
  $('btnCreate').onclick = async () => {
    if (!S.me && !$('hNick').value.trim()) return msg('#homeMsg', '先填个昵称，或登录用账号名', 'bad');
    msg('#homeMsg', '开房间…');
    try {
      const cfg = Object.assign({
        title: $('hTitle').value, pass: $('hPass').value, mode: 'invite',
        seats: { A: { kind: 'me', nick: ($('hNick').value || (S.me && S.me.nick) || '玩家') }, B: { kind: 'open' } },
      }, soloCfg());
      const r = await api('/api/room/create', cfg);
      msg('#homeMsg', '');
      localStorage.setItem('host_' + r.code, r.host);
      enterRoom(r.code, 'A', r.you && r.you.token, r.room, r.host);
    } catch (e) { msg('#homeMsg', e.message, 'bad'); }
  };
  // 进房：默认观战（不亲自出马 = 全知）
  $('btnJoin').onclick = async () => {
    const code = ($('jCode').value || '').trim().toUpperCase();
    if (!code) return msg('#homeMsg', '填个房间码', 'bad');
    msg('#homeMsg', '进房…');
    try {
      const w = await api('/api/room/watch', { code, nick: $('jNick').value, pass: $('jPass').value, watchToken: localStorage.getItem('wt_' + code) || undefined });
      msg('#homeMsg', '');
      if (w.token) localStorage.setItem('wt_' + code, w.token);
      S.watchSlot = w.slot || null; S.watchToken = w.token || null;
      enterRoom(code, 'spec', '', w.room, localStorage.getItem('host_' + code) || '');
      if (w.reason) msg('#roomMsg', w.reason);
    } catch (e) { msg('#homeMsg', e.message, 'bad'); }
  };
}

async function loadRooms() {
  try {
    const r = await api('/api/rooms');
    const hint = $('roomHint'); if (hint) hint.textContent = r.rooms.length ? r.rooms.length + ' 桌在等人上桌' : '';
    const hr = $('heroRooms'); if (hr) hr.textContent = r.rooms.length;
    $('roomList').innerHTML = r.rooms.length ? r.rooms.map(x =>
      `<div class="row"><b>${esc(x.code)}</b>
       <span class="chip">${esc(x.rulesId)} · ${x.hpMax} 血</span>
       <span class="chip ghost">甲 ${KIND_SHORT[x.seats.A] || x.seats.A}</span>
       <span class="chip ghost">乙 ${KIND_SHORT[x.seats.B] || x.seats.B}</span>
       ${x.title ? `<span class="hint">${esc(x.title)}</span>` : ''}
       <span class="sp"></span>
       <button class="btn sm" data-c="${esc(x.code)}">进这一桌</button></div>`).join('') : '<div class="hint">还没有公开房间在等人 —— 上面建一个，把链接发给朋友。</div>';
    $('roomList').querySelectorAll('button').forEach(b => b.onclick = () => { $('jCode').value = b.dataset.c; $('btnJoin').click(); });
  } catch (e) { }
}
async function loadMatches() {
  try {
    const r = await api('/api/matches?limit=12');
    const heroM = $('heroMatches'); if (heroM) heroM.textContent = r.matches.length;
    $('matchList').innerHTML = r.matches.length ? r.matches.map(m => {
      const a = (m.seats.A || {}).alias || '甲', b = (m.seats.B || {}).alias || '乙';
      const w = m.draw ? '平局' : (m.winner ? '<b class="win">' + esc((m.seats[m.winner] || {}).alias || m.winner) + ' 胜</b>' : '—');
      return `<div class="row"><span class="chip ghost">${new Date(m.t).toLocaleTimeString()}</span>
        <span>${esc(a)} <span class="hint">vs</span> ${esc(b)}</span>
        <span>${w}</span><span class="sp"></span>
        <span class="chip ghost">${m.rounds} 轮 · ${esc((m.rules && m.rules.name) || '')}</span></div>`;
    }).join('') : '<div class="hint">还没有战绩 —— 打完一局就会出现在这里。</div>';
  } catch (e) { }
}

/* ---------------- 平台导航 + 战绩 / 排行两个数据页 ---------------- */
let matchCache = [], rankCache = [];
const EFFORT_LABEL = { all: '全部', off: '关闭', low: '轻度', medium: '中度', high: '深度', xhigh: '极限' };

function wireNav() {
  document.querySelectorAll('#mainnav [data-nav]').forEach(b => b.onclick = () => {
    const k = b.dataset.nav;
    if (k === 'matches') { show('pageMatches'); loadMatchesPage(); }
    else if (k === 'rank') { show('pageRank'); loadRankPage(); }
    else { show('pageHome'); loadRooms(); loadMatches(); }
  });
  document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => {
    const k = b.dataset.goto;
    if (k === 'matches') { show('pageMatches'); loadMatchesPage(); }
    else if (k === 'rank') { show('pageRank'); loadRankPage(); }
    else { show('pageHome'); loadRooms(); loadMatches(); }
  });
  // 筛选改动只重渲染（数据已缓存），「刷新」才重新拉取
  ['mFilter', 'mRule', 'mCount'].forEach(id => { const el = $(id); if (el) el.onchange = () => { if (id === 'mCount') loadMatchesPage(); else renderMatchesTable(); }; });
  ['rkGroup', 'rkEffort'].forEach(id => { const el = $(id); if (el) el.onchange = renderRankTable; });
  if ($('btnReloadMatches')) $('btnReloadMatches').onclick = loadMatchesPage;
  if ($('btnReloadRank')) $('btnReloadRank').onclick = loadRankPage;
}

function fmtDate(t) { const d = new Date(t); const p = n => String(n).padStart(2, '0'); return { md: p(d.getMonth() + 1) + '-' + p(d.getDate()), hm: p(d.getHours()) + ':' + p(d.getMinutes()) }; }
function seatModelLabel(seat) {
  if (!seat) return '';
  if (seat.base === 'human') return '真人';
  const bot = ((S.ping && S.ping.bots) || []).find(b => b.id === seat.model);
  return bot ? bot.label : (seat.model || '模型');
}

async function loadMatchesPage() {
  const el = $('matchTable'); if (!el) return;
  el.innerHTML = '<div class="empty-note">读取战绩…</div>';
  // 规则筛选下拉：用平台规则集填充，保留当前选中
  const ruleSel = $('mRule');
  if (ruleSel && ruleSel.options.length <= 1) {
    const rules = (S.ping && S.ping.rules) || [];
    const cur = ruleSel.value;
    ruleSel.innerHTML = '<option value="">全部规则</option>' + rules.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    ruleSel.value = cur;
  }
  const limit = +($('mCount') && $('mCount').value) || 100;
  try { const r = await api('/api/matches?limit=' + limit); matchCache = r.matches || []; }
  catch (e) { matchCache = []; }
  renderMatchesTable();
}
function renderMatchesTable() {
  const el = $('matchTable'); if (!el) return;
  const f = ($('mFilter') && $('mFilter').value) || 'all';
  const rule = ($('mRule') && $('mRule').value) || '';
  let rows = matchCache.slice();
  if (f === 'win') rows = rows.filter(m => m.winner && !m.draw);
  else if (f === 'draw') rows = rows.filter(m => m.draw);
  if (rule) rows = rows.filter(m => m.rules && m.rules.id === rule);
  rows.sort((a, b) => (b.t || 0) - (a.t || 0));
  if (!rows.length) { el.innerHTML = '<div class="empty-note">这个筛选下还没有对局 —— 去演武场打一局，或放宽筛选。</div>'; return; }
  const head = '<div class="trow thead"><span>时间</span><span>对阵</span><span>结果</span><span class="center">轮数</span><span>规则</span></div>';
  el.innerHTML = head + rows.map(m => {
    const A = m.seats.A || {}, B = m.seats.B || {};
    const d = fmtDate(m.t);
    const result = m.draw ? '<span class="draw-tag">平局</span>'
      : (m.winner ? '<span class="win-tag">' + esc((m.seats[m.winner] || {}).alias || m.winner) + ' 胜</span>' : '<span class="draw-tag">未评</span>');
    return `<div class="trow">
      <span class="num">${d.md}<span class="sub2">${d.hm}</span></span>
      <div><div class="who"><b>${esc(A.alias || '甲')}</b><span class="vs">vs</span><b>${esc(B.alias || '乙')}</b></div>
        <span class="sub2">${esc(seatModelLabel(A))} / ${esc(seatModelLabel(B))}</span></div>
      <span>${result}</span>
      <span class="num center">${m.rounds}</span>
      <div><span>${esc((m.rules && m.rules.name) || '—')}</span>
        <span class="sub2">${m.hpMax} 血${m.duplicate ? ' · 复式' : ''}${m.source && m.source !== 'live' ? ' · ' + esc(m.source) : ''}</span></div>
    </div>`;
  }).join('');
}

async function loadRankPage() {
  const el = $('rankTable'); if (!el) return;
  el.innerHTML = '<div class="empty-note">结算天梯…</div>';
  try { const r = await api('/api/matches?limit=500'); rankCache = r.matches || []; }
  catch (e) { rankCache = []; }
  // 分组下拉：同一「规则 × 提示词」指纹一张榜，默认选局数最多的一组
  const gsel = $('rkGroup');
  const groups = (window.ArenaRanking ? ArenaRanking.listGroups(rankCache) : []);
  if (gsel) {
    const cur = gsel.value;
    gsel.innerHTML = groups.length ? groups.map(g => `<option value="${esc(g.key)}">${esc(g.rulesName || g.ruleset_hash)}${g.variant ? ' · ' + esc(g.variant) : ''}（${g.n} 局）</option>`).join('') : '<option value="">暂无分组</option>';
    if (groups.some(g => g.key === cur)) gsel.value = cur;
  }
  renderRankTable();
}
function renderRankTable() {
  const el = $('rankTable'); if (!el) return;
  const note = $('rankNote');
  if (!window.ArenaRanking) { el.innerHTML = '<div class="empty-note">排名模块没加载出来。</div>'; if (note) note.textContent = ''; return; }
  const gkey = ($('rkGroup') && $('rkGroup').value) || '';
  const effort = ($('rkEffort') && $('rkEffort').value) || 'all';
  let inGroup = gkey ? rankCache.filter(m => ArenaRanking.groupKey(m) === gkey) : rankCache;
  const filtered = ArenaRanking.filterEffort(inGroup, effort);
  // 真人没有端点指纹：把昵称当模型位，让不同玩家各占一条，而不是全并成一个「human」
  const normalized = filtered.map(m => Object.assign({}, m, { seats: {
    A: m.seats.A ? Object.assign({}, m.seats.A, m.seats.A.base === 'human' ? { model: m.seats.A.alias || 'human' } : {}) : null,
    B: m.seats.B ? Object.assign({}, m.seats.B, m.seats.B.base === 'human' ? { model: m.seats.B.alias || 'human' } : {}) : null,
  } }));
  const board = ArenaRanking.elo(normalized);
  const g = ArenaRanking.listGroups(inGroup)[0];
  if (note) note.textContent = `当前分组：${(g && (g.rulesName || g.ruleset_hash)) || '—'} · 强度：${EFFORT_LABEL[effort] || effort} · 样本 ${filtered.length} 局 · 不满 ${ArenaRanking.PROVISIONAL_GAMES} 局为暂定分。同一指纹内才比 Elo，跨指纹不混排。`;
  if (!board.length) { el.innerHTML = '<div class="empty-note">这一组 / 这一档还没有分出胜负的对局 —— 换一组或放宽强度筛选。</div>'; return; }
  const head = '<div class="trow thead"><span class="center">#</span><span>选手</span><span>积分</span><span>胜负</span><span class="center">局数</span><span class="right">胜率</span></div>';
  el.innerHTML = head + board.map((e, i) => {
    const rc = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
    const modelLabel = e.base === 'human' ? '真人' : (((S.ping && S.ping.bots) || []).find(b => b.id === e.model) || {}).label || e.model || '模型';
    return `<div class="trow">
      <span class="rank-badge ${rc}">${i + 1}</span>
      <div><b>${esc(e.alias)}</b>${e.provisional ? ' <span class="prov">暂定</span>' : ''}
        <span class="sub2">${esc(modelLabel)}</span></div>
      <span class="rating-num">${e.rating}</span>
      <span class="num">${e.wins} 胜 ${e.losses} 负${e.draws ? ' ' + e.draws + ' 平' : ''}</span>
      <span class="num center">${e.games}</span>
      <span class="num right">${Math.round(e.winRate * 100)}%</span>
    </div>`;
  }).join('');
}

/* ---------------- 房间：2 对战席 + 3 观战席 ---------------- */
/* 我手上的房间：最小化回演武场后还要能点回来，所以记在本地 */
function myRooms() {
  try { return JSON.parse(localStorage.getItem('myrooms') || '[]'); } catch (e) { return []; }
}
function saveMyRoom(rec) {
  const list = myRooms().filter(x => x.code !== rec.code);
  list.unshift(rec);
  localStorage.setItem('myrooms', JSON.stringify(list.slice(0, 6)));
  renderDock();
}
function dropMyRoom(code) {
  localStorage.setItem('myrooms', JSON.stringify(myRooms().filter(x => x.code !== code)));
  renderDock();
  for (const k of ['seattk:', 'seat:', 'host_']) localStorage.removeItem(k + code);
}
function renderDock() {
  const el = $('roomDock'); if (!el) return;
  const list = myRooms();
  const onRoomPage = !$('pageRoom').hidden;
  // 手机上牌桌页不放浮窗：底部被吸底出价区占了，顶部那一条又正好盖住「还剩 Xs / 回房间」。
  // 要换桌就点顶栏的「回房间」，回到演武场后浮窗照常出现。
  const onPlayCompact = !$('pagePlay').hidden && isCompact();
  el.hidden = list.length === 0 || onRoomPage || onPlayCompact;
  el.innerHTML = list.map(r => `<div class="pill" data-open="${esc(r.code)}">
      <span class="dot"></span><b>${esc(r.code)}</b><span>${esc(r.label || '')}</span>
      <span class="x" data-close="${esc(r.code)}" title="离桌">×</span></div>`).join('');
  el.querySelectorAll('[data-close]').forEach(x => x.onclick = async ev => {
    ev.stopPropagation();
    const code = x.dataset.close;
    const rec = myRooms().find(r => r.code === code) || {};
    try { await api('/api/room/leave', { code, token: rec.token || '' }); } catch (e) { }
    dropMyRoom(code);
  });
  el.querySelectorAll('[data-open]').forEach(p2 => p2.onclick = async () => {
    const code = p2.dataset.open;
    const rec = myRooms().find(r => r.code === code) || {};
    const got = await api('/api/room/info?code=' + encodeURIComponent(code)).catch(() => null);
    if (!got || !got.room) { dropMyRoom(code); return msg('#homeMsg', '那张桌已经散了', 'bad'); }
    enterRoom(code, rec.plan || 'spec', rec.token || '', got.room, rec.host || '');
  });
}

function enterRoom(code, plan, token, room, host) {
  S.room = room; S.plan = plan || 'spec'; S.role = S.plan;
  S.seatToken = token || '';
  S.host = host || localStorage.getItem('host_' + code) || '';
  if (token) { localStorage.setItem('seattk:' + code, token); localStorage.setItem('seat:' + code, S.plan); }
  show('pageRoom');
  $('rCode').textContent = code;
  saveMyRoom({ code, plan: S.plan, token: S.seatToken, host: S.host, label: (room && room.title) || ({ A: '甲方', B: '乙方' }[S.plan] || '观战') });
  connect();
  renderRoom();
}

function mayManage() { return !!(S.host || S.me); }

function renderRoom() {
  const r = S.room; if (!r) return;
  $('rTitle').textContent = r.title ? '· ' + r.title : '';
  $('rState').textContent = { lobby: '等待入座', playing: '正在打', finished: '打完了', aborted: '中断' }[r.state] || r.state;
  const iBattle = S.plan === 'A' || S.plan === 'B';

  const seatCard = p => {
    const s = r.seats[p] || {};
    const mine = S.plan === p;
    const label = p === 'A' ? '甲方 · 对战席' : '乙方 · 对战席';
    let head = '', body = '', acts = [];
    if (s.kind === 'open') {
      head = '<span class="chip ghost">空位</span>';
      body = '<div class="seat-empty">空着 · 等邀请</div>';
      if (r.state === 'lobby') {
        if (!iBattle) acts.push(`<button class="btn sm" data-take="${p}">我坐这</button>`);

      }
    } else if (s.kind === 'me') {
      head = s.ready ? '<span class="chip on">已准备</span>' : '<span class="chip">未准备</span>';
      body = `<div class="seat-who">${esc(s.nick || '玩家')}${mine ? ' <span class="chip on">我</span>' : ''}</div><div class="seat-meta">真人 · ${s.connected ? '在线' : '离线'}</div>`;
      if (mine && r.state === 'lobby') {
        acts.push(`<button class="btn sm ${s.ready ? 'ghost' : 'primary'}" data-ready="${p}" data-on="${s.ready ? 0 : 1}">${s.ready ? '取消准备' : '准备'}</button>`);
        acts.push(`<button class="btn sm ghost" data-leave="${p}">让位</button>`);
      }
    } else {
      head = s.ready ? '<span class="chip on">已准备</span>' : '<span class="chip">未准备</span>';
      body = `<div class="seat-who">${esc(s.nick || 'AI')}</div>
        <div class="seat-meta">${s.kind === 'bot' ? '内置人机' : '模型'}${s.model ? ' · ' + esc(s.model) : ''}</div>
        ${s.armLabel ? `<div class="seat-meta">秘诀 ${esc(s.armLabel)}${s.guideChars ? '（' + s.guideChars + ' 字）' : ''}</div>` : ''}`;
      if (r.state === 'lobby' && mayManage()) acts.push(`<button class="btn sm ghost" data-down="${p}">放下</button>`);
    }
    // 房主自己坐一席时，仍然要能把模型放到对面那一席
    const canPut = s.kind === 'open' && r.state === 'lobby' && mayManage() && turfRows().length && !mine;
    const put = canPut ? `
      <div class="put-row">
        <select data-putsel="${p}">${turfRows().map(x => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('')}</select>
        <button class="btn sm primary" data-put="${p}">放上去</button>
      </div>` : '';
    return `<div class="card seat-card" id="card${p}">
      <div class="seat-head"><b>${label}</b>${head}</div>
      ${body}${put}
      <div class="seat-acts">${acts.join('')}</div>
    </div>`;
  };

  const watchCard = w => {
    const mine = S.watchSlot === w.slot;
    if (w.kind === 'open') {
      return `<div class="card seat-card watch" id="card${w.slot}">
        <div class="seat-head"><b>观战席 ${w.slot.slice(1)}</b><span class="chip ghost">空位</span></div>
        <div class="seat-empty">观战看得到全部信息</div>
        <div class="seat-acts">${(mine || iBattle) ? '' : `<button class="btn sm ghost" data-watch="1">我在这观战</button>`}</div>
      </div>`;
    }
    return `<div class="card seat-card watch" id="card${w.slot}">
      <div class="seat-head"><b>观战席 ${w.slot.slice(1)}</b><span class="chip on">观战</span></div>
      <div class="seat-who">${esc(w.nick || '观众')}${mine ? ' <span class="chip on">我</span>' : ''}</div>
      <div class="seat-meta">全知视角</div>
      <div class="seat-acts"></div>
    </div>`;
  };

  if ($('cardA')) $('cardA').outerHTML = seatCard('A');
  if ($('cardB')) $('cardB').outerHTML = seatCard('B');
  const ws = r.watch || [];
  ['S1', 'S2', 'S3'].forEach((slot, i) => {
    const el = $('card' + slot); if (!el) return;
    el.outerHTML = watchCard(ws[i] || { slot, kind: 'open' });
  });

  $('rCfg').innerHTML = `规则 <b>${esc(r.rulesName)}</b> · 血量 <b>${r.hpMax}</b> · 每手 <b>${sec(Math.round(r.turnMs / 1000))}</b>
    · 最多 ${r.maxRounds} 轮 · ${r.hasPass ? '有口令' : '无口令'}${r.mode === 'solo' ? ' · 演武场' : ''}`;
  const rd = [];
  if (r.seats.A.kind !== 'open') rd.push('甲方 ' + (r.seats.A.ready ? '已准备' : '未准备'));
  if (r.seats.B.kind !== 'open') rd.push('乙方 ' + (r.seats.B.ready ? '已准备' : '未准备'));
  $('rReady').textContent = rd.join(' · ');

  const mayStart = !!(S.seatToken || S.host || S.me);
  $('btnStart').disabled = !(r.state === 'lobby') || r.seats.A.kind === 'open' || r.seats.B.kind === 'open'
    || !r.seats.A.ready || !r.seats.B.ready || !mayStart;
  $('btnStart').title = mayStart ? '' : '用建房间那条链接进来，或登录后再开局';

  // 席位上的动作
  const rerender = rm => { if (rm) S.room = rm; renderRoom(); };
  const pg = $('pageRoom');
  pg.querySelectorAll('[data-take]').forEach(b => b.onclick = async () => {
    try {
      const r2 = await api('/api/room/join', { code: S.room.code, seat: b.dataset.take, nick: (S.me && S.me.nick) || $('hNick').value || '玩家', pass: $('jPass').value || '' });
      S.plan = r2.seat; S.role = r2.seat; S.seatToken = r2.token; S.watchSlot = null;
      localStorage.setItem('seat:' + S.room.code, r2.seat); localStorage.setItem('seattk:' + S.room.code, r2.token);
      S.room = r2.room; connect(); renderRoom(); msg('#roomMsg', '你坐到' + (r2.seat === 'A' ? '甲' : '乙') + '方了，点「准备」再开局。');
    } catch (e) { msg('#roomMsg', e.message, 'bad'); }
  });
  pg.querySelectorAll('[data-ready]').forEach(b => b.onclick = async () => {
    try { const r2 = await api('/api/room/ready', { code: S.room.code, seat: b.dataset.ready, token: S.seatToken, ready: b.dataset.on === '1' }); rerender(r2.room); }
    catch (e) { msg('#roomMsg', e.message, 'bad'); }
  });
  pg.querySelectorAll('[data-down]').forEach(b => b.onclick = async () => {
    try { const r2 = await api('/api/room/unplace', { code: S.room.code, seat: b.dataset.down, host: S.host, token: S.seatToken }); rerender(r2.room); }
    catch (e) { msg('#roomMsg', e.message, 'bad'); }
  });
  pg.querySelectorAll('[data-leave]').forEach(b => b.onclick = async () => {
    try {
      const r2 = await api('/api/room/unplace', { code: S.room.code, seat: b.dataset.leave, host: S.host, token: S.seatToken });
      S.plan = 'spec'; S.role = 'spec'; S.seatToken = '';
      localStorage.removeItem('seat:' + S.room.code); localStorage.removeItem('seattk:' + S.room.code);
      const w = await api('/api/room/watch', { code: S.room.code, nick: (S.me && S.me.nick) || $('hNick').value || '' });
      S.watchSlot = w.slot || null;
      S.room = w.room || r2.room; connect(); renderRoom();
    } catch (e) { msg('#roomMsg', e.message, 'bad'); }
  });
  pg.querySelectorAll('[data-putui]').forEach(b => b.onclick = () => { S.putUI = b.dataset.putui; renderRoom(); });
  pg.querySelectorAll('[data-put]').forEach(b => b.onclick = async () => {
    const sel = pg.querySelector('[data-putsel="' + b.dataset.put + '"]');
    const seatSpec = specOf(sel && sel.value); if (!seatSpec) return;
    try {
      const r2 = await api('/api/room/place', { code: S.room.code, seat: b.dataset.put, seatSpec, host: S.host });
      S.putUI = null; rerender(r2.room);
    } catch (e) { msg('#roomMsg', e.message, 'bad'); }
  });
  pg.querySelectorAll('[data-watch]').forEach(b => b.onclick = async () => {
    try {
      const w = await api('/api/room/watch', { code: S.room.code, nick: (S.me && S.me.nick) || $('hNick').value || '', pass: $('jPass').value || '' });
      S.watchSlot = w.slot || null; S.watchToken = w.token || null; if (w.room) S.room = w.room; renderRoom();
    } catch (e) { msg('#roomMsg', e.message, 'bad'); }
  });
}

function wireRoom() {
  $('btnCopy').onclick = () => {
    const url = location.origin + location.pathname + '?room=' + S.room.code;
    navigator.clipboard && navigator.clipboard.writeText(url);
    msg('#roomMsg', '已复制：' + url, 'ok');
  };
  $('btnStart').onclick = async () => {
    msg('#roomMsg', '开局中…');
    try { const r = await api('/api/room/start', { code: S.room.code, token: S.seatToken, host: S.host }); S.room = r.room; renderRoom(); msg('#roomMsg', ''); }
    catch (e) { msg('#roomMsg', e.message, 'bad'); }
  };
  // 最小化：只把界面收回演武场，房间和席位都留着，右下角浮窗点一下就回来
  if ($('btnMin')) $('btnMin').onclick = () => {
    // 只切界面，不断连接：断线会让服务端以为你掉线，替你落子甚至判负
    show('pageHome'); loadRooms(); loadMatches(); renderDock();
    setTimeout(() => renderDock(), 30);
  };
  // 离桌：真的走人 —— 服务端把席位清掉，否则别人看到的是一张「虚空的我」
  $('btnLeave').onclick = async () => {
    const code = S.room && S.room.code;
    const playing = S.room && S.room.state === 'playing';
    if (!confirm(playing ? '这一局还在打：离桌要先把这一局认输。确定要离开吗？' : '离开这张桌？席位会让出来。')) return;
    try {
      if (playing && S.seatToken) await api('/api/room/resign', { code, seat: S.plan, token: S.seatToken }).catch(() => { });
      await api('/api/room/leave', { code, token: S.seatToken, watchToken: S.watchToken });
    } catch (e) {
      msg('#roomMsg', '离桌没成功：' + e.message, 'bad');
      return;                       // 服务端没确认之前，本地记录和连接都留着
    }
    if (code) dropMyRoom(code);
    disconnect(); S.room = null; S.watchSlot = null;
    show('pageHome'); loadRooms(); loadMatches();
  };
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
  es.onerror = () => {
    // EventSource 遇到 403（座位令牌不对）会直接 CLOSED：别死磕重连，退回观战
    if (es.readyState === EventSource.CLOSED && (S.plan === 'A' || S.plan === 'B')) {
      S.seatToken = ''; S.plan = 'spec'; S.role = 'spec';
      localStorage.removeItem('seat:' + (S.room && S.room.code)); localStorage.removeItem('seattk:' + (S.room && S.room.code));
      msg('#roomMsg', '座位令牌不被服务端认可，已退回观战；要下场点座位卡上的「坐下」。');
      return connect();
    }
    $('net').textContent = '重连中…'; $('net').className = 'chip';
  };
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
    // 握手里的 you 是服务端校验过座位令牌后的身份：认回原座；令牌失效则退回观战并清本地
    if (d.you === 'A' || d.you === 'B') { S.plan = d.you; S.role = d.you; }
    else if (d.you === 'spec' && S.seatToken) {
      S.seatToken = ''; S.plan = 'spec'; S.role = 'spec';
      localStorage.removeItem('seat:' + S.room.code); localStorage.removeItem('seattk:' + S.room.code);
      msg('#roomMsg', '本地存的座位令牌已失效（桌重启或座位被释放），已退回观战。');
    }
    if (d.view) { S.view = d.view; if (d.view && !d.view.over && S.plan !== 'spec') show('pagePlay'); }
    renderRoom(); if (S.view) renderView();
  });
  on('room', d => {
    if (d.room) S.room = d.room;
    renderRoom();
    if (d.room) saveMyRoom({ code: d.room.code, plan: S.plan, token: S.seatToken, host: S.host, label: d.room.title || ({ A: '甲方', B: '乙方' }[S.plan] || '观战') });
    if (d.kind === 'rearm') { $('over').hidden = true; show('pageRoom'); }
  });
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
  on('ask', d => { S.askSeq++; S.view = d.view; S.submitted = false; S.revealed = false; showPlay(); renderView(); startTimer(d.deadline); });
  on('bid', d => { noteBid(d); });
  // 全知通道：观战（不亲自出马）看得到两边骰盅、当前喊价、轮到谁
  on('omni', d => {
    if (S.plan !== 'spec') return;
    S.omni = d;
    if (d.hp && S.room) S.room.hp = d.hp;
    if (!S.view) S.view = { roundNo: d.round, over: d.over, zhai: d.zhai, turn: null, legal: [] };
    else { S.view.roundNo = d.round; S.view.over = d.over; S.view.zhai = d.zhai; }
    showPlay(); renderHp(); renderView();
  });
  // 实时推演：AI 席位这一手到底说了什么。座位侧只收到自己那一座；观战两边都收得到。
  on('think', d => { appendThink(d); });
  on('open', d => { settleRound(d); });
  on('acted', d => { if (d.seat === S.plan) stopTimer(); });
  on('notice', d => { msg('#actMsg', (d.kind === 'timeout' ? '超时' : '') + '：' + (d.seat === S.plan ? '你' : d.nick) + ' 被自动接手为 ' + actText(d.action), d.seat === S.plan ? 'bad' : ''); });
  on('note', d => { if (d.kind === 'summary-error' || d.kind === 'reflect-error') msg('#actMsg', '复盘/反思出错（不影响比分）：' + d.error, 'bad'); });
  on('abandon', d => { msg('#actMsg', (d.nick || d.seat) + ' 认输或无法行动', 'bad'); });
  on('aborted', d => { msg('#actMsg', '这桌中断：' + d.reason, 'bad'); });
  on('gameover', d => { S.stats = d.stats; renderStats(d); if (d.hp && S.room) S.room.hp = d.hp; renderHp(); });
  on('matchover', d => showMatchOver(d));
}
function appendThink(d) {
  const w = d.seat === 'A' || d.seat === 'B' ? d.seat : null;
  const body = w ? $('think' + w) : null; if (!body) return;
  if (body.querySelector('.hint')) body.innerHTML = '';
  const meta = [d.phase, d.ms ? sec(d.ms) : null, d.tokens ? d.tokens + ' tok' : null, d.reasonChars ? '思考 ' + d.reasonChars + ' 字' : null, d.finish === 'length' ? '被截断' : null].filter(Boolean).join(' · ');
  const div = document.createElement('div');
  div.className = 'tk';
  div.innerHTML = `<div class="tkmeta">${esc(meta || '推演')}</div>${esc(d.text || '')}${d.truncated ? '<div class="tkmeta">…已截断</div>' : ''}`;
  body.appendChild(div);
  while (body.children.length > 10) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
  const metaEl = $('thinkMeta' + w);
  if (metaEl) metaEl.textContent = meta || '';
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
  const hp = (S.omni && S.omni.hp) || r.hp || { A: r.hpMax, B: r.hpMax };
  const turnSeat = turnSeatOf();
  for (const w of ['A', 'B']) {
    const seat = r.seats[w] || {};
    const nm = $('name' + w), sub = $('sub' + w), st = $('status' + w), sc = $('score' + w), rail = $('rail' + w), fig = $('fighter' + w);
    if (!nm) continue;
    const iAm = S.plan === w;
    nm.textContent = seat.nick || (w === 'A' ? '甲方' : '乙方');
    sub.textContent = seatMeta(w) + (iAm ? ' · 你坐这一座' : (S.plan === 'spec' ? ' · 观战全知' : ''));
    const v = hp[w] == null ? r.hpMax : hp[w];
    if (sc) sc.textContent = v;
    if (rail) rail.style.width = Math.max(0, Math.min(100, v / (r.hpMax || 1) * 100)) + '%';
    const pips = $('pips' + w);
    if (pips) {
      const max = r.hpMax || 1; let ph = '';
      for (let i = 0; i < max; i++) ph += `<i class="${i < v ? 'on' : ''}"></i>`;
      pips.innerHTML = ph;
    }
    if (st) {
      const txt = v <= 0 ? '倒下' : (turnSeat === w ? '思考中' : (seat.kind === 'me' ? (seat.connected ? '在线' : '离线') : KIND_SHORT[seat.kind] || '待机'));
      st.textContent = txt;
      st.className = 'status-pill' + (turnSeat === w ? ' busy' : '') + (v <= 0 ? ' win' : '');
    }
    if (fig) fig.classList.toggle('active', turnSeat === w);
  }
}
// 轮到哪一座：座位视角里 turn 是 me/opp，观战的全知负载里直接给座位号
function turnSeatOf() {
  if (S.omni && S.omni.turn) return S.omni.turn;
  const v = S.view; if (!v || v.over) return null;
  if (v.turn === 'me') return seatOfMe();
  if (v.turn === 'opp') return seatOfOpp();
  return (v.turn === 'A' || v.turn === 'B') ? v.turn : null;
}
function seatName(p) { return (S.room && S.room.seats[p] && S.room.seats[p].nick) || S.gameAt[p] || (p === 'A' ? '甲方' : '乙方'); }
function setDice(w, dice, note, zhai) {
  const box = $('dice' + w), cap = $('cupNote' + w), cnt = $('counts' + w);
  if (!box) return;
  box.innerHTML = dice && dice.length ? diceHtml(dice, zhai) : backsHtml((dice && dice.length) || 5);
  if (cap) cap.textContent = note || '';
  if (cnt && dice && dice.length) {
    const c = {}; for (const d of dice) c[d] = (c[d] || 0) + 1;
    cnt.textContent = [1, 2, 3, 4, 5, 6].map(f => f + '×' + (c[f] || 0)).join(' ') + (zhai ? ' · 斋：1 只算 1' : ' · 未斋：1 万能');
  } else if (cnt) cnt.textContent = '';
}
function setLast(w, text) { const e = $('last' + w); if (e) e.textContent = text || '—'; }
// 对手的骰子在开盅前只有背面：服务端从不发过来，这里画的是「那有五颗」而不是偷看
function backsHtml(n) {
  let out = '';
  for (let i = 0; i < (n || 5); i++) out += '<div class="die back"></div>';
  return out;
}
function revealDice(w, dice, note) { if (dice) setDice(w, dice, note || '已开盅亮牌', false); }

function renderView() {
  const v = S.view, omni = S.omni, watching = S.plan === 'spec';
  if (!v && !omni) return;
  renderHp();
  if ($('pCode') && S.room) $('pCode').textContent = S.room.code;
  if ($('omniBadge')) $('omniBadge').hidden = !watching;
  const over = v ? !!v.over : !!(omni && omni.over);
  const zhai = v ? !!v.zhai : !!(omni && omni.zhai);
  const roundNo = v ? (v.roundNo || 0) : (omni ? omni.round : 0);
  const bid = omni && omni.bid ? { seat: omni.bid.seat, count: omni.bid.count, face: omni.bid.face, zhai: !!omni.bid.zhai }
    : (v && v.bid ? { seat: v.bid.by === 'me' ? seatOfMe() : v.bid.by === 'opp' ? seatOfOpp() : v.bid.by, count: v.bid.count, face: v.bid.face, zhai: !!v.bid.zhai } : null);
  const turn = turnSeatOf();

  // 中央牌桌：轮次 / 当前最高喊价 / 该谁走
  const chip = (over ? '这一轮结束' : '第 ' + roundNo + ' 轮 · ' + (zhai ? '斋' : '未斋'));
  if ($('roundChip')) $('roundChip').textContent = chip;
  if ($('centerChip')) $('centerChip').textContent = over ? '本轮已开盅' : '第 ' + roundNo + ' 轮 · ' + (zhai ? '斋' : '未斋');
  if ($('stateDot')) $('stateDot').className = 'dot ' + (over ? 'wait' : 'live');
  if ($('bidBox')) $('bidBox').innerHTML = bid
    ? `${bid.count} 个 ${bid.face}<small>${bid.zhai ? '斋' : ''}</small><em>${esc(seatName(bid.seat))} 叫的${turn ? ' · 该 ' + esc(seatName(turn)) + ' 走' : ''}</em>`
    : `还没人喊价<small>${turn ? '该 ' + esc(seatName(turn)) + ' 首喊' : '等待开战'}</small>`;
  if ($('bidSub')) $('bidSub').textContent = zhai ? '本手斋：1 只算它自己，最大的点数反成万能' : '每人 5 颗 · 未斋 1 万能 · 2<3<4<5<6<1';
  if ($('turnText')) $('turnText').textContent = over ? '本轮结束' : (turn ? (watching ? esc(seatName(turn)) + ' 正在落子' : (turn === S.plan ? '轮到你' : esc(seatName(turn)) + ' 在落子')) : '等待开战');
  if ($('turnLine')) $('turnLine').textContent = over ? '本轮结束，等下一手发骰' : (turn ? '轮到 ' + seatName(turn) : '等待开战');

  // 两栏骰盅：自己那一栏用私有视角；对面那一栏开盅后才亮；观战走全知通道直接看两边
  const mySeat = watching ? null : seatOfMe();
  for (const w of ['A', 'B']) {
    if (watching) {
      const d = omni && omni.dice ? omni.dice[w] : null;
      setDice(w, d, d ? (over ? '本轮已开盅 · 全知' : '全知视角 · 直接看盅') : '等一手发骰', zhai);
    } else if (w === mySeat) {
      setDice(w, v ? v.dice : null, v && v.dice ? (zhai ? '斋 · 1 只算 1' : '我的盅 · 未斋 1 万能') : '未摇骰', zhai);
    } else if (S.revealed && S.lastReveal && S.lastReveal[w]) {
      setDice(w, S.lastReveal[w], '已开盅亮牌', false);
    } else {
      setDice(w, null, '开盅前只有背面', false);
    }
  }
  if (v) syncSeq(v);
  placeAction();
  renderAction(v || (omni ? { over: omni.over, turn: null, legal: [] } : null));
}
/* 本轮流水的本地台账：按轮切分。
 * 之前骰盅下面那栏是「一路累加不清」，一整场打完会堆出上百个喊价格子（潘潘截图里那一大片
 * 「2 个 2 / 3 个 6 / 4 个 3」就是它，不是骰子），而且观战时双方喊价都堆到乙方下面。
 * 现在：流水只记当前这一轮；每栏最多显示最近 8 手，更早的折叠成一行提示。 */
function renderSeqLists() {
  const list = ((S.roundBids && S.roundBids.list) || []);
  const mark = p => (S.plan !== 'spec' && p === S.plan) ? 'mine' : '';
  const line = (b, i) => `<div class="${mark(b.seat)}">${i + 1}. ${esc(seatName(b.seat))} 喊 ${b.count} 个 ${b.face}${b.zhai ? '（斋）' : ''}</div>`;
  const center = $('seq');
  if (center) center.innerHTML = list.length ? list.map(line).join('') : '<span class="seq-empty">这一手还没人喊过</span>';
  for (const w of ['A', 'B']) {
    const box = $('bid' + w); if (!box) continue;
    const rows = list.filter(b => b.seat === w);
    box.innerHTML = (rows.length > 8 ? `<div class="folded">…前面还有 ${rows.length - 8} 手</div>` : '')
      + rows.slice(-8).map(b => `<div class="${mark(w)}">${b.count} 个 ${b.face}${b.zhai ? '（斋）' : ''}</div>`).join('');
  }
  const mine = $('mySeq');
  if (mine) {
    const rows = S.plan === 'spec' ? [] : list.filter(b => b.seat === S.plan);
    mine.innerHTML = rows.length ? rows.map(b => `<div class="mine">${b.count} 个 ${b.face}${b.zhai ? '（斋）' : ''}</div>`).join('')
      : `<div class="hint">${S.plan === 'spec' ? '你是观战，没有「你的动作」这一说。' : '这一手你还没喊过。'}</div>`;
  }
}
/* 全场流水（底部控制台第一栏）：一行一条，带时间戳，最新在上 */
function logLine(who, text, kind) {
  const box = $('logList'); if (!box) return;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const div = document.createElement('div');
  div.className = 'lg' + (kind ? ' ' + kind : '');
  div.innerHTML = `<span class="t">${t}</span><span class="who">${esc(seatName(who) || who || '')}</span><span>${esc(text)}</span>`;
  box.prepend(div);
  while (box.children.length > 240) box.removeChild(box.lastChild);
}
function syncSeq(v) {
  const roundNo = v.roundNo === undefined ? null : v.roundNo;
  const list = (v.seq || []).map(s => ({
    seat: (s.by === 'A' || s.by === 'B') ? s.by : (s.by === 'me' ? S.plan : (S.plan === 'A' ? 'B' : 'A')),
    count: s.count, face: s.face, zhai: !!s.zhai,
  }));
  // 本地台账更完整（视图可能是上一手之前的旧快照）时不覆盖，免得把刚喊的弄没了
  if (S.roundBids && S.roundBids.round === roundNo && S.roundBids.list.length >= list.length) return;
  S.roundBids = { round: roundNo, list };
  renderSeqLists();
}
function noteBid(d) {
  if (!S.roundBids || S.roundBids.round !== d.round) {
    S.roundBids = { round: d.round, list: [] };
    S.revealed = false; S.lastReveal = null;
    const rev = $('reveal'); if (rev) rev.hidden = true;
    if (S.view) S.view.dice = null;
  }
  S.roundBids.list.push({ seat: d.seat, count: d.count, face: d.face, zhai: !!d.zhai });
  renderSeqLists();
  setLast(d.seat, `喊 ${d.count} 个 ${d.face}${d.zhai ? '（斋）' : ''}`);
  logLine(d.seat, `喊 ${d.count} 个 ${d.face}${d.zhai ? '（斋）' : ''}（第 ${d.round} 轮）`, 'bid');
}
function appendSeq(d) {
  // 只在「当前这一手」里堆喊价：跨轮不清的话，一整场下来骰盅下面会堆出上百个喊价格子
  // ——潘潘看到那一大片「2 个 2 / 3 个 6」的格子就是这个（不是骰子，是累计的喊价流水）。
  if (d.round !== S.seqRound) {
    S.seqRound = d.round;
    for (const id of ['seq', 'mySeq', 'oppSeq']) { const b = $(id); if (b) b.innerHTML = ''; }
  }
  const mine = S.plan === 'spec' ? d.seat === 'A' : d.seat === S.plan;   // 观战没有「我方」：按座位分回甲/乙两栏
  const div = document.createElement('div');
  div.className = (S.plan !== 'spec' && d.seat === S.plan) ? 'mine' : '';
  div.textContent = (S.gameAt[d.seat] || d.seat) + ' 喊 ' + d.count + ' 个 ' + d.face + (d.zhai ? '（斋）' : '');
  const own = document.createElement('div');
  own.className = mine ? 'mine' : '';
  own.textContent = d.count + ' 个 ' + d.face + (d.zhai ? '（斋）' : '');
  const list = $('seq');
  if (list) {
    list.appendChild(div);
    while (list.children.length > 60) list.removeChild(list.firstChild);   // 本轮流水最多留 60 条
  }
  const box = mine ? $('mySeq') : $('oppSeq');
  if (box) {
    box.appendChild(own);
    while (box.children.length > 8) box.removeChild(box.firstChild);       // 骰盅下面只留最近 8 手
  }
}
/* 开盅这一手里的两个人必须分清：事件里的 seat / who 都指「发起开盅那一座」（runner 的 who 是行动者），
 * 喊价的人只能取服务端算好的 bidBy。以前这里把 seat / who 一个当喊价人一个当开盅人，
 * 结果两个名字印成同一个（实测出现过“pan 喊 4 个 4，pan 开盅”）。 */
function bidByOf(d) { return d.bidBy || (d.bid && d.bid.by) || d.seat; }
function openByOf(d) { return d.openedBy || d.who || d.seat; }
// 复式换座后同一座位在不同把里可能是不同的人，所以优先用本把的名字表 S.gameAt
function nm(p, d) { return esc((S.gameAt && S.gameAt[p]) || seatName(p) || (p === 'A' ? '甲方' : '乙方')); }
/* 手机/窄屏是单列竖排：谁在下手机器人那一栏之外，还得让「我这一栏」排第一，
 * 不然轮到我时出价区在屏幕外。观战没有座位，保持 甲方 → 牌桌 → 乙方 的原顺序。 */
function markArenaOrder() {
  const el = $('arena'); if (!el) return;
  el.classList.toggle('me-b', S.plan === 'B');
}
function settleRound(d) {
  const div = document.createElement('div');
  div.className = 'row rset';
  const r = d.reveal;
  const dice = r && r.dice ? ['A', 'B'].map(k => `<div class="rdice"><span>${esc(S.gameAt[k] || (k === 'A' ? '甲方' : '乙方'))}</span>${(r.dice[k] || []).map(x => `<i class="die-sm">${x}</i>`).join('')}</div>`).join('') : '';
  div.innerHTML = `<div>第 ${d.round} 轮：${nm(bidByOf(d), d)} 喊 ${d.bid.count} 个 ${d.bid.face}${d.bid.zhai ? '（斋）' : ''} → `
    + `${nm(openByOf(d), d)} ${d.slash ? '劈' : '开盅'} · 实际 ${d.actual} 个 → `
    + `<b style="color:${d.truth ? 'var(--ok)' : 'var(--bad)'}">${d.truth ? '够数：开的人输' : '不够：喊的人输'}</b> · `
    + `输家 ${nm(d.loser, d)}</div>${dice}`;
  // 最新一轮放最上面：一长串历史往下翻很痛苦，而且老版本把骰子平铺成一片格子，看着像出 bug 了
  $('history').prepend(div);
  const hh = $('history');
  while (hh.children.length > 40) hh.removeChild(hh.lastChild);
  if (r && r.dice && r.dice.B !== undefined) {
    S.revealed = true; S.lastReveal = r.dice;
    if (S.plan === 'spec') {
      // 观战全知：两边一起亮
      setDice('A', r.dice.A, '已开盅亮牌', false);
      setDice('B', r.dice.B, '已开盅亮牌', false);
    } else {
      const oppSeat = seatOfOpp();
      if (oppSeat) revealDice(oppSeat, r.dice[oppSeat], '已开盅亮牌');
    }
    const rev = $('reveal');
    if (rev) {
      rev.hidden = false;
      rev.innerHTML = `第 ${d.round} 轮开盅 · ${nm(bidByOf(d), d)} 喊 ${d.bid.count} 个 ${d.bid.face}${d.bid.zhai ? '（斋）' : ''}，`
        + `${nm(openByOf(d), d)} ${d.slash ? '劈' : '开盅'} · 实际 ${d.actual} 个 → `
        + `<b style="color:${d.truth ? 'var(--ok)' : 'var(--bad)'}">${d.truth ? '够数：开的人输' : '不够：喊的人输'}</b>`
        + `<div class="kv">输家 ${nm(d.loser, d)} −${d.stake || 1} 血${((d.hp || {})[d.loser] != null ? '（剩 ' + d.hp[d.loser] + '）' : '')}</div>`;
    }
    setLast(d.who, (d.slash ? '劈' : '开盅') + ' → 实际 ' + d.actual + ' 个');
  }
  logLine(openByOf(d), `${d.slash ? '劈' : '开盅'}${bidByOf(d) !== openByOf(d) ? '（开 ' + seatName(bidByOf(d)) + ' 喊的价）' : ''}：${d.bid.count} 个 ${d.bid.face} · 实际 ${d.actual} 个 · ${d.truth ? '够数→开的人输' : '不够→喊的人输'} · 输家 ${seatName(d.loser)} −${d.stake || 1} 血`
    + (d.hp && d.hp[d.loser] != null ? `（剩 ${d.hp[d.loser]}）` : ''), 'open');
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
  // 结算卡盖在牌桌页上：先看牌桌再看结果，不用手动切页面
  if (S.plan === 'A' || S.plan === 'B' || S.plan === 'spec') show('pagePlay');
  $('over').hidden = false;
  $('btnAgain').onclick = async () => {
    $('over').hidden = true;
    try { const r = await api('/api/room/start', { code: S.room.code, token: S.seatToken }); S.room = r.room; show('pageRoom'); renderRoom(); }
    catch (e) { msg('#roomMsg', e.message, 'bad'); show('pageRoom'); }
  };
  $('btnClose').onclick = async () => { try { await api('/api/room/close', { code: S.room.code, token: S.seatToken }); } catch (e) { } S.room = null; disconnect(); show('pageHome'); loadRooms(); loadMatches(); };
}

/* ---------------- 行动面板 ---------------- */
// 窄屏（手机）判定：CSS 断点与这里必须同一个数，不然 JS 搬了 DOM 而样式没跟上
const MQ_COMPACT = '(max-width: 820px)';
function isCompact() { try { return matchMedia(MQ_COMPACT).matches; } catch (e) { return false; } }

// 人亲自出马：桌面把出招按钮搬进自己那一栏（替换掉「实时推演」），AI 那一栏显示推演流。
// 手机相反：出价区留在吸底的 .actionbar 里常驻可见 —— 搬进卡片就得往下滚一屏才能落子。
function placeAction() {
  const act = $('action'); if (!act) return;
  const mySeat = (S.plan === 'A' || S.plan === 'B') ? S.plan : null;
  const compact = isCompact();
  markArenaOrder();          // 每次安置出价区时顺带标记单列顺序：换座、进房、转屏都能跟上
  const bar = document.querySelector('.actionbar');
  const note = $('actMsg');
  /* 提示（#actMsg）必须跟着出价区走。以前只搬 #action 进我方卡片，提示留在 .actionbar 里，
   * 手机上点灰档的那句解释落在下面一屏之外（实测要再滚 411px），看起来就是「按了没反应」。*/
  const put = host => {
    if (!host) return;
    if (act.parentElement !== host) host.appendChild(act);
    if (note && note.parentElement !== host) host.appendChild(note);
  };
  for (const w of ['A', 'B']) {
    const slot = $('act' + w), think = $('thinkBox' + w);
    if (w === mySeat && compact) {                 // 手机：我自己的卡片里不放按钮，也不留空的推演框
      if (slot) slot.hidden = true;
      if (think) think.hidden = true;
      continue;
    }
    if (w === mySeat) {
      if (slot) { slot.hidden = false; put(slot); }
      if (think) think.hidden = true;
    } else {
      if (slot) slot.hidden = true;
      if (think) think.hidden = false;
    }
  }
  if (!mySeat || compact) put(bar);
}
// 转屏 / 分屏 / 桌面窗口缩到窄：跨过 820px 就重新安置出价区，不然按钮会留在错的容器里
let lastCompact = isCompact();
addEventListener('resize', () => {
  const c = isCompact();
  if (c === lastCompact) return;
  lastCompact = c;
  try { placeAction(); if (S.view) renderView(); } catch (e) { }
});
function renderAction(v) {
  const box = $('action');
  const bids = (v.legal || []).filter(a => a.type === 'bid');
  const opens = (v.legal || []).filter(a => a.type === 'open');
  if (S.plan === 'spec') { box.innerHTML = '<div class="hint">你是观战：不能落子。这一桌开打后能看本轮流水和开盅记录，两栏骰子在开盅后亮牌。</div>'; return; }
  if (v.over) { box.innerHTML = '<div class="hint">这局结束了。</div>'; return; }
  if (v.turn !== 'me') { box.innerHTML = '<div class="hint">现在不该你走，等对手。你上一手的判断可以留在心里，界面不替你记。</div>'; return; }
  if (!S.sel || !bids.some(a => a.count === S.sel.count && a.face === S.sel.face)) {
    const first = bids[0];
    S.sel = first ? { count: first.count, face: first.face, mode: first.mode || 'normal' } : { count: 0, face: 0, mode: 'normal' };
  }
  const counts = [...new Set(bids.map(a => a.count))].sort((x, y) => x - y);
  const faces = [...new Set(bids.map(a => a.face))].sort((x, y) => (x === 1 ? 7 : x) - (y === 1 ? 7 : y));
  const modesFor = (c, f) => [...new Set(bids.filter(a => a.count === c && a.face === f).map(a => a.mode || 'normal'))];
  const modeLabel = { normal: '普通抬价', toZhai: '转斋', breakZhai: '破斋' };
  const isClassic = (S.room && S.room.rulesId) === 'classic';
  // 斋的规则说明：经典是「喊 1 就是斋」，新规是「个数取半转斋 / 2n+1 破斋」
  const zhaiHint = isClassic
    ? '经典规则：喊点数 1 就是斋（斋里 1 不再是万能）。'
    : '新规：个数减半可以转斋，破斋要 2n+1 个；斋里 1 不再是万能。';
  const nowZhai = !!v.zhai;
  const modesNow = modesFor(S.sel.count, S.sel.face);
  const prev = v.bid;
  /* 手机上没有 hover，光靠 title 等于什么都不说：按不动的档位要把「为什么」写在脸上。
     桌面也一样受益 —— 之前潘潘就是撞在「斋和劈按不了但看不出为啥」上。 */
  const whyMode = m => {
    if (modesNow.includes(m)) return '';
    if (m === 'toZhai') {
      if (isClassic) return '经典规则：喊 1 就是斋，不用转。';
      if (!prev) return '还没人喊价，转不了斋。';
      if (nowZhai) return '已在斋里，要出斋用「破斋」。';
      const need = Math.ceil(prev.count / 2);
      const minC = (v.rules && v.rules.minCount) || 2;
      if (need < minC) return '取半后只有 ' + need + ' 个，低于下限 ' + minC + '。';
      return '转斋要选「' + need + ' 个」这一档。';
    }
    if (m === 'breakZhai') {
      if (!nowZhai) return '没在斋里，不用破斋。';
      return '破斋要喊到 ' + ((prev ? prev.count : 0) * 2 + 1) + ' 个以上。';
    }
    return '';
  };
  // 两个档位都按不动时，直接给一句人话（他撞的就是这个：首喊 + 未斋，转斋破斋都灰着却没解释）
  // 注意必须在 whyMode 之后算：const 有 TDZ，提前引用会让整个 renderAction 抛错、出价按钮全消失
  const whyNow = (!modesNow.includes('toZhai') && !modesNow.includes('breakZhai'))
    ? (!prev ? '首喊不能转斋也不能破斋，先普通抬价。'
             : (nowZhai ? whyMode('breakZhai') : whyMode('toZhai')))
    : '';
  const prevTxt = prev ? `${prev.count} 个 ${prev.face}${prev.zhai ? ' 斋' : ''}` : '还没人喊价';

  // 斋/未斋 做成一个明确的三段开关：能不能点、为什么不能点，都写在按钮上
  const zc = (mode, label, why) => {
    const on = modesNow.includes(mode);
    const cur = S.sel.mode === mode;
    return `<button class="${cur && on ? 'on' : ''} ${on ? '' : 'no'}" data-m="${mode}"
      title="${on ? label : why}">${label}</button>`;
  };

  box.innerHTML = `
    <div class="mini-line">
      <span class="tag ${nowZhai ? 'on' : ''}">${nowZhai ? '本局处在斋里' : '未斋'}</span>
      <span>上一手 <b>${esc(prevTxt)}</b></span>
    </div>
    ${bids.length ? `<div class="grp"><div class="lab">个数</div><div class="chips counts-chips">${
      counts.map(c => `<button class="${c === S.sel.count ? 'on' : ''}" data-c="${c}">${c} 个</button>`).join('')}</div></div>
      <div class="grp"><div class="lab">点数（2&lt;3&lt;4&lt;5&lt;6&lt;1）</div><div class="chips faces-chips">${
      faces.map(f => {
        const ok = modesFor(S.sel.count, f).length;
        return `<button class="${f === S.sel.face ? 'on' : ''} ${ok ? '' : 'no'}" data-f="${f}" title="${ok ? '' : '这个点数在当前个数下没有合法走法'}">${FACE_LABEL[f]}</button>`;
      }).join('')}</div></div>
      <div class="grp zhai-grp"><div class="lab">斋 / 未斋</div>
        <div class="chips modes-chips">
          ${zc('normal', '普通抬价', whyMode('normal') || '当前个数下不能按未斋抬价')}
          ${zc('toZhai', '转斋', whyMode('toZhai'))}
          ${zc('breakZhai', '破斋', whyMode('breakZhai'))}
        </div>${whyNow ? `<div class="why">${esc(whyNow)}</div>` : ''}
        ${whyNow ? '' : `<div class="zhai-hint">${zhaiHint}</div>`}</div>
      <div class="preview">落子预览：<b id="pv"></b></div>` : '<div class="hint">已无价可喊，只能开盅。</div>'}
    <div class="grp"><div class="chips">
      <button class="big primary" id="btnGo">走这一步</button>
      ${opens.filter(o => !o.slash).length ? '<button class="big open" id="btnOpen">开盅</button>' : ''}
      ${opens.filter(o => o.slash).length ? '<button class="big slash" id="btnSlash">劈（双向算账）</button>' : ''}
    </div></div>`;
  const upd = () => { const a = { type: 'bid', count: S.sel.count, face: S.sel.face, mode: S.sel.mode }; const pv = $('pv'); if (pv) pv.textContent = actText(a); };
  box.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { S.sel.count = +b.dataset.c; if (!modesFor(S.sel.count, S.sel.face).length) { const alt = bids.find(a => a.count === S.sel.count); if (alt) S.sel.face = alt.face; S.sel.mode = (alt && alt.mode) || 'normal'; } renderAction(v); });
  box.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    if (b.classList.contains('no')) { msg('#actMsg', b.title || '这个点数在当前个数下没有合法走法', 'bad'); return; } S.sel.face = +b.dataset.f; const ms = modesFor(S.sel.count, S.sel.face); if (!ms.includes(S.sel.mode)) S.sel.mode = ms[0] || 'normal'; renderAction(v); });
  box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    if (b.classList.contains('no')) {           // 点不动的档位要说话，不能干看着没反应
      msg('#actMsg', b.title || '这一手走不了', 'bad');
      return;
    }
    S.sel.mode = b.dataset.m; renderAction(v);
  });
  upd();
  const go = $('btnGo'); if (go) go.onclick = () => submit({ type: 'bid', count: S.sel.count, face: S.sel.face, mode: S.sel.mode === 'normal' ? null : S.sel.mode });
  const op = $('btnOpen'); if (op) op.onclick = () => submit({ type: 'open', slash: false });
  const sl = $('btnSlash'); if (sl) sl.onclick = () => submit({ type: 'open', slash: true });
}
async function submit(action) {
  if (S.submitted) return;
  const seq = S.askSeq;                 // 我是对着哪一手提交的
  msg('#actMsg', '提交中…');
  try {
    await api('/api/room/action', { code: S.room.code, seat: S.plan, token: S.seatToken, action });
    /* 关键竞态（实测桌面 1400×1100 与人机对局约一半的开盅会踩到，手机上链路更慢更容易）：
     * 服务端在回答这个 POST 之前，就已经从事件流把「开盅结算 + 下一手的 ask」推下来了。
     * 那时出价区已经渲染成下一轮的可点按钮，这里再用「已提交」占位去覆盖，按钮就永久消失，
     * 玩家只能干等到超时被自动接手。所以：期间收到过新的 ask 就不碰出价区，也不重新上锁。 */
    if (S.askSeq !== seq) { stopTimer(); msg('#actMsg', '这一手已落地，新的一手已经推到了', 'ok'); return; }
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
  const closeModal = () => { $('modal').hidden = true; };
  $('mClose').onclick = closeModal;
  if ($('mCloseX')) $('mCloseX').onclick = closeModal;
  $('btnLogin').onclick = async () => {
    try {
      const r = await api('/api/login', { nick: $('lNick').value, pass: $('lPass').value });
      S.sid = r.token; localStorage.setItem('sid', r.token); S.me = r.me; setWho(); afterAuth(); $('modal').hidden = true; msg('#homeMsg', '登录了：' + (r.me && r.me.nick || ''), 'ok');
    } catch (e) { alert(e.message); }
  };
  $('btnSignup').onclick = async () => {
    try {
      const r = await api('/api/signup', { nick: $('sNick').value, pass: $('sPass').value });
      if (r.token) { S.sid = r.token; localStorage.setItem('sid', r.token); }
      const me = await api('/api/me'); S.me = me.me; setWho(); afterAuth(); $('modal').hidden = true; msg('#homeMsg', '账号建好了：' + (me.me && me.me.nick || ''), 'ok');
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
function refreshHero() {
  const el = $('heroModels'); if (!el) return;
  el.textContent = ((S.ping && S.ping.models) || []).length + ((S.me && S.me.configs) || []).filter(c => c.kind === 'llm').length;
}
// 登录 / 注册 / 退出之后统一走这里：不刷新的话演武场会停在「要一个账号」那张卡上
function afterAuth() {
  renderTurf();
  loadRooms(); loadMatches();
  if (S.room) renderRoom();
}
function setWho() {
  $('who').textContent = S.me ? S.me.nick : '';
  $('btnAuth').textContent = S.me ? '账号' : '登录';
  refreshHero();
}

/* ---------------- 起 ---------------- */
async function boot() {
  try {
    S.ping = await api('/api/ping');
    $('net').textContent = '服务在线 · ' + (S.ping.rooms || 0) + ' 桌 · ' + (S.ping.users || 0) + ' 账号';
    $('net').className = 'chip on';
    // 大厅的装饰骰面 + 计数（纯展示，不参与对局）
    if ($('heroDice')) $('heroDice').innerHTML = diceHtml([6, 3, 5, 2, 1], false);
    if ($('heroRooms')) $('heroRooms').textContent = S.ping.rooms || 0;
    if ($('heroModels')) $('heroModels').textContent = (S.ping.models || []).length + ((S.me && S.me.configs) || []).filter(c => c.kind === 'llm').length;
  } catch (e) { $('net').textContent = '连不上服务'; $('net').className = 'chip danger'; }
  try { if (S.sid) S.me = (await api('/api/me')).me; } catch (e) { S.sid = ''; localStorage.removeItem('sid'); }
  setWho();
  wireTheme(); wireNav(); wireHome(); wireRoom(); wireModal();
  await initHome();
  wireStage();
  show('pageHome');
}
boot();
