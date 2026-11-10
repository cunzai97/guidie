/* 鬼骰 ARENA —— 浏览器对弈台
 *
 * 与早期观战页的关键差别：
 *  1. 规则引擎、行动解析、合法性校验、提示词全部来自共享 UMD 模块
 *     （dice-engine.js / dice-rules.js / context.js），与无头评测同源；
 *  2. 模型以「预设」形式在设置抽屉里维护，开战前左右各自挑选；
 *  3. 8k 默认预算 + 截断时带着原思考续写，不再「想深想就输」；
 *  4. 三次无合法动作默认判负（可切回旧页的接手兜底），与 harness 口径一致。
 *
 * 纯浏览器模块；用 node --check 可单独验语法，Node 里 require 不会执行 init。
 */
(function (root) {
'use strict';

const E = root.DiceEngine, R = root.DiceRules, C = root.DiceContext, RS = root.DiceRulesets, RK = root.ArenaRanking;
const BOT = root.DiceBots;   // 内置机器人（与 CLI / 测试共用同一份实现）
const doc = typeof document !== 'undefined' ? document : null;
const $ = id => doc.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PIPS = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] };

/* ---------------- 内置预设与默认设置 ---------------- */
// 默认网关：可用 ?gw=<base> 覆盖，例如 http://127.0.0.1:8080/v1
const GW = (function () {
  try {
    const q = (typeof location !== 'undefined' && location.search) ? new URLSearchParams(location.search).get('gw') : null;
    return (q || 'http://127.0.0.1:8791/v1').replace(/\/+$/, '');
  } catch (e) { return 'http://127.0.0.1:8791/v1'; }
})();
const PALETTE = ['#64b9ff','#ff9068','#b78bff','#6bd8a8','#e3bd73','#ff7fa8','#5fd0d8','#9aa8ff'];
// 内置示例预设：都指向「任意 OpenAI 兼容端点」。用 ?gw= 指定你自己的网关，
// 或在「模型设置」里改 Base URL / 模型 ID。预算是示例值，按你的端点调整。
const BUILTIN = [
  { id:'bl-minimax', alias:'MiniMax M3.1', base:GW, model:'minimax-m3.1-flash', color:'#64b9ff', note:'示例 · OpenAI 兼容端点' },
  { id:'bl-glm',     alias:'GLM 5.3 Flash', base:GW, model:'glm-5.3-flash',       color:'#ff9068', note:'示例 · OpenAI 兼容端点' },
  { id:'bl-local',   alias:'本地 llama-server', base:GW, model:'local-model',      color:'#e3bd73', note:'示例 · 本地部署' },
  { id:'bl-hy',      alias:'HY4 Preview',   base:GW, model:'hy4-preview-f',       color:'#b78bff', note:'示例 · OpenAI 兼容端点' },
  { id:'bl-hy3',     alias:'HY3 · 免费',    base:GW, model:'hy3',                 color:'#5fd0d8', note:'示例 · 免费额度端点' },
  { id:'bl-ds',      alias:'DeepSeek V4.1', base:GW, model:'deepseek-v4.1-flash', color:'#6bd8a8', note:'示例 · OpenAI 兼容端点' },
  { id:'bl-kimi',    alias:'Kimi K3.1 Pro', base:GW, model:'kimi-k3.1-pro',       color:'#ff7fa8', note:'示例 · OpenAI 兼容端点' },
];
const DEFAULT_SETTINGS = {
  target:10, speed:400, variant:'plain', summary:true, god:false, strict:true, maxRounds:60,
  defaultMaxTokens:8192,   // 只是「新建模型 / 配置缺项」时的缺省；每个模型自己的预算始终独立可改
  defaultEffort:'medium',  // 同上：新建模型 / 配置缺项时的缺省思考强度（off/low/medium/high）
  theme:'dark',            // dark=午夜牌桌 | light=白纸牌桌
  ctxBudget:24000,         // 局内全量上下文的字符软预算，超出时折叠最早的逐手判断
  rules:'classic',         // 当前规则集 id（内置 classic / flex，或用户自定义套）
  ruleSets:[],             // 用户自定义规则套（内置两套不写入这里）
  seatEffort:{A:'auto',B:'auto'},  // 开局前的每席思考强度覆盖：auto=跟随模型预设
};
const DEFAULT_MAX_TOKENS = 8192;
const LS_KEY = 'd1-arena-store-v1';

const state = {
  presets:[], settings:Object.assign({}, DEFAULT_SETTINGS), seat:{A:'',B:''},
  storage:'builtin', serverOK:false,
  G:null, players:null, started:false, running:false, busy:false, god:false,
  runId:'', gameNo:0, memos:{A:[],B:[]}, ownMemo:{A:[],B:[]},
  lastAct:{A:'—',B:'—'}, thinkMode:{A:'',B:''}, thinkLive:{A:null,B:null}, pendingReset:false,
  flowEl:null, decCols:null, memoCols:null, rankGroup:'', rankEffort:'all',
  stats:{ A:newStats(), B:newStats() }, editingId:null, editColor:PALETTE[0], ruleEditingId:null,
};

