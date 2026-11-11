#!/usr/bin/env node
/* 实时对战平台服务（零依赖：只用 Node 标准库）
 * 静态：只放行 web/play.* 三件；presets.json / runs / data 一律不外泄（Key 与实验流水都在里面）。
 * 传输：SSE 推事件 + POST 提交行动（回合制，延迟不敏感；要 WebSocket 再换，事件与行动协议不变）。
 * 权威：对局只在服务端跑（src/runner.js + dice-engine），客户端只拿到自己那份视角。
 *
 * 用法：
 *   node src/room-server.js                 默认 127.0.0.1:8898（本机开发，朋友进不来）
 *   HOST=0.0.0.0 node src/room-server.js    云服务器上给 nginx 反代用（不要裸奔公网）
 * 环境变量：
 *   PORT  端口（默认 8898）              HOST  监听地址（默认 127.0.0.1）
 *   DICE_ALLOW_HOSTS=a.com,b.com  模型端点域名白名单（公网部署强烈建议开）
 *   DICE_LOCAL_PORTS=14001,14002  允许戳云服务器本机的端口（自己经代理转过来的模型）
 *   DICE_HTTPS_ONLY=1             模型端点必须 https
 *   DICE_TOKEN_BUDGET=2000000     每桌默认 token 预算（0 = 不限）
 *   DICE_DATA_DIR=./data          账号 / 主密钥 / 战绩落盘目录
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const ROOT = path.dirname(__dirname);
const C = require('./context.js');
const RS = require('./dice-rulesets.js');
const E = require('./dice-engine.js');
const V = require('./view.js');
const GW = require('./model-gw.js');
const { Vault, maskKey } = require('./secrets.js');
const { Accounts } = require('./accounts.js');
const { Registry } = require('./rooms.js');
const { BOTS } = require('./bots.js');

const PORT = +(process.env.PORT || 8898);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DICE_DATA_DIR || path.join(ROOT, 'data');
const PRESETS_FILE = path.join(ROOT, 'presets.json');
const MAX_BODY = 256 * 1024;
const STATIC_OK = new Set(['/web/play.html', '/web/play.js', '/web/play.css']);
const POLICY = {
  allowHosts: (process.env.DICE_ALLOW_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),
  localPorts: (process.env.DICE_LOCAL_PORTS || '').split(',').map(s => +s.trim()).filter(Number.isInteger),
  requireHttps: process.env.DICE_HTTPS_ONLY === '1',
};
const DEFAULT_BUDGET = Math.max(0, +(process.env.DICE_TOKEN_BUDGET || 0));

fs.mkdirSync(DATA, { recursive: true });
const vault = new Vault(DATA);
const accounts = new Accounts(DATA, vault);
const registry = new Registry({
  vault, accounts, policy: POLICY,
  presets: () => readPresets(),
  recordFile: path.join(DATA, 'matches-live.jsonl'),
  callFile: path.join(DATA, 'calls-live.jsonl'),
});

/* ---------------- presets（平台供模型；Key 只留在服务端）---------------- */
function readPresets() {
  try {
    const d = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    const list = (d.presets || []).map(p => ({ id: p.id, alias: p.alias, base: p.base, model: p.model, apiKey: p.apiKey || null }));
    const ruleSets = ((d.settings || {}).ruleSets || []);
    return { list, ruleSets };
  } catch (e) { return { list: [], ruleSets: [] }; }
}
function presetPublic() {
  // 只给「选桌要用的信息」：id / 别名 / 模型名 / 有没有 Key。
  // 本机与内网端点的主机名不公布（朋友不需要知道你家里跑着什么，也不该给探测面）。
  return readPresets().list.map(p => {
    const h = hostOf(p.base);
    const priv = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h);
    return { id: p.id, alias: p.alias, model: p.model, host: priv ? '（服务器本机端点）' : h, hasKey: !!p.apiKey, local: priv };
  });
}
// 座位里的模型引用落成可用的端点：preset（平台预设，Key 在服务器）/ configId（账号里的配置，Key 在密文盒）
// / 直接填 baseUrl(+Key)。统一转成 kind:'llm' + baseUrl + secretToken 交给房间层，Key 从不进房间对象。
// WorkBuddy 网关（默认 127.0.0.1:8791）的 key 不写进 presets.json，服务端注入 —— 与 serve-dice.py 同一口径。
// 优先环境变量 DICE_WB_KEY；否则读本机 workbuddy 设置（只在本机开发有意义，公开部署请走环境变量）。
let _wbKey;
function wbKey() {
  if (_wbKey !== undefined) return _wbKey;
  _wbKey = process.env.DICE_WB_KEY || null;
  if (!_wbKey) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'work/wb-api/hub/accounts/settings.json'), 'utf8'));
      for (const x of (d.api_keys || [])) {
        if (x && x.key && !x.deleted_at && x.enabled !== false) { _wbKey = x.key; break; }
      }
    } catch (e) { _wbKey = null; }
  }
  return _wbKey;
}
function isWbHub(base) { return /(127\.0\.0\.1|localhost):8791\b/i.test(String(base || '')); }