function newStats(){
  return { steps:0, calls:0, truncated:0, ambiguous:0, invalid:0, opens:0,
           opensCorrect:0, ms:0, tokens:0, netRetries:0, forfeits:0, decs:0, memos:0,
           slashes:0, toZhai:0, breakZhai:0, rewrites:0 };
}
// 统计按模型（座位）分列：每个指标都归属于「做这个动作的那一方」，
// 不再把两个模型的数据混在一个对象里——混在一起没法对比模型能力。
// 归属规则：决策手数/调用/token/耗时/截断/歧义/无动作 → 行动方；
// 开盅次数/开盅正确/劈 → 开盅方；转斋/破斋 → 喊价方；判负 → 判负方。
function statOf(w){ return state.stats[w]; }
function statTotal(){ return state.stats.A.steps + state.stats.B.steps; }
function uid(){ return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function clamp(v, lo, hi, dflt){ const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
const EFFORTS = ['off','low','medium','high','xhigh'];
function normalizeEffort(v){ return EFFORTS.indexOf(v) >= 0 ? v : 'off'; }
function normalizeRuleSets(a){
  if (!Array.isArray(a)) return [];
  return a.filter(x => x && typeof x === 'object')
    .map(x => RS.normalize(x))
    .filter(x => !RS.BUILTIN[x.id])
    .slice(0, 20);
}
function normalizeSettings(s){
  const o = Object.assign({}, DEFAULT_SETTINGS, s || {});
  o.ctxBudget = clamp(o.ctxBudget, 2000, 200000, DEFAULT_SETTINGS.ctxBudget);
  o.maxRounds = clamp(o.maxRounds, 3, 500, DEFAULT_SETTINGS.maxRounds);
  delete o.carry;   // 旧存档里的跨局继承开关已废弃，不再写回
  o.ruleSets = normalizeRuleSets(o.ruleSets);
  o.rules = String(o.rules || 'classic');
  o.defaultEffort = normalizeEffort(o.defaultEffort || DEFAULT_SETTINGS.defaultEffort);
  const se = (s && s.seatEffort) || {};
  const effPick = v => (v === 'auto' ? 'auto' : (EFFORTS.indexOf(v) >= 0 ? v : 'auto'));
  o.seatEffort = { A: effPick(se.A), B: effPick(se.B) };
  return o;
}
function normalizePreset(p, dfltMaxTokens, dfltEffort){
  p = p || {};
  const eff = normalizeEffort(p.effort || (p.thinking ? 'high' : (dfltEffort || 'medium')));
  return {
    id: String(p.id || uid()), alias: String(p.alias || p.model || '未命名模型').slice(0,40),
    base: String(p.base || '').trim(), model: String(p.model || '').trim(),
    apiKey: String(p.apiKey || ''), thinking: eff !== 'off', effort: eff,
    maxTokens: clamp(p.maxTokens, 256, 32768, clamp(dfltMaxTokens, 256, 32768, DEFAULT_MAX_TOKENS)),
    temperature: clamp(p.temperature, 0, 2, 0.8),
    color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : PALETTE[0],
    note: String(p.note || '').slice(0,120),
  };
}
// 设置里选中的规则集（下一局生效）与当前局面锁定的规则集：
// 开战后一律用 state.G.rules，中途在设置里换规则不会让这一局的合法性口径漂移。
function selectedRules(){
  return RS.byId(state.settings.rules, state.settings.ruleSets) || RS.normalize('classic');
}
function activeRules(){
  return (state.G && state.G.rules) ? state.G.rules : selectedRules();
}
function allRules(){ return RS.allRules(state.settings.ruleSets); }
function effortLabel(e){ return { off:'关闭', low:'轻度', medium:'中度', high:'深度', xhigh:'极限' }[normalizeEffort(e)] || '关闭'; }
function hostOf(base){ return String(base || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
function presetById(id){ return state.presets.find(p => p.id === id) || null; }

/* ---------- 内置机器人席位 ----------
 * 机器人不是「模型预设」——它不连接口，直接在本地算。
 * 席位里用 'bot:<spec>' 表示，spec 取自 bots.js 的 BOTS 注册表（加新机器人只加一条）。
 */
const BOT_PREFIX = 'bot:';
function isBotId(id){ return String(id || '').indexOf(BOT_PREFIX) === 0; }
function botSeat(id){
  const spec = String(id).slice(BOT_PREFIX.length);
  const meta = BOT && BOT.BOTS ? BOT.BOTS[spec] : null;
  if (!meta) return null;
  return { id, alias:meta.label, base:'bot', model:spec, apiKey:'',
           maxTokens:0, temperature:0, effort:'off', color:'#7ba7ff',
           note:meta.desc, kind:'bot', bot:spec };
}
function playerById(id){ return isBotId(id) ? botSeat(id) : presetById(id); }
function seatLabel(w){ return w === 'A' ? '甲方' : '乙方'; }
function actText(a){
  if (!a) return '—';
  if (a.type === 'open') return a.slash ? '劈（开盅 · 双向结算）' : '开盅';
  return '喊 ' + a.count + ' 个 ' + a.face + bidTag(a, activeRules());
}
// 喊价的斋标签：按「这一手之后是否处于斋」判定。经典套喊 1 即斋；
// 新规里喊 1 只是普通点数，绝不能因为点数是 1 就标成「斋」——那会让 未斋→转斋 看起来像斋内转斋。
function bidTag(a, R){
  if (!a || a.type === 'open') return '';
  if (a.mode === 'toZhai') return '（转斋）';
  if (a.mode === 'breakZhai') return '（破斋）';
  if (R && R.zhaiMode === 'face1') return a.face === 1 ? '（斋）' : '';
  return a.zhai ? '（斋）' : '';
}
// 重写 / 截断续写提示里的行动词汇表：按当前规则集生成，不把新套的动作喂给经典套的模型。
function actionHint(rules, hasBid){
  const RR = rules || activeRules(), mk = false;
  const bid = mk ? '「行动：喊 X 个 Y」' : '「喊 X 个 Y」';
  const open = mk ? '「行动：开盅」' : '「开盅」';
  const parts = [bid];
  if (RR.zhaiMode === 'half') {
    parts.push(mk ? '「行动：喊 X 个 Y 斋」' : '「喊 X 个 Y 斋」');
    if (hasBid) parts.push(mk ? '「行动：喊 X 个 Y 破斋」' : '「喊 X 个 Y 破斋」');
  }
  if (hasBid) parts.push(open);
  if (hasBid && RR.slash) parts.push(mk ? '「行动：劈」' : '「劈」');
  return parts.join(' / ');
}
function flash(msg){ $('consoleMeta').textContent = msg; }
function bump(el){ if (el && el.classList) { el.classList.remove('pop'); el.classList.add('pop'); } }

/* ---------------- 持久化：服务端优先，localStorage 兜底 ---------------- */
function readLocal(){
  try { const j = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return (j && typeof j === 'object') ? j : null; }
  catch (e) { return null; }
}
function writeLocal(){
  try { localStorage.setItem(LS_KEY, JSON.stringify({ presets:state.presets, settings:state.settings, seat:state.seat })); }
  catch (e) { /* 隐私模式 / 配额满：静默降级为仅内存 */ }
}
function storeBody(){ return JSON.stringify({ presets:state.presets, settings:state.settings, seat:state.seat }); }

async function saveStore(){
  writeLocal();
  if (!state.serverOK) return;
  try { await fetch('/api/presets', { method:'PUT', headers:{'Content-Type':'application/json'}, body:storeBody() }); }
  catch (e) { /* 服务没起时纯本地保存也能用 */ }
}
async function loadStore(){
  let server = null;
  try {
    const r = await fetch('/api/presets', { cache:'no-store' });
    if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.presets)) server = j; }
  } catch (e) { /* 静态预览 / 服务未启动 */ }
  state.serverOK = !!server;
  const local = readLocal();
  const hasP = x => x && Array.isArray(x.presets) && x.presets.length;
  const src = hasP(server) ? server : (hasP(local) ? local : null);
  if (src) {
    state.presets = src.presets.map(p => normalizePreset(p, (src.settings || {}).defaultMaxTokens, (src.settings || {}).defaultEffort));
    state.settings = normalizeSettings(src.settings);
    state.seat = Object.assign({A:'',B:''}, src.seat || {});
    state.storage = (src === server) ? 'server' : 'local';
  } else {
    state.presets = BUILTIN.map(p => normalizePreset(p, state.settings.defaultMaxTokens, state.settings.defaultEffort));
    state.settings = normalizeSettings(null);
    state.seat = { A:'bl-minimax', B:'bl-glm' };
    state.storage = 'builtin';
    await saveStore();
  }
  for (const w of ['A','B']) if (!playerById(state.seat[w])) state.seat[w] = state.presets[0] ? state.presets[0].id : '';
  if (state.seat.A === state.seat.B && state.presets[1]) state.seat.B = state.presets[1].id;
}
function renderStorage(){
  const el = $('storageInfo');
  const mode = state.serverOK ? '服务端 presets.json（跨浏览器保留）' : '浏览器 localStorage（服务未启动，仅本机）';
  el.innerHTML = '当前存储：<b>' + esc(mode) + '</b><br>已配置 ' + state.presets.length + ' 个模型；'
    + '修改会即时写入本机，服务可用时同步写回服务端。<br>'
    + 'API Key 只保存在本机配置里，页面之外不上传。';
}

/* ---------------- 设置抽屉：模型库 ---------------- */
function renderPresets(){
  const box = $('presetList'); box.innerHTML = '';
  $('presetCount').textContent = String(state.presets.length);
  if (!state.presets.length) { box.innerHTML = '<div class="empty">还没有模型，点「＋ 新建模型」添加</div>'; return; }
  for (const p of state.presets) {
    const d = document.createElement('div');
    d.className = 'preset' + (state.editingId === p.id ? ' editing' : '');
    const sw = document.createElement('div'); sw.className = 'swatch'; sw.style.background = p.color;
    const info = document.createElement('div'); info.className = 'info';
    const nm = document.createElement('b'); nm.textContent = p.alias;
    const sub = document.createElement('span'); sub.textContent = p.model + ' · ' + (hostOf(p.base) || '未设置端点');
    info.appendChild(nm); info.appendChild(sub);
    const ops = document.createElement('div'); ops.className = 'ops';
    const bEdit = document.createElement('button'); bEdit.textContent = '编辑'; bEdit.onclick = () => openEditor(p.id);
    const bDup  = document.createElement('button'); bDup.textContent  = '复制'; bDup.onclick  = () => dupPreset(p.id);
    const bDel  = document.createElement('button'); bDel.textContent  = '删除'; bDel.className = 'del'; bDel.onclick = () => delPreset(p.id);
    ops.appendChild(bEdit); ops.appendChild(bDup); ops.appendChild(bDel);
    d.appendChild(sw); d.appendChild(info); d.appendChild(ops); box.appendChild(d);
  }
}
function renderColors(){
  const box = $('fColors'); box.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.style.background = c; b.className = (c === state.editColor) ? 'sel' : '';
    b.onclick = () => { state.editColor = c; renderColors(); };
    box.appendChild(b);
  }
}
function openEditor(id){
  if (isBotId(id)) { $('saveHint').textContent = '内置机器人不可编辑（本地代码实现，见 src/bots.js）'; return; }
  const p = id ? presetById(id) : null;
  state.editingId = p ? p.id : null;
  $('editorSec').hidden = false;
  $('editorTitle').textContent = p ? '编辑模型' : '新建模型';
  $('fAlias').value = p ? p.alias : '';
  $('fBase').value  = p ? p.base  : GW;
  $('fModel').value = p ? p.model : '';
  $('fKey').value   = p ? p.apiKey : '';
  $('fMaxTokens').value = String(p ? p.maxTokens : (state.settings.defaultMaxTokens || DEFAULT_MAX_TOKENS));
  $('fTemp').value = p ? p.temperature : 0.8;
  if ($('fEffort')) $('fEffort').value = p ? normalizeEffort(p.effort) : normalizeEffort(state.settings.defaultEffort);
  $('fNote').value = p ? p.note : '';
  state.editColor = p ? p.color : PALETTE[state.presets.length % PALETTE.length];
  renderColors();
  $('testResult').textContent = ''; $('testResult').className = 'test-result';
  renderPresets();
  if ($('editorSec').scrollIntoView) $('editorSec').scrollIntoView({ behavior:'smooth', block:'nearest' });
}
function closeEditor(){ state.editingId = null; $('editorSec').hidden = true; renderPresets(); }
function readForm(){
  return normalizePreset({
    id: state.editingId || uid(), alias: $('fAlias').value, base: $('fBase').value,
    model: $('fModel').value, apiKey: $('fKey').value,
    maxTokens: $('fMaxTokens').value, temperature: $('fTemp').value,
    effort: $('fEffort') ? $('fEffort').value : state.settings.defaultEffort,
    note: $('fNote').value, color: state.editColor,
  }, state.settings.defaultMaxTokens, state.settings.defaultEffort);
}
function savePreset(){
  const p = readForm();
  if (!p.base || !p.model) { $('testResult').textContent = 'Base URL 和模型 ID 不能为空'; $('testResult').className = 'test-result bad'; return; }
  const i = state.presets.findIndex(x => x.id === p.id);
  if (i >= 0) state.presets[i] = p; else state.presets.push(p);
  if (!state.seat.A) state.seat.A = p.id;
  if (!state.seat.B || state.seat.B === state.seat.A) state.seat.B = p.id;
  closeEditor(); renderPicks(); saveStore();
  $('saveHint').textContent = '已保存：' + p.alias;
}
function dupPreset(id){
  const p = presetById(id); if (!p) return;
  const q = normalizePreset(Object.assign({}, p, { id:uid(), alias:p.alias + ' 副本' }));
  state.presets.push(q); renderPresets(); renderPicks(); saveStore();
  $('saveHint').textContent = '已复制为：' + q.alias;
}
function delPreset(id){
  const p = presetById(id); if (!p) return;
  if (state.started) { $('saveHint').textContent = '对局进行中，请重新布阵后再删模型'; return; }
  if (doc.defaultView && !doc.defaultView.confirm('删除模型「' + p.alias + '」？')) return;
  state.presets = state.presets.filter(x => x.id !== id);
  for (const w of ['A','B']) if (state.seat[w] === id) state.seat[w] = state.presets[0] ? state.presets[0].id : '';
  if (state.editingId === id) closeEditor(); else renderPresets();
  renderPicks(); saveStore();
  $('saveHint').textContent = '已删除：' + p.alias;
}
async function pullModels(fill){
  const base = $('fBase').value.trim(), key = $('fKey').value;
  const res = $('testResult');
  if (!base) { res.textContent = '请先填写 Base URL'; res.className = 'test-result bad'; return []; }
  res.textContent = '正在拉取模型列表…'; res.className = 'test-result';
  try {
    const r = await fetch('/oa/models', { headers:{ 'X-Base':base, 'X-Key':key }, cache:'no-store' });
    const j = await r.json();
    const list = (j.data || []).map(x => x.id);
    const dl = $('modelList'); dl.innerHTML = '';
    for (const id of list) { const o = document.createElement('option'); o.value = id; dl.appendChild(o); }
    if (fill && !$('fModel').value && list[0]) $('fModel').value = list[0];
    res.textContent = '可用 ' + list.length + ' 个模型'; res.className = 'test-result ok';
    return list;
  } catch (e) {
    res.textContent = '连不上：' + String(e.message).slice(0,60); res.className = 'test-result bad'; return [];
  }
}
async function testConn(){
  const model = $('fModel').value.trim();
  const list = await pullModels(false);
  const res = $('testResult');
  if (!list.length) return;
  if (model && list.indexOf(model) < 0) { res.textContent = '端点可用，但模型 ID 不在列表里（仍可手动使用）'; res.className = 'test-result bad'; }
  else { res.textContent = '连接正常' + (model ? ' · ' + model : ''); res.className = 'test-result ok'; }
}
function exportPresets(){
  const data = JSON.stringify({ presets:state.presets, settings:state.settings, seat:state.seat }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type:'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'd1-arena-presets.json';
  if (a.click) a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  $('saveHint').textContent = '已导出配置文件';
}
function importPresets(file){
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(String(rd.result));
      if (!Array.isArray(j.presets)) throw new Error('缺少 presets 列表');
      state.presets = j.presets.map(p => normalizePreset(p, (j.settings || {}).defaultMaxTokens, (j.settings || {}).defaultEffort));
      state.settings = normalizeSettings(j.settings);
      state.seat = Object.assign({A:'',B:''}, j.seat || {});
      for (const w of ['A','B']) if (!playerById(state.seat[w])) state.seat[w] = state.presets[0] ? state.presets[0].id : '';
      syncQuick(); bindSettingsValues(); renderPicks(); renderPresets(); saveStore();
      $('saveHint').textContent = '已导入 ' + state.presets.length + ' 个模型';
    } catch (e) { $('saveHint').textContent = '导入失败：' + String(e.message).slice(0,80); }
  };
  rd.readAsText(file);
}
function restoreBuiltin(){
  for (const b of BUILTIN) if (!state.presets.some(p => p.id === b.id))
    state.presets.push(normalizePreset(b, state.settings.defaultMaxTokens, state.settings.defaultEffort));
  renderPicks(); renderPresets(); saveStore();
  $('saveHint').textContent = '已补回内置预设';
}
async function resyncServer(){
  await loadStore();
  state.god = !!state.settings.god;
  syncQuick(); bindSettingsValues(); renderPicks(); renderPresets(); renderStorage(); render();
  $('saveHint').textContent = '已重新读取服务端配置';
}

/* ---------------- 规则设置：内置两套 + 任意多套自定义 ----------------
 * 规则集是配置而非写死文本：内置 classic / flex 只读，用户从任一套「另存副本」后
 * 可以逐项改参数，规则文本、合法动作集合、提示词指纹都随参数一起变。
 * 开战后 state.G.rules 锁定，中途换规则只影响下一局，不会让本局合法性口径漂移。
 */
const RULE_FIELDS = [
  ['rId','id'], ['rName','name'], ['rZhaiMode','zhaiMode'], ['rHalfDivisor','halfDivisor'],
  ['rFaceFree','faceFree'], ['rLockFace','lockFace'], ['rBreakMultiplier','breakMultiplier'],
  ['rBreakPlus','breakPlus'],
  ['rFirstZhai','firstZhai'], ['rFirstFace1','firstFace1'], ['rSlash','slash'],
  ['rSlashStake','slashStake'], ['rStake','stake'], ['rAutoInfer','autoInfer'],
  ['rBreakRestoresWild','breakRestoresWild'], ['rFirstMin','firstMin'], ['rFirstMax','firstMax'],
  ['rOpenLoserLoses','openLoserLoses'],
];
// 显式列出布尔字段：不依赖 DOM 元素的 .type（受限环境 / DOM 桩里可能没有这个属性）。
const RULE_CHECKS = new Set(['rFaceFree','rLockFace','rFirstZhai','rFirstFace1',
  'rBreakRestoresWild','rAutoInfer','rSlash','rOpenLoserLoses']);
function ruleOptions(sel, keep){
  if (!sel) return;
  const list = allRules();
  sel.innerHTML = '';
  for (const r of list) {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = r.name + (r.builtin ? '' : ' · 自定义');
    sel.appendChild(o);
  }
  sel.value = list.some(x => x.id === keep) ? keep : 'classic';
}
function renderRuleList(){
  const box = $('ruleList'); if (!box) return;
  box.innerHTML = '';
  for (const r of allRules()) {
    const d = document.createElement('div'); d.className = 'rule-item' + (state.settings.rules === r.id ? ' active' : '');
    const info = document.createElement('div'); info.className = 'info';
    const nm = document.createElement('b'); nm.textContent = r.name + (r.builtin ? ' · 内置' : ' · 自定义');
    const sub = document.createElement('span'); sub.textContent = RS.describe(r) + ' · #' + RS.hash(r);
    info.appendChild(nm); info.appendChild(sub);
    const ops = document.createElement('div'); ops.className = 'ops';
    const bDup = document.createElement('button'); bDup.textContent = '另存副本'; bDup.onclick = () => openRuleEditor(null, r);
    ops.appendChild(bDup);
    if (!r.builtin) {
      const bEdit = document.createElement('button'); bEdit.textContent = '编辑'; bEdit.onclick = () => openRuleEditor(r.id, r);
      const bDel = document.createElement('button'); bDel.textContent = '删除'; bDel.className = 'del';
      bDel.onclick = () => delRule(r.id);
      ops.appendChild(bEdit); ops.appendChild(bDel);
    }
    d.appendChild(info); d.appendChild(ops); box.appendChild(d);
  }
}
function renderRules(){
  ruleOptions($('qRules'), state.settings.rules);
  ruleOptions($('sRules'), state.settings.rules);
  renderRuleList();
  if ($('ruleCount')) $('ruleCount').textContent = String(allRules().length);
  const rr = selectedRules();
  const brief = RS.describe(rr) + ' · ruleset_hash #' + RS.hash(rr);
  if ($('ruleBrief')) $('ruleBrief').textContent = brief;
  if ($('rulePreview')) $('rulePreview').textContent = C.rulesTextFor(rr);
}
function openRuleEditor(id, from){
  const r = id ? state.settings.ruleSets.find(x => x.id === id) : null;
  const base = RS.normalize(r || from || selectedRules());
  state.ruleEditingId = r ? r.id : null;
  const sec = $('ruleEditorSec'); if (!sec) return;
  sec.hidden = false;
  if ($('ruleEditorTitle')) $('ruleEditorTitle').textContent = r ? '编辑自定义规则套' : '从这套另存一份自定义规则';
  for (const [el, key] of RULE_FIELDS) {
    const n = $(el); if (!n) continue;
    const v = (el === 'rId' && !r) ? '' : (el === 'rName' && !r ? base.name + ' · 副本' : base[key]);
    if (RULE_CHECKS.has(el)) n.checked = !!v; else n.value = String(v == null ? '' : v);
  }
  if ($('ruleSaveHint')) $('ruleSaveHint').textContent = '';
  if (sec.scrollIntoView) sec.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
function closeRuleEditor(){ state.ruleEditingId = null; const s = $('ruleEditorSec'); if (s) s.hidden = true; }
function readRuleForm(){
  const o = {};
  for (const [el, key] of RULE_FIELDS) {
    const n = $(el); if (!n) continue;
    o[key] = RULE_CHECKS.has(el) ? !!n.checked : n.value;
  }
  o.id = state.ruleEditingId || String(o.id || '').trim() || ('rule_' + Date.now().toString(36));
  o.name = String(o.name || '自定义规则').trim();
  o.builtin = false;
  return RS.normalize(o);
}
function saveRule(){
  const r = readRuleForm();
  if (RS.BUILTIN[r.id]) { if ($('ruleSaveHint')) $('ruleSaveHint').textContent = '内置两套不可覆盖，请「另存副本」后再改'; return; }
  const i = state.settings.ruleSets.findIndex(x => x.id === (state.ruleEditingId || r.id));
  if (i >= 0) state.settings.ruleSets[i] = r; else state.settings.ruleSets.push(r);
  if (!state.ruleEditingId || state.settings.rules === state.ruleEditingId) state.settings.rules = r.id;
  closeRuleEditor(); renderRules(); saveStore();
  if ($('saveHint')) $('saveHint').textContent = '已保存规则套：' + r.name + (state.started ? '（下一局生效）' : '');
}
function delRule(id){
  const r = state.settings.ruleSets.find(x => x.id === id); if (!r) return;
  if (doc.defaultView && !doc.defaultView.confirm('删除规则套「' + r.name + '」？')) return;
  state.settings.ruleSets = state.settings.ruleSets.filter(x => x.id !== id);
  if (state.settings.rules === id) state.settings.rules = 'classic';
  closeRuleEditor(); renderRules(); saveStore();
  if ($('saveHint')) $('saveHint').textContent = '已删除：' + r.name;
}
function setActiveRules(id){
  state.settings.rules = RS.byId(id, state.settings.ruleSets) ? id : 'classic';
  renderRules(); saveStore();
  if ($('saveHint')) $('saveHint').textContent = state.started
    ? '规则已切换；当前这局仍用开战时锁定的一套，下一局生效'
    : '当前规则集已切换';
}

/* ---------------- 布阵 ---------------- */
function renderPicks(){
  for (const w of ['A','B']) {
    const sel = $('pick' + w), cur = state.seat[w];
    sel.innerHTML = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '— 选择模型 —'; sel.appendChild(o0);
    for (const p of state.presets) {
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.alias + ' · ' + p.model; sel.appendChild(o);
    }
    if (BOT && BOT.BOTS) {
      const gp = document.createElement('optgroup'); gp.label = '内置机器人（本地计算）';
      for (const spec of Object.keys(BOT.BOTS)) {
        const o = document.createElement('option'); o.value = BOT_PREFIX + spec;
        o.textContent = BOT.BOTS[spec].label + ' · 本地';
        o.title = BOT.BOTS[spec].desc;
        gp.appendChild(o);
      }
      sel.appendChild(gp);
    }
    sel.value = cur || '';
    const p = playerById(cur);
    $('pickMeta' + w).textContent = !p ? '尚未选择'
      : (p.kind === 'bot' ? '内置机器人 · 本地即时计算 · ' + p.note : hostOf(p.base) + ' · ' + p.maxTokens + ' tok');
    const esel = $('effPick' + w);
    if (esel) {
      const curEff = (state.settings.seatEffort && state.settings.seatEffort[w]) || 'auto';
      esel.innerHTML = '';
      const opts = [['auto', p ? '跟随模型（' + effortLabel(p.effort) + '）' : '跟随模型']]
        .concat(EFFORTS.map(e => [e, effortLabel(e)]));
      for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; esel.appendChild(o); }
      esel.value = curEff;
    }
    const av = $('pickAvatar' + w);
    if (p) { av.style.color = p.color; av.style.borderColor = p.color; }
  }
  syncButtons();
}
function syncQuick(){
  $('qTarget').value = String(state.settings.target);
  $('qSpeed').value = String(state.settings.speed);
  // 提示词臂下拉：按 context.js 的注册表生成，以后加新臂不用改这里
  if ($('qVariant')) {
    $('qVariant').innerHTML = Object.keys(C.ARMS).map(id =>
      '<option value="' + id + '"' + (id === (state.settings.variant || C.ARM_DEFAULT) ? ' selected' : '') + '>'
      + esc(C.ARMS[id].label || id) + '</option>').join('');
  }
    if ($('qRules')) $('qRules').value = state.settings.rules;
  const rr = activeRules();
  $('footHash').textContent = '规则 / 解析 / 提示词同源 · ' + rr.name + ' #' + RS.hash(rr) + ' · 臂 ' + C.armOf(state.settings.variant).label;
}
/* ---------------- 外观：暗色 / 亮色 ---------------- */
function currentTheme(){ return state.settings.theme === 'light' ? 'light' : 'dark'; }
function applyTheme(){
  const t = currentTheme();
  try {
    const el = doc && doc.documentElement;
    if (el && el.setAttribute) el.setAttribute('data-theme', t);
  } catch (e) { /* DOM 桩 / 受限环境：不影响对局 */ }
  const b = $('btnTheme');
  if (b) {
    b.textContent = t === 'light' ? '切换暗色' : '切换亮色';
    b.title = t === 'light' ? '切回暗色 · 午夜牌桌' : '切换到亮色 · 白纸牌桌';
    b.classList.toggle('on', t === 'light');
  }
  const sel = $('sTheme'); if (sel) sel.value = t;
}
function toggleTheme(){
  state.settings.theme = currentTheme() === 'light' ? 'dark' : 'light';
  applyTheme(); saveStore();
  flash(currentTheme() === 'light' ? '已切换到亮色 · 白纸牌桌' : '已切换到暗色 · 午夜牌桌');
}

function bindSettingsValues(){
  $('sCoach').checked = !!state.settings.coach;
  $('sSummary').checked = !!state.settings.summary;
  $('sGod').checked = !!state.settings.god;
  $('sStrict').checked = !!state.settings.strict;
  $('sMaxRounds').value = String(state.settings.maxRounds || 60);
  $('sCtxBudget').value = String(state.settings.ctxBudget || DEFAULT_SETTINGS.ctxBudget);
  $('sDefaultMaxTokens').value = String(state.settings.defaultMaxTokens || DEFAULT_MAX_TOKENS);
  if ($('sDefaultEffort')) $('sDefaultEffort').value = normalizeEffort(state.settings.defaultEffort);
  renderRules();
  applyTheme();
}
function openDrawer(){ $('mask').classList.add('open'); $('drawer').classList.add('open'); renderPresets(); renderRules(); renderStorage(); }
function closeDrawer(){ $('mask').classList.remove('open'); $('drawer').classList.remove('open'); }

/* ---------------- 牌桌渲染 ---------------- */
function dieEl(v, cls){
  const d = document.createElement('div');
  d.className = 'die' + (cls ? ' ' + cls : '');
  if (cls !== 'back') {
    for (let i = 0; i < 9; i++) {
      const s = document.createElement('i');
      if (v && PIPS[v].indexOf(i) >= 0) s.className = 'on';
      d.appendChild(s);
    }
  }
  return d;
}
function renderDice(w, shake){
  const box = $('dice' + w); box.innerHTML = '';
  const G = state.G, r = G && G.round;
  const vals = r ? r.dice[w] : [0,0,0,0,0];
  const shown = !!(r && (r.revealed || state.god));
  for (const v of vals) {
    let cls = '';
    if (!shown) cls = 'back';
    else if (r.over && r.result && !r.result.forfeit) {
      // 斋状态下 1 不是万能：亮牌高亮必须与结算口径一致。
      const wildOn = !r.result.zhai && r.result.bid.face !== 1;
      const hit = v === r.result.bid.face || (wildOn && v === 1);
      cls = hit ? 'hit' : 'faded';
    }
    const d = dieEl(shown ? v : 0, cls);
    if (shake) d.classList.add('shaking');
    box.appendChild(d);
  }
  $('cupNote' + w).textContent = !r ? '未摇骰' : shown ? ('已亮牌 · ' + vals.join(' ')) : '暗骰 · 仅自己可见';
}
function renderSeq(r){
  const box = $('seq'); box.innerHTML = '';
  if (!r || !r.seq.length) { box.innerHTML = '<span class="seq-empty">暂无喊价</span>'; return; }
  const lastAt = r.seq[r.seq.length - 1].at;
  for (const s of r.seq.slice(-10)) {
    const c = document.createElement('span');
    c.className = 'seq-chip ' + (s.kind === 'bid' ? (s.who === 'A' ? 'a' : 'b') : 'open') + (s.at === lastAt ? ' last' : '');
    if (s.kind === 'bid') {
      const tag = s.mode === 'toZhai' ? '转斋' : s.mode === 'breakZhai' ? '破斋'
        : (activeRules().zhaiMode === 'face1' ? (s.face === 1 ? '斋' : '') : (s.zhai ? '斋' : ''));
      c.textContent = s.at + '. ' + s.count + '个' + s.face + (tag ? ' · ' + tag : '');
      if (tag) c.classList.add('zhai');
    } else {
      c.textContent = s.at + '. ' + (s.slash ? '劈 ±' + activeRules().slashStake : '开盅');
      if (s.slash) c.classList.add('slash');
    }
    box.appendChild(c);
  }
  box.scrollTop = box.scrollHeight;
}
function setState(txt, sub, cls){
  $('stateText').textContent = txt;
  $('stateSub').textContent = sub;
  $('matchState').className = 'match-state' + (cls ? ' ' + cls : '');
}
function render(){
  const G = state.G, r = G && G.round, target = state.settings.target;
  $('roundChip').textContent = !G ? '尚未开桌' : (G.roundNo ? '第 ' + G.roundNo + ' 轮' + (G.over ? ' · 已结束' : ' · 进行中') : '准备开桌');
  const RR = activeRules();
  const bv = $('bidValue'), bs = $('bidSub');
  if (!r) {
    bv.textContent = '—';
    bs.textContent = RR.zhaiMode === 'half'
      ? '每人 5 颗 · 开局可首喊斋 · ' + (RR.slash ? '可劈 ±' + RR.slashStake : '不可劈')
      : '每人 5 颗 · 1 为万能 · 2<3<4<5<6<1';
  }
  else if (!r.bid) {
    bv.textContent = '无价';
    bs.textContent = seatLabel(r.turn) + ' 首喊 · 个数 ' + RR.firstMin + '~' + RR.firstMax
      + '、点数 ' + (RR.firstFace1 ? '1~6' : '2~6') + (RR.firstZhai ? ' · 可直接喊斋' : '');
  }
  else {
    const zt = r.bid.mode === 'toZhai' ? '<small>转斋</small>' : r.bid.mode === 'breakZhai' ? '<small>破斋</small>'
      : (RR.zhaiMode === 'face1' ? (r.bid.face === 1 ? '<small>斋</small>' : '') : (r.bid.zhai ? '<small>斋</small>' : ''));
    bv.innerHTML = r.bid.count + ' <small>个</small> ' + r.bid.face + zt;
    bs.textContent = seatLabel(r.bid.by) + '喊出 · 第 ' + r.bid.at + ' 手'
      + (RR.zhaiMode === 'half' ? ' · ' + (r.zhai ? '斋：1 不万能' : '未斋：1 万能') : '')
      + (RR.slash ? ' · 可劈 ±' + RR.slashStake : '');
  }
  const tl = $('turnLine');
  tl.className = 'turn-line' + (r && !r.over ? ' to-' + r.turn.toLowerCase() : '');
  $('turnText').textContent = !r ? '等待开战' : r.over ? '本轮结算中'
    : '轮到 ' + seatLabel(r.turn) + (state.players ? ' · ' + state.players[r.turn].alias : '');
  renderSeq(r);

  for (const w of ['A','B']) {
    const p = state.players ? state.players[w] : null;
    const seatPreset = playerById(state.seat[w]);
    $('name' + w).textContent = p ? p.alias : (seatPreset ? seatPreset.alias : '—');
    $('sub' + w).textContent = p ? (p.kind === 'bot' ? '内置机器人 · 本地计算' : p.model + ' · ' + hostOf(p.base))
      : (seatPreset ? (seatPreset.kind === 'bot' ? '内置机器人 · 本地计算' : '等待开战') : '等待布阵');
    const active = !!(r && !r.over && r.turn === w && state.started);
    $('fighter' + w).classList.toggle('active', active);
    const st = $('status' + w);
    if (G && G.over) {
      if (!G.winner) { st.textContent = '平局'; st.className = 'status-pill'; }
      else { st.textContent = G.winner === w ? '胜出' : '落败'; st.className = 'status-pill' + (G.winner === w ? ' win' : ''); }
    }
    else if (active) { st.textContent = state.busy ? '思考中' : '轮到它'; st.className = 'status-pill busy'; }
    else { st.textContent = '等待'; st.className = 'status-pill'; }
    const hpNow = G ? G.hp[w] : (G ? 0 : target);
    const hpCap = G ? G.hpMax : target;
    $('score' + w).textContent = String(hpNow);
    $('rail' + w).style.width = Math.min(100, Math.max(0, hpNow) / (hpCap || 1) * 100) + '%';
    $('lastText' + w).textContent = state.lastAct[w];
    renderDice(w, false);
  }
  const Rf = activeRules();
  $('footHash').textContent = '规则 / 解析 / 提示词同源 · ' + Rf.name + ' #' + RS.hash(Rf) + ' · 臂 ' + C.armOf(state.settings.variant).label;
}