async function resolveSeat(seat, me, ip) {
  if (!seat || (seat.kind !== 'llm' && seat.kind !== 'preset')) return { ok: true, seat };
  let base = seat.baseUrl, model = seat.model, key = null, alias = seat.alias || seat.model;
  let effort = seat.effort, thinking = null, maxTokens = seat.maxTokens, temperature = seat.temperature;
  if (seat.kind === 'preset') {
    if (!rateOk('preset:' + ip, RATE.preset[0], RATE.preset[1])) return { ok: false, error: '平台预设模型一小时内用得差不多了，改用自己的端点或内置人机' };
    const p = readPresets().list.find(x => x.id === seat.presetId);
    if (!p) return { ok: false, error: '没有这个平台预设：' + seat.presetId };
    base = p.base; model = p.model; key = p.apiKey || null; alias = p.alias || p.model;
    if (!key && isWbHub(base)) key = wbKey();          // 平台预设走自家网关：密钥由服务端注入
    effort = seat.effort || p.effort || 'medium'; thinking = p.thinking || null;
    maxTokens = seat.maxTokens || p.maxTokens; temperature = seat.temperature == null ? p.temperature : seat.temperature;
  } else if (seat.configId) {
    if (!me) return { ok: false, error: '得先登录，才认得出你存的那条配置' };
    const c = accounts.configById(me, seat.configId);
    if (!c) return { ok: false, error: '没有这条个人配置' };
    base = c.baseUrl; model = c.model; key = accounts.keyOf(c); alias = c.alias || c.name || c.model;
    effort = seat.effort || c.effort || 'medium'; thinking = c.thinking || null;
    maxTokens = c.maxTokens; temperature = c.temperature;
    if (!seat.guideText && c.guideText) seat.guideText = c.guideText;   // 秘诀存在账号里，建桌自动带上
  }
  if (!base || !model) return { ok: false, error: '模型座位得有 Base URL 和模型名' };
  // 平台预设若指向服务器本机/内网端点，在公网部署上根本到不了 —— 提前说清楚，
  // 别等出网策略报一句「本机端点被拒」让人以为是配错了。
  if (seat.kind === 'preset' && /^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(base)) && !POLICY.localPorts.length) {
    return { ok: false, error: '这个预设指向服务器本机/内网端点，公网部署到不了；这一座换成内置人机，或自带一个公网可达的端点' };
  }
  const chk = await GW.checkEgress(base, POLICY);
  if (!chk.ok) return { ok: false, error: '端点过不了出网策略：' + chk.reason };
  const secretToken = vault.put({ baseUrl: base, model: String(model).trim(), apiKey: key ? String(key).trim() : null, alias, guideText: seat.guideText || null }, 24 * 3600 * 1000);
  const out = Object.assign({}, seat, { kind: 'llm', baseUrl: base, model: String(model).trim(), secretToken, alias, effort, thinking, maxTokens, temperature });
  delete out.presetId; delete out.configId;
  return { ok: true, seat: out };
}
function hostOf(base) { try { return new URL(String(base)).host; } catch (e) { return '?'; } }
function rulesAvailable() {
  const custom = readPresets().ruleSets || [];
  return RS.allRules(custom).map(r => ({ id: r.id, name: r.name, hash: RS.hash(r) }));
}