/* ---------------- 控制台 ---------------- */
function ensureFlow(){
  const p = $('panelFlow');
  if (!state.flowEl || state.flowEl.parentNode !== p) {
    state.flowEl = document.createElement('div');
    state.flowEl.className = 'flow';
    p.appendChild(state.flowEl);
  }
  return state.flowEl;
}
function addLog(cls, html){
  const f = ensureFlow(), d = document.createElement('div');
  d.className = 'flow-item' + (cls ? ' ' + cls : ''); d.innerHTML = html;
  f.appendChild(d); $('panelFlow').scrollTop = $('panelFlow').scrollHeight;
}
/* 决策明细 / 轮末复盘：按甲方、乙方各自成列，同屏左右对照 */
function makeColumns(panelId, kind){
  const p = $(panelId);
  const grid = document.createElement('div'); grid.className = kind + '-grid';
  p.appendChild(grid);
  const cols = {};
  for (const w of ['A','B']) {
    const col = document.createElement('div'); col.className = kind + '-col ' + w.toLowerCase();
    const head = document.createElement('div'); head.className = 'col-head';
    const dot = document.createElement('span'); dot.className = 'col-dot';
    const nm = document.createElement('b'); nm.textContent = seatLabel(w);
    const side = document.createElement('span'); side.className = 'col-side';
    side.textContent = w === 'A' ? 'LEFT' : 'RIGHT';
    const cnt = document.createElement('i'); cnt.className = 'col-count'; cnt.textContent = '0';
    head.appendChild(dot); head.appendChild(nm); head.appendChild(side); head.appendChild(cnt);
    const list = document.createElement('div'); list.className = 'col-list';
    col.appendChild(head); col.appendChild(list); grid.appendChild(col);
    cols[w] = { col, list, cnt };
  }
  return cols;
}
function colsFor(panelId, kind, key){
  const p = $(panelId);
  let cols = state[key];
  if (!cols || !cols.A || !p.children.length || cols.A.col.parentNode !== p.children[0]) {
    p.innerHTML = '';
    cols = makeColumns(panelId, kind); state[key] = cols;
  }
  return cols;
}
function addDec(w, res, label){
  const cols = colsFor('panelDec', 'dec', 'decCols');
  const list = cols[w].list, cnt = cols[w].cnt;
  const d = document.createElement('div');
  d.className = 'dec-item ' + w.toLowerCase() + (res.invalid ? ' warn' : '');
  const head = document.createElement('div'); head.className = 'dec-head';
  const nm = document.createElement('b'); nm.textContent = seatLabel(w) + ' · ' + label;
  const act = document.createElement('span'); act.className = 'act'; act.textContent = res.invalid ? '（三次未给出动作）' : actText(res.action);
  const meta = document.createElement('span'); meta.className = 'meta';
  meta.textContent = res.ms + 'ms · ' + (res.tokens || '—') + ' tok'
    + (res.tries > 1 ? ' · 重写' + (res.tries - 1) : '')
    + (res.truncated ? ' · 截断' + res.truncated : '')
    + (res.ambiguous ? ' · 歧义' : '')
    + (res.netRetries ? ' · 网络重试' + res.netRetries : '');
  head.appendChild(nm); head.appendChild(act); head.appendChild(meta); d.appendChild(head);
  if (res.note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = res.note; d.appendChild(n); }
  if (res.reason) {
    const det = document.createElement('details'), sum = document.createElement('summary');
    sum.textContent = '思考与判断（' + res.reason.length + ' 字）';
    const pre = document.createElement('pre'); pre.textContent = res.reason;
    det.appendChild(sum); det.appendChild(pre); d.appendChild(det);
  }
  const raw = document.createElement('details'), rs = document.createElement('summary');
  rs.textContent = '模型原文';
  const rp = document.createElement('pre'); rp.className = 'act'; rp.textContent = res.raw || '(空)';
  raw.appendChild(rs); raw.appendChild(rp); d.appendChild(raw);
  list.appendChild(d); list.scrollTop = list.scrollHeight;
  cnt.textContent = String(list.children.length);
  state.stats[w].decs++; $('decCount').textContent = String(state.stats.A.decs + state.stats.B.decs);
}
function addMemo(w, roundNo, text){
  const cols = colsFor('panelMemo', 'memo', 'memoCols');
  const list = cols[w].list, cnt = cols[w].cnt;
  const d = document.createElement('div'); d.className = 'memo-card';
  const rd = document.createElement('span'); rd.className = 'rd';
  rd.textContent = '第 ' + roundNo + ' 轮';
  d.appendChild(rd); d.appendChild(document.createTextNode(text));
  list.appendChild(d); list.scrollTop = list.scrollHeight;
  cnt.textContent = String(list.children.length);
  state.stats[w].memos++; $('memoCount').textContent = String(state.stats.A.memos + state.stats.B.memos);
}
/* 统计面板：按模型（座位）左右对照。
 * 每个指标归到「做这个动作的那一方」：决策/调用/token/耗时/截断 → 行动方；
 * 开盅次数/开盅正确/劈 → 开盅方；转斋/破斋 → 喊价方；判负 → 判负方。
 * 对照比合并更有用——合并看不出"谁更快、谁更准"。 */
function statRow(label, a, b, sub, better){
  // better: 'high' 越大越好 / 'low' 越小越好 / '' 不比较；「3/5」这类命中率按比值算
  let ca = '', cb = '';
  if (better && a !== '—' && b !== '—') {
    const num = v => {
      const s = String(v), m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (m) return +m[2] ? +m[1] / +m[2] : NaN;
      return parseFloat(s.replace(/[^\d.-]/g, ''));
    };
    const na = num(a), nb = num(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
      const aWin = better === 'high' ? na > nb : na < nb;
      ca = aWin ? ' win' : ' lose'; cb = aWin ? ' lose' : ' win';
    }
  }
  return '<div class="stat-row">'
    + '<div class="sr-k">' + esc(label) + (sub ? '<i>' + esc(sub) + '</i>' : '') + '</div>'
    + '<div class="sr-v a' + ca + '">' + esc(a) + '</div>'
    + '<div class="sr-v b' + cb + '">' + esc(b) + '</div>'
    + '</div>';
}
function renderStats(){
  const A = state.stats.A, B = state.stats.B, G = state.G;
  const pA = state.players && state.players.A, pB = state.players && state.players.B;
  const nameA = pA ? pA.alias : '甲方', nameB = pB ? pB.alias : '乙方';
  const av = (s, f) => f(s);
  const rows = [
    statRow('决策手数', av(A, s=>s.steps), av(B, s=>s.steps), '模型落子', ''),
    statRow('模型调用', av(A, s=>s.calls), av(B, s=>s.calls), '含重写', ''),
    statRow('重写次数', av(A, s=>s.rewrites), av(B, s=>s.rewrites), '为拿合法动作多问', 'low'),
    statRow('输出 token', av(A, s=>s.tokens||'—'), av(B, s=>s.tokens||'—'), '累计', ''),
    statRow('平均耗时', A.calls ? Math.round(A.ms/A.calls)+' ms' : '—', B.calls ? Math.round(B.ms/B.calls)+' ms' : '—', '每次调用', 'low'),
    statRow('截断次数', av(A, s=>s.truncated), av(B, s=>s.truncated), 'finish=length', 'low'),
    statRow('解析歧义', av(A, s=>s.ambiguous), av(B, s=>s.ambiguous), '多候选', 'low'),
    statRow('开盅次数', av(A, s=>s.opens), av(B, s=>s.opens), '本方开盅', ''),
    statRow('开盅正确', A.opens ? A.opensCorrect+'/'+A.opens : '—', B.opens ? B.opensCorrect+'/'+B.opens : '—', '开盅者赢', 'high'),
    statRow('劈（双向结算）', av(A, s=>s.slashes), av(B, s=>s.slashes), '±'+activeRules().slashStake+' 血', ''),
    statRow('转斋 / 破斋', A.toZhai+' / '+A.breakZhai, B.toZhai+' / '+B.breakZhai, '状态切换', ''),
    statRow('无动作判负', av(A, s=>s.forfeits), av(B, s=>s.forfeits), 'strict 模式', 'low'),
    statRow('复盘篇数', av(A, s=>s.memos), av(B, s=>s.memos), '轮末复盘', ''),
    statRow('血量', G ? G.hp.A : '—', G ? G.hp.B : '—', '上限 ' + (G ? G.hpMax : state.settings.target), 'high'),
  ];
  $('panelStats').innerHTML =
      '<div class="stats-head">'
    +   '<div class="sh-k">指标</div>'
    +   '<div class="sh-v a"><span class="sh-chip">甲</span><b>' + esc(nameA) + '</b></div>'
    +   '<div class="sh-v b"><span class="sh-chip">乙</span><b>' + esc(nameB) + '</b></div>'
    + '</div>'
    + '<div class="stats-rows">' + rows.join('') + '</div>'
    + '<div class="stats-foot">对局轮数 ' + (G ? G.roundNo : 0)
    + ' · 指标按动作归属方拆分，非两方合并</div>';
}
function clearConsole(){
  for (const id of ['panelFlow','panelDec','panelMemo','panelStats']) $(id).innerHTML = '';
  state.decCols = makeColumns('panelDec', 'dec');
  state.memoCols = makeColumns('panelMemo', 'memo');
  state.flowEl = null;
  $('decCount').textContent = '0'; $('memoCount').textContent = '0';
  ensureFlow(); renderStats();
}
function switchTab(name){
  const map = { flow:'panelFlow', dec:'panelDec', memo:'panelMemo', stats:'panelStats', rank:'panelRank' };
  for (const k of Object.keys(map)) {
    $('tab' + k[0].toUpperCase() + k.slice(1)).classList.toggle('active', k === name);
    $(map[k]).classList.toggle('active', k === name);
  }
  if (name === 'rank') renderRank();
}

/* ---------------- 模型调用 ---------------- */
function metaHeaders(w, phase){
  return {
    'X-Arena-Run': state.runId, 'X-Arena-Seat': w,
    'X-Arena-Round': String(state.G ? state.G.roundNo : 0), 'X-Arena-Phase': phase,
    'X-Arena-Model': state.players ? state.players[w].model : '',
    'X-Arena-Ruleset': RS.hash(activeRules()),
    'X-Arena-Effort': state.players ? normalizeEffort(state.players[w].effort) : 'off',
  };
}
async function callStream(p, messages, onDelta, w, phase, budget){
  const body = {
    model:p.model, messages, temperature:p.temperature,
    max_tokens: budget || p.maxTokens, stream:true,
    // llama-server 默认不在流式响应里带 usage，必须显式要；远端网关不认识该字段会忽略。
    stream_options: { include_usage: true },
  };
  // 每个模型独立的思考强度（off / low / medium / high / xhigh）。
  // 本地 llama-server 用 chat_template_kwargs.thinking_budget，远端网关用 reasoning_effort；
  // 两个字段都带，与 CLI llm.js 的 applyEffort 口径一致，不认识的端点会忽略多余字段。
  const eff = normalizeEffort(p.effort);
  const local = /(127\.0\.0\.1|localhost):(1235|1236|1240)\b/.test(p.base || '');
  if (eff !== 'off') {
    const THINK_BUDGET = { low:1024, medium:4096, high:12288, xhigh:24576 };
    body.chat_template_kwargs = { enable_thinking:true, thinking_budget:THINK_BUDGET[eff] || 4096 };
    body.reasoning_effort = eff;
  } else if (local) {
    body.chat_template_kwargs = { enable_thinking:!!p.thinking };
  }
  const headers = Object.assign({ 'Content-Type':'application/json', 'X-Base':p.base || '', 'X-Key':p.apiKey || '' }, metaHeaders(w, phase));
  const t0 = Date.now();
  const r = await fetch('/oa/chat/completions', { method:'POST', headers, body:JSON.stringify(body) });
  if (!r.ok) {
    let msg = ''; try { msg = JSON.stringify(await r.json()).slice(0,160); } catch (e) {}
    throw new Error(p.alias + ' 接口 ' + r.status + ' ' + msg);
  }
  let content = '', reason = '', finish = null, tokens = null;
  const eat = j => {
    if (j.error) throw new Error(p.alias + ' 接口报错：' + JSON.stringify(j.error).slice(0,160));
    if (j.usage && j.usage.completion_tokens != null) tokens = j.usage.completion_tokens;
    const ch = (j.choices || [])[0] || {}, d = ch.delta || {};
    if (ch.finish_reason) finish = ch.finish_reason;
    if (d.reasoning_content) { reason += d.reasoning_content; if (onDelta) onDelta('reason', d.reasoning_content); }
    if (d.content) { content += d.content; if (onDelta) onDelta('content', d.content); }
  };
  if (r.body) {
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = '', done = false, grace = 0;
    while (!done) {
      const chunk = await rd.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream:true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const ln of lines) {
        const s = ln.trim();
        if (!s.startsWith('data:')) continue;
        const pl = s.slice(5).trim();
        if (!pl) continue;
        if (pl === '[DONE]') { done = true; break; }
        let j; try { j = JSON.parse(pl); } catch (e) { continue; }
        eat(j);
      }
      // OpenAI 式的 usage 帧在 finish 之后单独到达（choices 为空），不能见 finish 就退；
      // 拿到 usage 立即收，最多再多读 3 块兜底「不关流也不发 usage」的端点。
      if (finish && tokens != null) break;
      if (finish && ++grace > 3) break;
    }
    try { rd.cancel(); } catch (e) {}
  } else eat(await r.json());
  if (!finish && !content) throw new Error(p.alias + ' 流中断：没等到结束标记，也没拿到内容');
  return { raw:content.trim(), reason:reason.trim(), finish, tokens, ms:Date.now() - t0 };
}
async function callWithRetry(p, messages, onDelta, w, phase, budget, onRetry, maxTries){
  const N = maxTries || 4;
  let last = null;
  for (let i = 1; i <= N; i++) {
    try { const o = await callStream(p, messages, onDelta, w, phase, budget); o.netRetries = i - 1; return o; }
    catch (e) {
      last = e; if (i === N) break;
      const wait = Math.min(2000 * i, 8000);
      if (onRetry) onRetry(i, e, wait);
      await sleep(wait);
    }
  }
  throw last;
}