/* ---------------- 小工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let n = 0, chunks = [];
    req.on('data', d => {
      n += d.length;
      if (n > MAX_BODY) { req.destroy(); resolve(null); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
function sessionToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const ck = req.headers.cookie || '';
  const m = ck.match(/(?:^|;\s*)sid=([0-9a-f]{24,})/);
  return m ? m[1] : null;
}
function currentUser(req) { return accounts.auth(sessionToken(req)); }
function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : (req.socket.remoteAddress || '?'));
}
const buckets = new Map();      // 简易限流：key → [时间戳]
// 限流阈值都可调：本地联调别把自己锁死，公网部署按需收紧
const RATE = {
  signup: [+process.env.DICE_RATE_SIGNUP || 8, 10 * 60000],
  login: [+process.env.DICE_RATE_LOGIN || 20, 10 * 60000],
  secret: [+process.env.DICE_RATE_SECRET || 60, 10 * 60000],
  modeltest: [+process.env.DICE_RATE_MODELTEST || 20, 10 * 60000],
  create: [+process.env.DICE_RATE_CREATE || 24, 10 * 60000],
  preset: [+process.env.DICE_RATE_PRESET || 20, 3600 * 1000],
};
function rateOk(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr);
  return true;
}
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

/* ---------------- SSE ---------------- */
function openStream(req, res, room, role) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',          // nginx 即使配了 buffering off 也再保险一次
  });
  const last = parseInt(req.headers['last-event-id'] || (new URL(req.url, 'http://x')).searchParams.get('lastEventId') || '', 10);
  const sub = registry.subscribe(room, res, role, Number.isFinite(last) ? last : null);
  registry.emit(room, 'hello', {
    room: Object.assign({}, registry.info(room), { you: role }),
    backlog: sub.backlog.length,
    view: role === 'A' || role === 'B' ? privateLastView(room, role) : V.publicView(room.m || emptyMatch(room)),
  }, role === 'spec' ? 'all' : role);
  for (const e of sub.backlog) { try { res.write('id: ' + e.id + '\nevent: ' + e.type + '\ndata: ' + JSON.stringify(e.payload) + '\n\n'); } catch (err) { break; } }
  const beat = setInterval(() => { try { res.write(': beat ' + Date.now() + '\n\n'); } catch (err) { clearInterval(beat); } }, 20000);
  if (beat.unref) beat.unref();
  req.on('close', () => { clearInterval(beat); registry.unsubscribe(room, sub.id, 'closed'); });
}
function emptyMatch(room) {
  return { hpMax: room.hpMax, hp: { A: room.hpMax, B: room.hpMax }, losses: { A: 0, B: 0 }, roundNo: 0, over: true,
    winner: null, capped: false, firstBidder: 'A', lastLoser: null, history: [],
    round: { no: 0, dice: { A: [], B: [] }, turn: 'A', seq: [], bid: null, over: true, zhai: false } };
}
// 重连时补一份「当前视角」：从最近一次 ask 事件里取，避免重连后界面空白
function privateLastView(room, plan) {
  for (let i = room.events.length - 1; i >= 0; i--) {
    const e = room.events[i];
    if (e.type === 'ask' && e.scope === plan && e.payload.view) return e.payload.view;
  }
  return room.m ? V.viewFor(room.m, room.chairPlan.A === plan ? 'A' : 'B') : null;
}