/* ---------------- 实时推演 ---------------- */
// 流式期间端点不给逐段 usage，只能按字符估算（CJK≈1 token/字，其余≈4 字符/token），
// 标「≈」示众；结束后用 usage 的精确值替换。速度从首个 delta 起算，不含排队/prefill。
function estTokens(txt){
  const cjk = (txt.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g) || []).length;
  return cjk + (txt.length - cjk) / 4;
}
function thinkLiveReset(w, label){
  state.thinkLive[w] = { label, n:0, t0:0, up:0 };
  $('thinkMeta' + w).textContent = label;
}
function thinkStart(w, label){
  const box = $('think' + w);
  box.innerHTML = ''; box.classList.add('typing');
  state.thinkMode[w] = '';
  thinkLiveReset(w, label);
}
function thinkPush(w, kind, txt){
  const box = $('think' + w);
  const mode = kind === 'reason' ? 'reason' : 'content';
  if (state.thinkMode[w] !== mode) {
    state.thinkMode[w] = mode;
    box.textContent += (box.textContent ? '\n' : '') + (mode === 'reason' ? '── 原生思考 ──\n' : '── 判断与行动 ──\n');
  }
  box.textContent = (box.textContent + txt).slice(-12000);   // 8k 预算下的长思考也看得全
  box.scrollTop = box.scrollHeight;
  const lv = state.thinkLive[w];
  if (lv) {
    lv.n += estTokens(txt);
    const now = Date.now();
    if (!lv.t0) lv.t0 = now;
    if (now - lv.up > 120) {
      lv.up = now;
      const sec = (now - lv.t0) / 1000;
      $('thinkMeta' + w).textContent = lv.label + ' · ≈' + Math.round(lv.n) + ' tok'
        + (sec >= 1 ? ' · ' + Math.round(lv.n / sec) + ' tok/s' : '');
    }
  }
}
function thinkEnd(w, meta){
  $('think' + w).classList.remove('typing');
  $('thinkMeta' + w).textContent = meta || '';
}
function thinkNote(w, msg){
  const box = $('think' + w);
  box.textContent = (box.textContent ? box.textContent + '\n' : '') + '〔' + msg + '〕\n';
  state.thinkMode[w] = '';
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 一手决策 ---------------- */
function lastActionLine(raw){
  const lines = String(raw || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}
function userText(w, variant){
  // 局面事实（骰子 / 比分 / 本轮喊价 / 合法菜单）交给共享 buildUser；
  // 历史段一律关掉（0=不输出），改由 gameContextText 全量摊开，避免同一件事说两遍。
  let u = C.buildUser(state.G, w, { variant, ownMemoLimit:0, historyLimit:0, rules:activeRules() });
  const ctx = gameContextText(state, w, { budget:state.settings.ctxBudget });
  if (ctx) u += '\n\n' + ctx;
  return u;
}
// 内置机器人：不等接口、不产生 tok，直接本地算一手。
// 走的是和 LLM 完全相同的合法性校验与落子路径，所以对局记录 / 统计口径一致。
function decideBot(w, label){
  const G = state.G, r = G.round, p = state.players[w], inst = state.bots[w];
  thinkStart(w, label);
  thinkNote(w, p.alias + ' · 本地即时计算（不走接口）');
  const t0 = Date.now();
  let act = null, note = '';
  try { act = inst ? inst.decide(G, w) : null; }
  catch (e) { note = '机器人决策异常：' + String(e.message || e).slice(0, 120); }
  const ms = Math.max(0, Date.now() - t0);
  if (!act) note = note || '机器人没有给出动作';
  else {
    const why = R.checkLegal(r, act);
    if (why) { note = '机器人给出的动作不合法（' + why + '），按开盅处理'; act = { type:'open', slash:false }; }
  }
  const txt = act ? actText(act) : '（无动作）';
  thinkPush(w, 'content', txt);
  thinkEnd(w, ms + 'ms · 本地 · 0 tok');
  return { action:act, tries:1, ms, tokens:0, netRetries:0, truncated:0, ambiguous:false,
           note, raw:p.alias + ' 本地决策 → ' + txt, reason:'', invalid:!act, bot:true };
}

async function decide(w, label){
  const G = state.G, r = G.round, p = state.players[w], variant = state.settings.variant;
  if (p.kind === 'bot') return decideBot(w, label);
  const RR = activeRules();
  const sys = C.buildSystem(G.hpMax, { variant, rules:RR });
  let msgs = [{ role:'system', content:sys }, { role:'user', content:userText(w) }];
  let action = null, tries = 0, ms = 0, tokens = 0, netSum = 0, truncated = 0, ambiguous = false, note = '';
  const raws = [], reasons = [];

  thinkStart(w, label);
  while (tries < 3) {
    tries++;
    thinkLiveReset(w, label + ' · 第 ' + tries + ' 次');
    thinkNote(w, '请求模型 ' + p.alias);
    const out = await callWithRetry(p, msgs, (k,t) => thinkPush(w,k,t), w, 'decide', null,
      (i,e,wait) => {
        thinkNote(w, '接口没响应（' + String(e.message).slice(0,60) + '）· ' + (wait/1000) + 's 后第 ' + i + ' 次重试');
        addLog('ow', seatLabel(w) + ' 接口重试（第 ' + i + ' 次）');
      });
    const lv = state.thinkLive[w];
    const sec = lv && lv.t0 ? (Date.now() - lv.t0) / 1000 : out.ms / 1000;
    thinkEnd(w, out.ms + 'ms · ' + (out.tokens || '—') + ' tok'
      + (out.tokens != null && sec > 0 ? ' · ' + Math.round(out.tokens / sec) + ' tok/s' : ''));
    state.stats[w].calls++;
    ms += out.ms; netSum += out.netRetries || 0;
    if (out.tokens != null) tokens += out.tokens;
    if (out.finish === 'length') { state.stats[w].truncated++; truncated++; }
    raws.push(out.raw || '(空)');
    if (out.reason) reasons.push('【第' + tries + '次 · 原生思考】\n' + out.reason);
    const judge = R.extractJudgment(out.raw);
    if (judge && !out.reason) reasons.push('【第' + tries + '次 · 判断】' + judge);

    // 截断且末行不是完整行动行时，绝不把分析中的「N 个 M」误当落子
    const isCut = out.finish === 'length' && !R.ACTION_LINE_RE.test(lastActionLine(out.raw));
    const pa = isCut ? { action:null, ambiguous:false, text:'', dropped:0 } : R.parseAction(out.raw);
    if (pa.ambiguous) { ambiguous = true; state.stats[w].ambiguous++; }
    if (pa.action) {
      const why = R.checkLegal(r, pa.action);
      if (!why) { action = pa.action; break; }
      note = '「' + (pa.text || '') + '」执行不了：' + why;
      msgs = msgs.concat([
        { role:'assistant', content:out.raw },
        { role:'user', content:'上次你写的是「' + String(out.raw).slice(0,80) + '」，这一手执行不了：' + why
            + '。请只回一行行动：' + actionHint(RR, !!r.bid) + '。' },
      ]);
    } else {
      note = isCut ? '输出被截断，未拿到完整行动行' : '没看出要做什么';
      const words = actionHint(RR, !!r.bid);
      const hint = isCut
        ? '你上一段回答被输出长度截断了。接着它原来的思路往下想完，立即做出决断，不要从头重来、不要只写分析。最后另起一行给出行动：' + words + '。'
        : '上次你写的是「' + String(out.raw).slice(0,80) + '」，我没看出你要做什么。请只回一行行动：' + words + '。';
      msgs = msgs.concat([{ role:'assistant', content:out.raw }, { role:'user', content:hint }]);
      if (isCut) thinkNote(w, '输出被截断 · 带着原思考续写一次');
    }
  }
  if (!action) state.stats[w].invalid++;
  // 重写次数：一次决策里为拿到合法动作而额外问了几次（calls - steps 的来源）。
  if (tries > 1) state.stats[w].rewrites += tries - 1;
  return { action, tries, ms, tokens, netRetries:netSum, truncated, ambiguous, note,
           raw:raws.join(' | '), reason:reasons.join('\n\n'), invalid:!action };
}

/* ---------------- 结算 / 复盘 ---------------- */
function settleForfeit(G, loser){
  const win = E.other(loser), r = G.round, R = E.rulesOf(r);
  const stake = R.stake, loserPays = R.openLoserLoses;   // 判负按普通开盅结算，不按劈
  G.losses[loser]++; G.lastLoser = loser;
  r.over = true; r.revealed = true;
  const result = {
    forfeit:true, loser, winner:win, stake, loserPays, slash:false, zhai:!!(r.bid && r.bid.zhai),
    bid:r.bid || { by:loser, count:0, face:0, at:0 }, opener:null,
    actual:0, wild:0, truth:false, dice:r.dice,
  };
  r.result = result;
  G.history.push(Object.assign({ no:r.no }, result));
  E.settle(G, win, loser, stake, loserPays);   // 血量结算：与引擎同一口径
  return result;
}
function showReveal(res, forfeit){
  const el = $('reveal'), b = res.bid || {}, k = res.stake || 1;
  const tag = b.mode === 'toZhai' ? '（转斋）' : b.mode === 'breakZhai' ? '（破斋）' : (res.zhai ? '（斋）' : '');
  const detail = forfeit
    ? seatLabel(res.loser) + ' 三次未给出合法行动'
    : seatLabel(b.by) + ' 喊 ' + b.count + ' 个 ' + b.face + tag + ' · 全场实际 ' + res.actual + ' 个 · ' + (res.truth ? '够' : '不够');
  const payTxt = res.loserPays === false ? ' · 赢家不回血' : ' / ' + seatLabel(res.loser) + ' −' + k;
  el.innerHTML = '<div class="rv-title">' + (forfeit ? '判 负' : res.slash ? '劈 · 开 盅' : '开 盅') + '</div>'
    + '<div class="rv-detail">' + esc(detail) + (res.slash ? ' · 劈：双方 ±' + k : '') + '</div>'
    + '<div class="rv-winner">本轮 <b>' + seatLabel(res.winner) + '</b> +' + k + ' 血' + payTxt + '</div>';
  el.hidden = false;
}
function cleanSum(t){
  let s = String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
  const i = s.indexOf('\n\n');
  if (i > 0) { const a = s.slice(0,i).trim(), b = s.slice(i+2).trim(); if (a && a === b) s = a; }
  // 只做工程护栏：400 字复盘远够用，留三倍余量，避免把超长笔记整段灌回上下文。
  return s.slice(0, 1200);
}

/* ---------------- 局内上下文：全量保留，整局结束即清空 ----------------
 * 用户定义的口径：
 *   ① 当局（本局）内，每一手都能看到「历史轮末复盘」+「当局的所有分析」——全量，不再用
 *      slice(-3)/slice(-10)/按轮窗口悄悄截断；
 *   ② 轮末复盘「继承当前上下文」：包含历史复盘与当局分析，写下的总结带到本局后续回合；
 *   ③ 整局结束即全部清空，不带任何东西到下一局——每局都从空白开始。
 *
 * gameContextText 是决策与轮末复盘的单一真源：两处拼同一段文本，不各写一份。
 * 内容只有模型自己写过的判断/复盘和已亮牌的公开事实，不替它下结论。
 * 做成纯函数（st / w / opts 全靠参数）便于 Node 侧离线验证。
 */
function factLine(h, w){
  const who = x => (x === w ? '你' : '对手');
  const k = h.stake || 1;
  const pay = h.loserPays === false
    ? who(h.loser) + ' −' + k + ' 点血（' + who(h.winner) + ' 不回血）。'
    : who(h.winner) + ' +' + k + ' 点血 / ' + who(h.loser) + ' −' + k + ' 点血。';
  if (h.forfeit) return '  第' + h.no + '轮结算：' + who(h.loser) + '未能给出合法行动，判负 → ' + pay;
  const tag = h.bid.mode === 'toZhai' ? '（转斋）' : h.bid.mode === 'breakZhai' ? '（破斋）' : (h.zhai ? '（斋）' : '');
  const wild = !h.zhai && h.bid.face !== 1 && h.wild ? '（含万能1 ' + h.wild + ' 颗）' : '';
  return '  第' + h.no + '轮结算：' + who(h.bid.by) + '喊 ' + h.bid.count + '个' + h.bid.face + tag
    + '，' + who(h.opener) + (h.slash ? '劈（双方 ±' + k + '）' : '开盅')
    + '，全场实际 ' + h.actual + ' 个' + wild + '（' + (h.truth ? '够' : '不够') + '）→ ' + pay
    + (h.dice ? ' 亮牌：你 [' + h.dice[w].join(' ') + ']，对手 [' + h.dice[w === 'A' ? 'B' : 'A'].join(' ') + ']。' : '');
}
function gameContextText(st, w, opts){
  const o = opts || {}, G = st.G || {}, L = [];
  const budget = o.budget == null ? 24000 : o.budget;
  const memos = st.memos && st.memos[w] ? st.memos[w] : [];
  const own = st.ownMemo && st.ownMemo[w] ? st.ownMemo[w] : [];
  const hist = G.history || [];
  // 轮末复盘时 skipFactRound = 当前轮：本轮结算由 buildSummaryPrompt 单独给出，避免重复。
  const facts = hist.filter(h => o.skipFactRound == null || h.no !== o.skipFactRound);
  const rounds = [];
  const seen = {};
  for (const h of hist) seen[h.no] = true;
  for (const m of memos) seen[m.round] = true;
  for (const a of own) seen[a.round] = true;
  for (const no of Object.keys(seen).map(Number).sort((x, y) => x - y)) rounds.push(no);

  const full = [];
  for (const no of rounds) {
    const b = ['  第' + no + '轮：'];
    const acts = own.filter(x => x.round === no);
    if (acts.length) {
      b.push('    你这一轮每一手的判断与落子：');
      for (const x of acts) b.push('      判断：' + (x.judgment || '（无）') + ' → ' + x.action);
    }
    const f = facts.find(h => h.no === no);
    if (f) b.push('    亮牌后的事实：\n      ' + factLine(f, w).trim());
    const memo = memos.find(x => x.round === no);
    if (memo) b.push('    你写下的轮末复盘：' + memo.text);
    full.push({ no, full:b.join('\n'),
      slim:b.filter(s => !s.startsWith('      判断：') && !s.startsWith('    你这一轮每一手的判断与落子：')).join('\n') });
  }
  const head = ['【本局完整记录（从第一手起，按轮展开：你每一手的判断与落子 / 亮牌后的事实 / 你写下的复盘）】'];
  const cap = Math.max(0, budget - L.join('\n').length - head.join('\n').length);
  let sum = 0, folded = 0;
  const chosen = [];
  // 从最近轮往前保留完整块；只有超出预算时，更早的轮才降级为「复盘 + 事实」的精简块。
  for (let i = full.length - 1; i >= 0; i--) {
    const blk = full[i];
    if (sum + blk.full.length <= cap) { chosen.unshift(blk.full); sum += blk.full.length; }
    else { chosen.unshift(blk.slim); sum += blk.slim.length; folded++; }
  }
  if (folded) head.push('  （上下文达到预设上限，最早 ' + folded + ' 轮的「逐手判断」已折叠；各轮复盘与亮牌事实完整保留。）');
  if (rounds.length) L.push(head.concat(chosen).join('\n'));
  return L.join('\n\n');
}
// 向后兼容的旧入口：轮末复盘的回看段仍叫 recallText，但现在是全量上下文。
function recallText(st, w, opts){
  return gameContextText(st, w, Object.assign({ skipFactRound: st.G ? st.G.roundNo : null }, opts || {}));
}

// 复盘请求的消息体。中性 system 是刻意的：不带 FORMAT_PROBE，避免模型把复盘写成「行动：」行。
// ctx 允许 Node 侧注入 context.js 做离线验证（浏览器里用闭包中的共享模块）。
function summaryMessages(st, w, res, variant, ctx, opts){
  const CX = ctx || C;
  const recall = recallText(st, w, opts);
  const user = (recall ? recall + '\n\n' : '') + CX.buildSummaryPrompt(st.G, w, res, { variant, rules:st.G && st.G.rules });
  return [{ role:'system', content:'你正在复盘一轮大话骰对局。' }, { role:'user', content:user }];
}

// 复盘输出统一走这里：两次机会，无效输出把原文回灌再改；吃模型完整预算，不设小预算硬截断。
async function requestSummary(w, msgs, tag){
  const p = state.players[w];
  let text = '';
  for (let i = 0; i < 2 && !text; i++) {
    try {
      const out = await callWithRetry(Object.assign({}, p, { thinking:false, effort:'off' }),
        msgs, null, w, tag, p.maxTokens, null, 2);
      text = cleanSum(out.raw) || cleanSum(out.reason);
      if (!text) msgs = msgs.concat([
        { role:'assistant', content: out.raw || out.reason || '（空）' },
        { role:'user', content:'请只写一段你自己的复盘总结，别复述提示。' },
      ]);
    } catch (e) { /* 复盘失败不打断对局 */ }
  }
  return text;
}
// 双方复盘互不依赖：并发发出，等两份都回来再一起写回上下文，避免任何一方读到对方这轮的复盘。
async function summarizeRound(res){
  const roundNo = state.G.roundNo;
  const jobs = ['A','B'].map(async w => {
    if (state.players[w] && state.players[w].kind === 'bot') return { w, text:'（内置机器人不做复盘。）' };
    const msgs = summaryMessages(state, w, res, state.settings.variant, null, { budget:state.settings.ctxBudget });
    const text = await requestSummary(w, msgs, 'summary') || '（本轮未形成复盘。）';
    return { w, text };
  });
  const out = await Promise.all(jobs);
  for (const x of out) {
    state.memos[x.w].push({ round:roundNo, text:x.text });
    addMemo(x.w, roundNo, x.text);
  }
}
async function afterOpen(res, forfeit){
  const G = state.G, b = res.bid, k = res.stake || 1;
  const delta = ' +' + k + ' 血' + (res.loserPays === false ? '（对方不回血）' : ' / ' + seatLabel(res.loser) + ' −' + k + ' 血');
  const pointStr = '（血量 ' + G.hp.A + ' : ' + G.hp.B + '）';
  const zt = b.mode === 'toZhai' ? '（转斋）' : b.mode === 'breakZhai' ? '（破斋）' : (res.zhai ? '（斋）' : '');
  if (forfeit) {
    addLog('rs', '判负结算 → ' + seatLabel(res.winner) + delta + pointStr);
  } else {
    const act = res.slash ? '劈' : '开盅';
    addLog('ow', seatLabel(res.opener) + ' ' + act + (res.slash ? '（双方 ±' + k + '）' : '')
      + '，质疑 ' + seatLabel(b.by) + ' 的 ' + b.count + ' 个 ' + b.face + zt);
    let d = '全场 ' + b.face + ' 实际有 <b>' + res.actual + '</b> 个';
    if (!res.zhai && b.face !== 1 && res.wild) d += '（含万能 1 共 ' + res.wild + ' 颗）';
    d += '，' + (res.truth ? '够 ' : '不足 ') + b.count + ' 个';
    addLog('rs', act + '结果：' + d + ' → ' + seatLabel(res.winner) + delta + pointStr);
  }
  if (!forfeit) {
    // 开盅次数 / 开盅正确 / 劈 都归属「开盅的那一方」——这是该模型自己的决策质量。
    const os = state.stats[res.opener];
    os.opens++;
    if (res.winner === res.opener) os.opensCorrect++;
    if (res.slash) os.slashes++;
  }
  showReveal(res, forfeit); render(); renderStats();
  await sleep(Math.max(500, Math.min(1600, state.settings.speed || 400)));
  $('reveal').hidden = true;
  // 每一轮（含最后一轮）都做轮末复盘，口径一致；复盘只留在本局上下文与复盘面板，不带入下一局。
  if (state.settings.summary && ['A','B'].some(x => state.players[x].kind !== 'bot')) {
    addLog('muted', '第 ' + G.roundNo + ' 轮结束，复盘总结中…');
    flash('轮末复盘中…');
    await summarizeRound(res);
    flash('准备就绪');
  }
  if (G.over) { addLog('rd', '对局结束：' + seatLabel(G.winner) + ' 胜出'); await finishMatch(); return; }
  render();
}
async function finishMatch(){
  state.running = false;
  const w = state.G.winner, score = state.G.hp.A + ' : ' + state.G.hp.B;
  setState('对局结束', (w ? seatLabel(w) + ' 获胜' : '平局') + ' · ' + score, 'done');
  flash('对局结束 · ' + (w ? seatLabel(w) + ' 获胜' : '平局'));
  syncButtons(); render();
  await recordMatch();
}

/* ---------------- 对局落盘 / 模型排名 ---------------- */
function snapSeat(p){
  return { id:p.id, alias:p.alias, model:p.model, base:p.base,
           effort:normalizeEffort(p.effort), maxTokens:p.maxTokens };
}
function pickStats(s){
  const o = {};
  for (const k of ['steps','calls','opens','opensCorrect','slashes','forfeits','tokens','ms','memos',
                   'invalid','ambiguous','truncated','rewrites','netRetries']) o[k] = s[k] || 0;
  return o;
}
async function recordMatch(){
  const G = state.G;
  if (!G || !state.players) return;
  const rec = {
    t:Date.now(), run_id:state.runId, gameNo:state.gameNo, source:'arena',
    seats:{ A:snapSeat(state.players.A), B:snapSeat(state.players.B) },
    ruleset_hash:RS.hash(G.rules),
    prompt_hash:RK.hashTexts(C.promptTexts(G.rules, state.settings.variant)),
    variant:state.settings.variant, rules:{ id:G.rules.id, name:G.rules.name },
    hpMax:G.hpMax, rounds:G.roundNo,
    hp:{ A:G.hp.A, B:G.hp.B },
    winner:G.winner || null, draw:!G.winner, capped:!!G.capped,
    stats:{ A:pickStats(state.stats.A), B:pickStats(state.stats.B) },
  };
  try {
    const res = await fetch('/api/matches', { method:'POST',
      headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(rec) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    addLog('muted', '对局已记入排名账本 · #' + rec.prompt_hash.slice(0,8) + ' 组');
    if ($('panelRank').classList.contains('active')) renderRank();
  } catch (e) {
    addLog('ow', '对局记录写入失败（不影响本页结果）：' + esc(String(e.message || e)));
  }
}
function rankTime(t){
  const d = new Date(t), p = n => String(n).padStart(2,'0');
  return p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
async function renderRank(){
  const el = $('panelRank');
  el.innerHTML = '<div class="rank-empty">读取对局账本…</div>';
  let matches;
  try {
    const res = await fetch('/api/matches');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    matches = (await res.json()).matches || [];
  } catch (e) {
    el.innerHTML = '<div class="rank-empty">读取对局账本失败：' + esc(String(e.message || e)) + '</div>';
    return;
  }
  const groups = RK.listGroups(matches);
  if (!groups.length) {
    el.innerHTML = '<div class="rank-empty">还没有已结算的对局。打完一整局（先到目标分或达到轮数上限）会自动记入账本。</div>';
    return;
  }
  if (!groups.some(g => g.key === state.rankGroup)) state.rankGroup = groups[0].key;
  const group = groups.find(g => g.key === state.rankGroup);
  const inGroup = matches.filter(m => RK.groupKey(m) === state.rankGroup);
  const filtered = RK.filterEffort(inGroup, state.rankEffort);
  const rows = RK.elo(filtered);
  const gOpts = groups.map(g => '<option value="' + esc(g.key) + '"' + (g.key === state.rankGroup ? ' selected' : '') + '>'
    + esc(g.rulesName || g.ruleset_hash) + ' · ' + esc(g.variant) + ' · #' + esc(g.prompt_hash.slice(0,8))
    + '（' + g.n + ' 场）</option>').join('');
  const eOpts = ['all'].concat(EFFORTS).map(e => '<option value="' + e + '"' + (e === state.rankEffort ? ' selected' : '') + '>'
    + (e === 'all' ? '全部强度' : effortLabel(e)) + '</option>').join('');
  let board;
  if (!rows.length) {
    board = '<div class="rank-empty">该组在所选强度下没有对局（强度子榜只收双方同档的局）。</div>';
  } else {
    board = '<div class="rank-head">'
      + '<div class="rk-no">#</div><div class="rk-name">模型</div><div class="rk-rating">分数</div>'
      + '<div class="rk-wld">胜-负-平</div><div class="rk-wr">胜率</div><div class="rk-oa">开盅正确</div><div class="rk-g">场次</div>'
      + '</div><div class="rank-rows">'
      + rows.map((r, i) =>
          '<div class="rank-row' + (i === 0 ? ' top' : '') + '">'
        +   '<div class="rk-no">' + (i+1) + '</div>'
        +   '<div class="rk-name"><b title="' + esc(r.model + ' @ ' + r.base) + '">' + esc(r.alias) + '</b>'
        +     (r.provisional ? '<span class="prov">定级中</span>' : '') + '</div>'
        +   '<div class="rk-rating">' + r.rating + '</div>'
        +   '<div class="rk-wld">' + r.wins + '-' + r.losses + '-' + r.draws + '</div>'
        +   '<div class="rk-wr">' + Math.round(r.winRate*100) + '%</div>'
        +   '<div class="rk-oa">' + (r.openAcc === null ? '—' : r.opensCorrect + '/' + r.opens) + '</div>'
        +   '<div class="rk-g">' + r.games + '</div>'
        + '</div>').join('')
      + '</div>';
  }
  const hist = filtered.slice().sort((a,b) => (b.t||0) - (a.t||0)).slice(0,100);
  const histHtml = hist.length
    ? '<div class="hist-cap">历史对局 · 本组 ' + inGroup.length + ' 场'
      + (state.rankEffort !== 'all' ? '，该强度 ' + filtered.length + ' 场' : '') + '（最新在前）</div>'
      + hist.map(m => {
          const a = m.seats.A, b = m.seats.B;
          const wn = m.winner ? (m.winner === 'A' ? a.alias : b.alias) : null;
          return '<div class="hist-row">'
            + '<span class="h-t">' + rankTime(m.t) + '</span>'
            + '<span class="h-vs"><b class="' + (m.winner === 'A' ? 'h-win' : '') + '">' + esc(a.alias || a.model) + '</b>'
            +   ' <i>vs</i> <b class="' + (m.winner === 'B' ? 'h-win' : '') + '">' + esc(b.alias || b.model) + '</b></span>'
            + '<span class="h-score">' + ((m.hp || m.points || {}).A ?? '—') + ' : ' + ((m.hp || m.points || {}).B ?? '—') + '</span>'
            + '<span class="h-res">' + (wn ? esc(wn) + ' 胜' : '平局') + (m.capped ? ' · 封顶' : '') + '</span>'
            + '<span class="h-meta">' + m.rounds + ' 轮 · ' + effortLabel(a.effort) + '/' + effortLabel(b.effort) + '</span>'
            + '</div>';
        }).join('')
    : '';
  el.innerHTML =
      '<div class="rank-bar">'
    +   '<label>指纹组 <select id="rankGroup">' + gOpts + '</select></label>'
    +   '<label>思考强度 <select id="rankEffort">' + eOpts + '</select></label>'
    +   '<span class="rank-note">Elo · 初始 ' + RK.INITIAL + ' · K=' + RK.K + ' · 赢弱手少涨、输弱手重扣 · 跨指纹不混排</span>'
    + '</div>'
    + board
    + '<div class="rank-foot">组指纹：规则 #' + esc(group.ruleset_hash) + ' × 提示词 #' + esc(group.prompt_hash)
    + ' · 同端点+同模型视为同一选手 · 少于 ' + RK.PROVISIONAL_GAMES + ' 场标「定级中」</div>'
    + histHtml;
  $('rankGroup').onchange = e => { state.rankGroup = e.target.value; renderRank(); };
  $('rankEffort').onchange = e => { state.rankEffort = e.target.value; renderRank(); };
}

/* ---------------- 一步 / 连播 ---------------- */
async function stepOnce(){
  const G = state.G;
  if (!G || G.over) return;
  if (!G.round || G.round.over) {
    // 封顶硬上限：血量制下对局本来就会自然结束（归零），这里防病态长局
    if (G.roundNo >= (state.settings.maxRounds || 60)) {
      const win = G.hp.A === G.hp.B ? null : (G.hp.A > G.hp.B ? 'A' : 'B');
      G.over = true; G.winner = win; G.capped = true;
      addLog('rd', '达到最多 ' + (state.settings.maxRounds || 60) + ' 轮，按剩余血量判定：'
        + (win ? seatLabel(win) + ' 胜出' : '平局') + '（' + G.hp.A + ' : ' + G.hp.B + '）');
      await finishMatch(); return;
    }
    E.startRound(G);
    const r = G.round;
    addLog('rd', '第 ' + r.no + ' 轮 · ' + seatLabel(r.turn) + ' 先喊');
    addLog('muted', '摇骰完成' + (state.god ? ' · 甲 [' + r.dice.A.join(' ') + '] ｜ 乙 [' + r.dice.B.join(' ') + ']' : ''));
    renderDice('A', true); renderDice('B', true);
    render(); return;
  }
  const r = G.round, w = r.turn, RR = activeRules();
  render();
  // 经典套无价可喊时沿用「自动开盅」，避免模型被判负；新套多了「劈」，必须留给模型自己选。
  if (!E.canBid(r) && !RR.slash) {
    addLog('muted', seatLabel(w) + ' 已无价可喊，只能开盅');
    await afterOpen(E.resolveOpen(G, w, { slash:false })); return;
  }
  const label = r.bid ? '行动' : '首喊';
  const res = await decide(w, label);
  // 漏写「斋 / 破斋」时按当前规则集自动推断：决策明细与真实落子必须是同一个动作。
  const acted = (res.action && res.action.type === 'bid') ? E.normalizeAction(r, res.action) : res.action;
  const shown = Object.assign({}, res, { action:acted });
  state.stats[w].steps++; state.stats[w].ms += res.ms; state.stats[w].tokens += res.tokens;
  state.stats[w].netRetries += res.netRetries;
  addDec(w, shown, label); renderStats();
  // 当局的所有分析整局保留，不再按轮裁掉旧手；展示层由 gameContextText 的 ctxBudget 折叠，
  // 且折叠发生在最早那几轮、会明确标注，不会静默丢掉本局过程。
  state.ownMemo[w].push({ round:G.roundNo, judgment:R.extractJudgment(res.raw).slice(0,400), action:actText(acted) });
  if (acted && acted.type === 'open') {
    await afterOpen(E.resolveOpen(G, w, { slash:!!acted.slash })); return;
  }
  if (acted) {
    E.applyBid(G.round, w, acted);          // 完整动作对象：mode / slash 不再丢失
    state.lastAct[w] = actText(acted);
    if (acted.mode === 'toZhai') state.stats[w].toZhai++;
    else if (acted.mode === 'breakZhai') state.stats[w].breakZhai++;
    addLog('', seatLabel(w) + ' <b>' + esc(actText(acted)) + '</b>');
    addLog('muted', res.ms + ' ms · ' + (res.tokens || '—') + ' tok'
      + (res.tries > 1 ? ' · 重写 ' + (res.tries - 1) + ' 次' : '')
      + (res.truncated ? ' · 有截断' : '') + (res.ambiguous ? ' · 解析歧义' : ''));
    bump($('lastAct' + w)); render(); return;
  }
  if (state.settings.strict) {
    addLog('ow', '⚠ ' + seatLabel(w) + ' 三次都没给出可执行的动作，判负（与无头评测口径一致）');
    state.stats[w].forfeits++;
    await afterOpen(settleForfeit(G, w), true); return;
  }
  // 兜底也走权威合法动作集合，别把转斋 / 破斋动作在 legalCounts×legalFaces 的旧视图里弄丢。
  const bids = E.legalActions(r).filter(a => a.type === 'bid');
  if (!bids.length) {
    addLog('muted', seatLabel(w) + ' 无价可喊，只能开盅');
    await afterOpen(E.resolveOpen(G, w, { slash:false })); return;
  }
  bids.sort((x,y) => x.count - y.count || E.ord(x.face) - E.ord(y.face));
  addLog('ow', '⚠ ' + seatLabel(w) + ' 三次没给出动作，按最小合法加价接手：' + actText(bids[0]));
  E.applyBid(G.round, w, bids[0]);
  state.lastAct[w] = actText(bids[0]);
  render();
}
async function runStep(){
  if (state.busy || !state.G || state.G.over) return false;
  state.busy = true;
  const w = (state.G.round && !state.G.round.over) ? state.G.round.turn : (state.G.firstBidder || 'A');
  setState('对局进行中', '第 ' + state.G.roundNo + ' 轮 · ' + seatLabel(w) + ' 思考中', 'live');
  let ok = true;
  try { await stepOnce(); }
  catch (e) {
    ok = false; state.running = false;
    addLog('ow', '⚠ ' + esc(String(e.message).slice(0,160)) + ' · 局面不变，点「继续」接着打');
    flash('已暂停 · ' + String(e.message).slice(0,60));
  }
  finally {
    state.busy = false;
    // 「重新布阵」在模型思考中途被点击：等这一手彻底落地后再清空，避免异步写 null 局面
    if (state.pendingReset) { doReset(); return; }
    render();
  }
  return ok;
}
async function loop(){
  if (state.running) return;
  state.running = true; syncButtons();
  while (state.running) {
    if (!state.G || state.G.over) break;
    if (!await runStep()) break;
    if (!state.running) break;
    const d = state.settings.speed;
    if (d) await sleep(d);
  }
  state.running = false; syncButtons();
}
function syncButtons(){
  const over = !!(state.G && state.G.over);
  $('btnPause').textContent = state.running ? '暂停' : '继续';
  $('btnPause').disabled = !state.started || over;
  $('btnStep').disabled = !state.started || state.running || over;
  $('btnStart').disabled = state.started && !over;
}

/* ---------------- 开战 / 重新布阵 ---------------- */
async function startMatch(){
  const A = playerById(state.seat.A), B = playerById(state.seat.B);
  const okSeat = p => !!p && (p.kind === 'bot' || (!!p.base && !!p.model));
  if (!okSeat(A) || !okSeat(B)) {
    flash('请先配置并选择双方模型或机器人');
    $('saveHint').textContent = '左右双方都要选定模型（完整的 Base URL 与模型 ID）或内置机器人';
    openDrawer(); return;
  }
  // 预设是共享配置：开战时拍快照，本局的席位思考强度覆盖只作用于快照，不改存档。
  state.players = { A: Object.assign({}, A), B: Object.assign({}, B) };
  // 机器人实例按局新建：random/reader 的随机数状态跟着这一局，不跨局漂移。
  state.bots = { A:null, B:null };
  for (const w of ['A','B']) {
    const p = state.players[w];
    if (p.kind === 'bot') { state.bots[w] = BOT.makeBot(p.bot, E.mulberry32((Date.now() + (w === 'A' ? 1 : 2)) >>> 0)); continue; }
    const se = state.settings.seatEffort && state.settings.seatEffort[w];
    if (se && se !== 'auto') p.effort = normalizeEffort(se);
  }
  state.settings.target = +$('qTarget').value;
  state.settings.speed = +$('qSpeed').value;
  if ($('qRules')) state.settings.rules = $('qRules').value;
  state.god = !!state.settings.god;
  // 开战时把规则集锁进局面：之后在设置里换套，本局的合法性 / 提示词 / 结算口径都不变。
  state.G = E.newMatch({ hpMax:state.settings.target,
    firstBidder:Math.random() < .5 ? 'A' : 'B', rules:selectedRules() });
  state.runId = 'arena-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6);
  state.gameNo++;
  state.memos = { A:[], B:[] }; state.ownMemo = { A:[], B:[] };
  state.lastAct = { A:'—', B:'—' }; state.stats = { A:newStats(), B:newStats() };
  state.started = true; state.running = false; state.busy = false;
  clearConsole();
  addLog('rd', '开桌 · 第 ' + state.gameNo + ' 局：' + esc(A.alias) + '（甲方） vs ' + esc(B.alias) + '（乙方）');
  addLog('muted', '局内上下文：本局所有轮末复盘 + 所有逐手判断 + 所有亮牌事实全量可见（预算 ' + (state.settings.ctxBudget || 24000) + ' 字）；整局结束即清空，不带入下一局');
  const RR = state.G.rules;
  addLog('muted', '规则套：' + esc(RR.name) + '（#' + RS.hash(RR) + '）· ' + esc(RS.describe(RR)));
  addLog('muted', '初始血量 ' + state.settings.target + ' 点（先归零者输）· 提示词臂 ' + C.armOf(state.settings.variant).label
    + (A.kind === 'bot' || B.kind === 'bot'
        ? ' · ' + [A, B].filter(x => x.kind === 'bot').map(x => x.alias).join(' / ') + ' 本地计算，不走接口'
        : ' · 预算 ' + A.maxTokens + ' / ' + B.maxTokens + ' tok')
    + (A.kind === 'bot' && B.kind === 'bot' ? ''
        : ' · 思考强度 ' + (A.kind === 'bot' ? '（本地）' : effortLabel(state.players.A.effort))
          + ' / ' + (B.kind === 'bot' ? '（本地）' : effortLabel(state.players.B.effort)))
    + (state.settings.summary ? ' · 双方复盘并行' : '') + ' · 最多 ' + (state.settings.maxRounds || 60) + ' 轮');
  $('setupBar').classList.add('locked');
  $('btnGod').classList.toggle('on', state.god);
  $('reveal').hidden = true;
  syncQuick(); syncButtons(); render(); renderStats();
  await loop();
}
function resetTable(){
  if (state.busy) {
    state.pendingReset = true; state.running = false;
    flash('当前一手结束后自动重新布阵…'); syncButtons(); return;
  }
  doReset();
}
function doReset(){
  state.pendingReset = false;
  state.running = false; state.started = false; state.G = null; state.players = null; state.busy = false;
  // 逐手 / 逐轮的局内上下文随牌桌一起清掉；下一局从空白开始。
  state.memos = { A:[], B:[] }; state.ownMemo = { A:[], B:[] };
  state.lastAct = { A:'—', B:'—' }; state.stats = { A:newStats(), B:newStats() };
  clearConsole();
  $('setupBar').classList.remove('locked');
  setState('待布阵', '选择双方模型后开战', '');
  for (const w of ['A','B']) {
    $('think' + w).innerHTML = '<span class="hint">开战后，模型的思考会在这里逐字流出</span>';
    $('think' + w).classList.remove('typing');
    $('thinkMeta' + w).textContent = '';
  }
  $('reveal').hidden = true;
  $('btnGod').classList.toggle('on', !!state.god);
  flash('准备就绪'); syncButtons(); render();
}

/* ---------------- 事件绑定 ---------------- */
function bindAll(){
  $('btnSettings').onclick = openDrawer;
  $('btnCloseDrawer').onclick = closeDrawer;
  $('btnCloseBottom').onclick = closeDrawer;
  $('mask').onclick = closeDrawer;
  $('btnNew').onclick = () => openEditor(null);
  $('btnCancelEdit').onclick = closeEditor;
  $('btnSavePreset').onclick = savePreset;
  $('btnPull').onclick = () => pullModels(true);
  $('btnTest').onclick = testConn;
  $('btnExport').onclick = exportPresets;
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importPresets(f); e.target.value = ''; };
  $('btnRestore').onclick = restoreBuiltin;
  $('btnSync').onclick = resyncServer;
  $('btnTheme').onclick = toggleTheme;
  if ($('btnNewRule')) $('btnNewRule').onclick = () => openRuleEditor(null, selectedRules());
  if ($('btnCancelRule')) $('btnCancelRule').onclick = closeRuleEditor;
  if ($('btnSaveRule')) $('btnSaveRule').onclick = saveRule;
  // 规则编辑表单任一参数变化，实时刷新「模型将看到的规则文本」预览。
  if ($('ruleEditorSec')) $('ruleEditorSec').onchange = () => {
    if ($('rulePreview')) $('rulePreview').textContent = C.rulesTextFor(readRuleForm());
  };
  $('sTheme').onchange = e => {
    state.settings.theme = e.target.value === 'light' ? 'light' : 'dark';
    applyTheme(); saveStore();
  };
  $('sDefaultMaxTokens').onchange = e => {
    const v = Math.min(32768, Math.max(256, +e.target.value || DEFAULT_MAX_TOKENS));
    state.settings.defaultMaxTokens = v; e.target.value = String(v); saveStore();
    $('saveHint').textContent = '新建模型默认预算已设为 ' + v + ' tok（已有模型不受影响）';
  };
  if ($('sDefaultEffort')) $('sDefaultEffort').onchange = e => {
    const v = normalizeEffort(e.target.value);
    state.settings.defaultEffort = v; e.target.value = v; saveStore();
    $('saveHint').textContent = '新建模型默认思考强度已设为「' + effortLabel(v) + '」（已有模型不受影响）';
  };

  for (const [id, key] of [['sCoach','coach'],['sSummary','summary'],['sGod','god'],['sStrict','strict']]) {
    $(id).onchange = e => {
      state.settings[key] = e.target.checked;
      if (key === 'god') { state.god = e.target.checked; render(); }
      saveStore();
    };
  }
  $('sMaxRounds').onchange = e => {
    state.settings.maxRounds = Math.min(500, Math.max(3, +e.target.value || 60));
    e.target.value = String(state.settings.maxRounds); saveStore();
  };
  $('sCtxBudget').onchange = e => {
    state.settings.ctxBudget = Math.min(200000, Math.max(2000, +e.target.value || DEFAULT_SETTINGS.ctxBudget));
    e.target.value = String(state.settings.ctxBudget); saveStore();
  };
  for (const [id, key] of [['qTarget','target'],['qSpeed','speed']]) {
    $(id).onchange = e => {
      state.settings[key] = +e.target.value;
      syncQuick(); saveStore();
    };
  }
  if ($('qVariant')) $('qVariant').onchange = e => { state.settings.variant = e.target.value; syncQuick(); saveStore(); };
  for (const id of ['qRules','sRules']) {
    if ($(id)) $(id).onchange = e => setActiveRules(e.target.value);
  }
  for (const w of ['A','B']) {
    $('pick' + w).onchange = e => { state.seat[w] = e.target.value; renderPicks(); saveStore(); };
    const esel = $('effPick' + w);
    if (esel) esel.onchange = e => { state.settings.seatEffort[w] = e.target.value; renderPicks(); saveStore(); };
  }
  $('btnStart').onclick = startMatch;
  $('btnReset').onclick = resetTable;
  $('btnStep').onclick = async () => { if (state.started && !state.running && !state.busy) { await runStep(); syncButtons(); } };
  $('btnPause').onclick = () => {
    if (!state.started || (state.G && state.G.over)) return;
    if (state.running) { state.running = false; flash('已暂停'); syncButtons(); }
    else loop();
  };
  $('btnGod').onclick = () => {
    state.god = !state.god; state.settings.god = state.god;
    $('btnGod').classList.toggle('on', state.god);
    $('sGod').checked = state.god; render(); saveStore();
  };
  for (const k of ['flow','dec','memo','stats','rank']) {
    $('tab' + k[0].toUpperCase() + k.slice(1)).onclick = () => switchTab(k);
  }
}

async function init(){
  if (!E || !R || !C || !RS) {
    flash('共享模块加载失败：请通过 serve-dice.py 打开本页');
    return;
  }
  await loadStore();
  syncQuick(); bindSettingsValues(); bindAll();
  renderPresets(); renderPicks(); renderStorage();
  state.god = !!state.settings.god;
  resetTable();
}

// 纯逻辑导出，便于 Node 侧离线验证；浏览器里由 init 启动。
const ArenaCore = { normalizePreset, normalizeSettings, normalizeEffort, actText, actionHint,
  hostOf, seatLabel, newStats, selectedRules, activeRules, allRules, renderRules, readRuleForm,
  gameContextText, recallText, summaryMessages, factLine,
  BUILTIN, DEFAULT_SETTINGS, EFFORTS,
  // 机器人席位（'bot:<spec>'）解析 + 对局驱动，供 Node 侧测试直接调用
  BOT_PREFIX, isBotId, botSeat, playerById, decideBot,
  state, startMatch, doReset, init };
if (typeof module !== 'undefined' && module.exports) module.exports = ArenaCore;
else root.ArenaCore = ArenaCore;

if (doc) init();
})(typeof self !== 'undefined' ? self : globalThis);