/* ---------------- 路由 ---------------- */
async function api(req, res, u) {
  const me = currentUser(req);
  const ip = ipOf(req);
  const p = u.pathname;

  if (req.method === 'GET' && p === '/api/ping') {
    return json(res, 200, {
      ok: true, engine: 'guidie-live', time: Date.now(),
      policy: { allowHosts: POLICY.allowHosts, localPorts: POLICY.localPorts, httpsOnly: POLICY.requireHttps },
      bots: Object.keys(BOTS).map(k => ({ id: k, label: BOTS[k].label, desc: BOTS[k].desc })),
      models: presetPublic(),
      rules: rulesAvailable(),
      guideMax: C.GUIDE_MAX, arms: Object.keys(C.ARMS).filter(k => !k.startsWith('custom-')).map(k => ({ id: k, label: C.ARMS[k].label })),
      rooms: registry.rooms.size, users: accounts.count(),
      defaultBudget: DEFAULT_BUDGET,
      wxLogin: !!(process.env.DICE_WX_APPID && process.env.DICE_WX_SECRET),
    });
  }

  if (p === '/api/signup' && req.method === 'POST') {
    if (!rateOk('signup:' + ip, RATE.signup[0], RATE.signup[1])) return json(res, 429, { error: '注册太频繁，等一会儿再试' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = accounts.signup(b.nick, b.pass);
    if (!r.ok) return json(res, 400, { error: r.reason });
    return json(res, 200, { token: r.token || null, me: accounts.safe(r.user), cookie: true });
  }
  if (p === '/api/login' && req.method === 'POST') {
    if (!rateOk('login:' + ip, RATE.login[0], RATE.login[1])) return json(res, 429, { error: '登录尝试太多，等一会儿' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = accounts.login(b.nick, b.pass);
    if (!r.ok) return json(res, 401, { error: r.reason });
    res.setHeader('Set-Cookie', 'sid=' + r.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (30 * 86400) + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
    return json(res, 200, { token: r.token, me: accounts.safe(r.user) });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const t = sessionToken(req);
    if (t) accounts.logout(t);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/me') {
    if (!me) return json(res, 401, { error: '还没登录' });
    return json(res, 200, { me: accounts.safe(me) });
  }

  // —— 小程序登录：wx.login 的 code 换 openid。AppSecret 只在服务端，session_key 从不下发 ——
  if (p === '/api/mini/login' && req.method === 'POST') {
    const appid = process.env.DICE_WX_APPID || '', secret = process.env.DICE_WX_SECRET || '';
    if (!appid || !secret) {
      return json(res, 501, { wx: false, error: '服务器没配 DICE_WX_APPID / DICE_WX_SECRET，先按昵称匿名上桌' });
    }
    if (!rateOk('minilogin:' + ip, RATE.login[0], RATE.login[1])) return json(res, 429, { error: '登录太频繁，等一会儿' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const code = String(b.code || '').trim();
    if (!code) return json(res, 400, { error: '缺少 code' });
    const qs = new URLSearchParams({ appid, secret, js_code: code, grant_type: 'authorization_code' });
    let j = null;
    try {
      const r = await fetch('https://api.weixin.qq.com/sns/jscode2session?' + qs.toString(), { signal: AbortSignal.timeout(8000) });
      j = await r.json();
    } catch (e) {
      return json(res, 502, { error: '连不上微信登录服务：' + String(e && e.message || e).slice(0, 80) });
    }
    if (!j || !j.openid) return json(res, 400, { error: '微信登录失败：' + ((j && j.errmsg) || '没拿到 openid') });
    const r2 = accounts.loginByOpenid(j.openid, b.nick);
    if (!r2.ok) return json(res, 400, { error: r2.reason });
    log('小程序登录', r2.user.nick);
    return json(res, 200, { wx: true, token: r2.token, me: accounts.safe(r2.user) });
  }

  // —— 个人配置：模型 / Key / 秘诀（Key 只回掩码）——
  if (p === '/api/profile/config' && req.method === 'POST') {
    if (!me) return json(res, 401, { error: '先登录，配置才有地方存' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const cfg = b.config || b;
    if (cfg.kind === 'llm' || (!cfg.kind && cfg.baseUrl)) {
      const chk = await GW.checkEgress(cfg.baseUrl, POLICY);
      if (!chk.ok) return json(res, 400, { error: 'Base URL 过不了出网策略：' + chk.reason });
    }
    const r = accounts.upsertConfig(me, cfg);
    if (!r.ok) return json(res, 400, { error: r.reason });
    // Key 走顶层字段（界面里「留空 = 不改」），也可能被塞在 config 里，两种都接
    const rawKey = b.key != null ? b.key : cfg.key;
    if (rawKey != null && String(rawKey).trim()) accounts.setKey(accounts.configById(me, r.config.id), String(rawKey).trim());
    return json(res, 200, { config: accounts.safeConfig(accounts.configById(me, r.config.id)) });
  }
  if (p === '/api/profile/drop' && req.method === 'POST') {
    if (!me) return json(res, 401, { error: '先登录' });
    const b = await readBody(req);
    return json(res, 200, { ok: accounts.dropConfig(me, (b || {}).id) });
  }
  if (p === '/api/profile/prefs' && req.method === 'POST') {
    if (!me) return json(res, 401, { error: '先登录' });
    const b = await readBody(req);
    return json(res, 200, { prefs: accounts.setPrefs(me, (b || {}).prefs || b || {}) });
  }

  // —— 临时 Key（匿名自带）：只进内存保险柜 ——
  if (p === '/api/secret' && req.method === 'POST') {
    if (!rateOk('secret:' + ip, RATE.secret[0], RATE.secret[1])) return json(res, 429, { error: '填 Key 太频繁' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const chk = await GW.checkEgress(b.baseUrl, POLICY);
    if (!chk.ok) return json(res, 400, { error: 'Base URL 过不了出网策略：' + chk.reason });
    const token = vault.put({ baseUrl: String(b.baseUrl).trim(), model: String(b.model || '').trim(), apiKey: b.apiKey ? String(b.apiKey).trim() : null, alias: b.alias || b.model, guideText: b.guideText }, 3 * 3600 * 1000);
    return json(res, 200, { secretToken: token, host: hostOf(b.baseUrl), keyMask: maskKey(b.apiKey) });
  }

  // —— 连接测试（小预算，会真花钱，UI 上要提示）——
  if (p === '/api/model/test' && req.method === 'POST') {
    if (!rateOk('modeltest:' + ip, RATE.modeltest[0], RATE.modeltest[1])) return json(res, 429, { error: '测试太频繁' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    let base = b.baseUrl, model = b.model, key = b.apiKey || null;
    if (b.secretToken) { const e = vault.get(b.secretToken); if (!e) return json(res, 400, { error: '临时令牌失效' }); base = e.baseUrl; model = e.model; key = e.apiKey; }
    if (b.configId && me) { const c = accounts.configById(me, b.configId); if (!c) return json(res, 400, { error: '没有这条配置' }); base = c.baseUrl; model = c.model; key = accounts.keyOf(c); }
    const chk = await GW.checkEgress(base, POLICY);
    if (!chk.ok) return json(res, 400, { error: 'Base URL 过不了出网策略：' + chk.reason });
    const url = String(base).replace(/\/+$/, '') + '/chat/completions';
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回两个字：就绪' }], max_tokens: 64, temperature: 0 }),
        signal: AbortSignal.timeout(60000),
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) { }
      const content = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '').slice(0, 80) : '';
      return json(res, r.ok ? 200 : 502, {
        ok: r.ok, http: r.status, ms: Date.now() - t0, content,
        usage: j && j.usage ? { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens } : null,
        error: r.ok ? null : (j && j.error ? j.error.message || JSON.stringify(j.error).slice(0, 200) : txt.slice(0, 200)),
      });
    } catch (e) {
      return json(res, 502, { ok: false, error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0 });
    }
  }

  // —— 房间 ——
  if (p === '/api/room/create' && req.method === 'POST') {
    if (!rateOk('create:' + ip, RATE.create[0], RATE.create[1])) return json(res, 429, { error: '建桌太频繁，先打完手上这桌' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const seats = { A: { kind: 'open' }, B: { kind: 'open' } };
    for (const w of ['A', 'B']) if (b.seats && b.seats[w]) {
      const rs = await resolveSeat(b.seats[w], me, ip);
      if (!rs.ok) return json(res, 400, { error: (w === 'A' ? '甲方：' : '乙方：') + rs.error });
      seats[w] = rs.seat;
    }
    if (me) seats.A.userId = me.id;
    let room;
    try {
      room = registry.create({
        title: b.title, rules: b.rules, hpMax: b.hpMax, maxRounds: b.maxRounds, turnMs: b.turnMs,
        onTimeout: b.onTimeout, duplicate: b.duplicate, deals: b.deals, pass: b.pass,
        tokenBudget: +b.tokenBudget || DEFAULT_BUDGET, reflectAfter: b.reflectAfter, seats,
      }, me);
    } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    const mine = room.seats.A.token ? { seat: 'A', token: room.seats.A.token } : null;
    log('建桌', room.code, 'by', me ? me.nick : ip);
    return json(res, 200, { code: room.code, you: mine, room: registry.info(room), invite: '?room=' + room.code });
  }
  if (p === '/api/room/join' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    let spec = { nick: b.nick, pass: b.pass, user: me };
    if (b.seatSpec) {
      const rs = await resolveSeat(b.seatSpec, me, ip);
      if (!rs.ok) return json(res, 400, { error: rs.error });
      spec = Object.assign(spec, rs.seat);
    }
    const r = registry.join(b.code, b.seat || 'B', spec);
    if (!r.ok) return json(res, 400, { error: r.reason });
    log('入座', r.room.code, r.seat, r.room.seats[r.seat].nick);
    return json(res, 200, r);
  }
  if (p === '/api/room/start' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = await registry.start(b.code, { token: b.token, user: me });
    return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
  }
  if (p === '/api/room/action' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const room = registry.get(b.code);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const plan = b.seat === 'B' ? 'B' : 'A';
    if (!registry.checkSeatToken(room, plan, b.token)) return json(res, 403, { error: '这一座的令牌不对' });
    const actor = registry.actorOfPlan(room, plan);
    if (!actor || !actor.submit) return json(res, 400, { error: '这一座不是人在打，替不了' });
    const r = actor.submit(b.action);
    if (r.ok) registry.emit(room, 'acted', { seat: plan, action: r.action }, 'all');
    return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
  }
  if (p === '/api/room/resign' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = registry.resign(b.code, b.seat === 'B' ? 'B' : 'A', b.token);
    return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
  }
  if (p === '/api/room/close' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const room = registry.get(b.code);
    if (!room) return json(res, 404, { error: '房间不存在' });
    if (!(b.token && (registry.checkSeatToken(room, 'A', b.token) || registry.checkSeatToken(room, 'B', b.token)))) return json(res, 403, { error: '只有坐上来的人能关桌' });
    return json(res, 200, { ok: registry.close(b.code) });
  }
  if (req.method === 'GET' && p === '/api/rooms') return json(res, 200, { rooms: registry.listPublic() });
  if (req.method === 'GET' && p === '/api/matches') {
    const file = path.join(DATA, 'matches-live.jsonl');
    const limit = Math.min(500, Math.max(1, +(u.searchParams.get('limit') || 200)));
    let rows = [];
    try {
      const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit);
      rows = all.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
        .map(m => ({
          t: m.t, run_id: m.run_id, gameNo: m.gameNo, rules: m.rules, hpMax: m.hpMax, rounds: m.rounds,
          winner: m.winner, draw: m.draw, hp: m.hp, duplicate: m.duplicate,
          seats: { A: publicSeat(m.seats.A), B: publicSeat(m.seats.B) }, stats: m.stats, ms: m.ms,
        }));
    } catch (e) { rows = []; }
    return json(res, 200, { matches: rows, me: me ? me.id : null });
  }
  if (req.method === 'GET' && p.startsWith('/api/room/')) {
    const code = p.slice('/api/room/'.length);
    if (code.endsWith('/poll')) {
      // 长轮询：小程序没有 EventSource，用「挂着等」的方式复用同一条事件流。
      // 与 /stream 完全同口径：同一份 room.events、同一个 visibleTo、同一把座位令牌。
      const room = registry.get(code.slice(0, -'/poll'.length));
      if (!room) return json(res, 404, { error: '房间不存在' });
      const raw = (u.searchParams.get('role') || 'spec').toUpperCase();
      const role = (raw === 'A' || raw === 'B') ? raw : 'spec';
      if (role !== 'spec' && !registry.checkSeatToken(room, role, u.searchParams.get('token'))) {
        return json(res, 403, { error: '这一座的令牌不对，只能观战' });
      }
      if ((room.polling || 0) >= 8) return json(res, 429, { error: '这一桌挂起的请求太多了，稍后再试' });
      const sinceRaw = parseInt(u.searchParams.get('since') || '0', 10);
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
      const wait = Math.min(25000, Math.max(0, parseInt(u.searchParams.get('wait') || '25000', 10) || 0));
      registry.touchPoll(room, role);
      let evs = registry.pollEvents(room, role, since);
      if (!since && evs.length > 60) evs = evs.slice(-60);     // 首次进房别把整圈缓冲吐一遍，state 由 view 兜住
      if (!evs.length && wait > 0) {
        room.polling = (room.polling || 0) + 1;
        try { await registry.waitForEvent(room, wait); } finally { room.polling = Math.max(0, (room.polling || 1) - 1); }
        evs = registry.pollEvents(room, role, since);
      }
      const cursor = evs.length ? evs[evs.length - 1].id : since;
      return json(res, 200, {
        ok: true, cursor, wait,
        events: evs.map(e => ({ id: e.id, type: e.type, t: e.t, payload: e.payload })),
        room: registry.info(room),
        view: role === 'A' || role === 'B' ? privateLastView(room, role) : V.publicView(room.m || emptyMatch(room)),
      });
    }
    if (code.endsWith('/stream')) {
      const room = registry.get(code.slice(0, -'/stream'.length));
      if (!room) return json(res, 404, { error: '房间不存在' });
      // 角色归一化：只认 A / B（带座位令牌），其余一律观战
      const raw = (u.searchParams.get('role') || 'spec').toUpperCase();
      const role = (raw === 'A' || raw === 'B') ? raw : 'spec';
      if (role !== 'spec' && !registry.checkSeatToken(room, role, u.searchParams.get('token'))) {
        return json(res, 403, { error: '这一座的令牌不对，只能观战' });
      }
      return openStream(req, res, room, role);
    }
    const room = registry.get(code);
    if (!room) return json(res, 404, { error: '房间不存在' });
    return json(res, 200, { room: registry.info(room), view: V.publicView(room.m || emptyMatch(room)) });
  }

  return json(res, 404, { error: '没有这个接口：' + p });
}
function publicSeat(s) {
  if (!s) return null;
  return { id: s.id, alias: s.alias, model: s.model, base: s.base === 'human' ? 'human' : (s.base ? '***' : null), effort: s.effort, guideChars: s.guideChars || 0 };
}

function serveStatic(req, res, u) {
  const p = u.pathname === '/' ? '/web/play.html' : u.pathname;
  if (!STATIC_OK.has(p)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
  const file = path.join(ROOT, p);
  try {
    const buf = fs.readFileSync(file);
    const type = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('页面还没就绪：' + p); }
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { return json(res, 400, { error: 'bad url' }); }
  if (u.pathname.startsWith('/api/')) {
    // 小程序 / 开发者工具的请求不是同源浏览器页面，但联调时常在浏览器里直接打接口，统一放开即可：
    // 接口本身靠座位令牌与 Bearer 会话鉴权，不靠同源策略。
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try { await api(req, res, u); }
    catch (e) { log('接口炸了', u.pathname, String(e && e.stack || e).split('\n')[0]); if (!res.headersSent) json(res, 500, { error: '服务端出错了' }); }
    return;
  }
  serveStatic(req, res, u);
});

server.listen(PORT, HOST, () => {
  log('实时对战平台: http://' + HOST + ':' + PORT + '/web/play.html');
  log('出网策略: 白名单 ' + (POLICY.allowHosts.length ? POLICY.allowHosts.join(',') : '(未启用，按地址策略拦私网)')
    + ' · 本机放行端口 ' + (POLICY.localPorts.length ? POLICY.localPorts.join(',') : '(无)')
    + (POLICY.requireHttps ? ' · 仅 https' : ''));
  log('账号 ' + accounts.count() + ' 个 · 平台预设模型 ' + presetPublic().length + ' 个 · 战绩 ' + path.join(DATA, 'matches-live.jsonl'));
  if (HOST !== '127.0.0.1') log('注意：监听在非环回地址，公网暴露请挂在 nginx/HTTPS 后面，并配 DICE_ALLOW_HOSTS');
});
