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
// DICE_PUBLIC=1：这台机器直接对公网开放（裸端口，没有 nginx/https 在前）。
// 效果：模型席位必须登录才能挂；用户自填的 Base URL 不再享有内网豁免（只有服务端
// presets.json 里管理员配的预设能走服务器本机/内网的模型桥）。
const PUBLIC = process.env.DICE_PUBLIC === '1';
const MAX_BODY = 256 * 1024;
const STATIC_OK = new Set(['/web/play.html', '/web/play.js', '/web/play.css', '/web/ranking.js']);
// 服务器主人（例如潘潘自己）：只有这些账号能把模型端点指向服务器本机的隧道口，
// 别人（游客、朋友）在公网部署上一律不许碰私网地址。
const OWNER_UIDS = (process.env.DICE_OWNER_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const OWNER_NICKS = (process.env.DICE_OWNER_NICKS || 'pan').split(',').map(s => s.trim()).filter(Boolean);
// 认主人：优先账号 id（不可抢注）；没配 id 时才退化成昵称，并在启动日志里提醒。
const isOwnerAcct = me => {
  if (!me) return false;
  if (OWNER_UIDS.length) return OWNER_UIDS.includes(String(me.id));
  return OWNER_NICKS.includes(String(me.nick || '').trim());
};
// 出网策略：非主人一律不给本机/隧道端口豁免
function policyFor(me) {
  return Object.assign({}, POLICY, { localPorts: isOwnerAcct(me) ? POLICY.localPorts : [] });
}

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
  // 公网裸端口部署（DICE_PUBLIC=1）：模型席位一律要登录才能挂 —— 否则任何人拿到链接
  // 就能拿这台桌子去烧房主的模型；而且用户自己填的 Base URL 一律不许指向内网，
  // 只有服务端 presets.json 里的预设（管理员配的）才允许够到服务器本机/内网的模型桥。
  if (PUBLIC && !me) return { ok: false, error: '这台机器对公网开放：模型席位要登录后才能挂（游客只能坐真人或内置人机）' };
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
  // 主人在配置里写「家里的 127.0.0.1:1235」：云上没有 1235，但有到家的隧道（18444）。
  // 这里把 loopback 端口映射到隧道口，于是配置可以照着自己家那台机器的地址写，
  // 流量只走隧道，公网看不到；别人的账号写同样地址不会被这么处理。
  if (isOwnerAcct(me) && seat.kind === 'llm') {
    const map = GW.parsePortAlias(process.env.DICE_PORT_ALIAS || '1235=18444,1236=18445');
    const al = GW.aliasLoopback(base, map);
    if (al.aliased) {
      base = al.base;
      // 走自家隧道时，Key 默认沿用「家里模型」那条预设的（密钥只留在服务器上，不用在浏览器里输）
      if (!key) {
        const home = readPresets().list.find(p2 => p2.id === 'home-llm' || /18444|1235/.test(String(p2.base)));
        if (home && home.apiKey) key = home.apiKey;
      }
      log('主人账号走本机端口别名', al.from, '→', al.to, '：' + hostOf(base));
    }
  }
  // 平台预设若指向服务器本机/内网端点，在公网部署上根本到不了 —— 提前说清楚，
  // 别等出网策略报一句「本机端点被拒」让人以为是配错了。
  if (seat.kind === 'preset' && /^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(base)) && !POLICY.localPorts.length) {
    return { ok: false, error: '这个预设指向服务器本机/内网端点，公网部署到不了；这一座换成内置人机，或自带一个公网可达的端点' };
  }
  // 用户可填的地址（自己填的 / 个人配置里存的）在公网部署上没有内网豁免；服务端预设才有。
  // 例外：主人账号自己的模型配置可以走本机隧道口（127.0.0.1:18444 → 家里的 1235），
  // 这样他家的模型能上桌，而不用把家里的端口暴露到公网，也不用把别人的端点引进来。
  const ownerTunnel = isOwnerAcct(me) && seat.kind === 'llm';
  const pol = (PUBLIC && seat.kind !== 'preset')
    ? Object.assign({}, POLICY, { localPorts: ownerTunnel ? POLICY.localPorts : [] })
    : POLICY;
  const chk = await GW.checkEgress(base, pol);
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
  if ((role === 'spec' || role === 'host') && room.m) { try { registry.emitOmni(room); } catch (e) { /* 推流失败不影响连接 */ } }
  // 握手只发给这条连接：以前用 scope:'all' 广播，在座玩家会收到一条 you:'spec' 的 hello，
  // 前端据此把座位令牌丢掉 —— 别人一观战，自己就被「降级」成观战了。
  registry.emitTo(room, sub, 'hello', {
    subId: sub.id,
    room: Object.assign({}, registry.info(room), { you: role }),
    backlog: sub.backlog.length,
    view: role === 'A' || role === 'B' ? privateLastView(room, role) : V.publicView(room.m || emptyMatch(room)),
  });
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
      policy: { allowHosts: POLICY.allowHosts, localPorts: POLICY.localPorts, httpsOnly: POLICY.requireHttps, public: PUBLIC },
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
      // 主人账号可以写「家里的 127.0.0.1:1235」：存之前先按隧道口校验一遍，
      // 真正用的时候（resolveSeat）也会映射到隧道口，界面上照着自己家那台机器写就行。
      let probe = cfg.baseUrl;
      if (isOwnerAcct(me)) {
        const al = GW.aliasLoopback(probe, GW.parsePortAlias(process.env.DICE_PORT_ALIAS || '1235=18444,1236=18445'));
        if (al.aliased) probe = al.base;
      }
      const chk = await GW.checkEgress(probe, policyFor(me));
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
    const chk = await GW.checkEgress(b.baseUrl, policyFor(me));
    if (!chk.ok) return json(res, 400, { error: 'Base URL 过不了出网策略：' + chk.reason });
    const token = vault.put({ baseUrl: String(b.baseUrl).trim(), model: String(b.model || '').trim(), apiKey: b.apiKey ? String(b.apiKey).trim() : null, alias: b.alias || b.model, guideText: b.guideText }, 3 * 3600 * 1000);
    return json(res, 200, { secretToken: token, host: hostOf(b.baseUrl), keyMask: maskKey(b.apiKey) });
  }

  // —— 连接测试（小预算，会真花钱，UI 上要提示）——
  if (p === '/api/model/test' && req.method === 'POST') {
    if (!me) return json(res, 401, { error: '测试连接要先登录' });
    if (!rateOk('modeltest:' + ip, RATE.modeltest[0], RATE.modeltest[1])) return json(res, 429, { error: '测试太频繁' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    let base = b.baseUrl, model = b.model, key = b.apiKey || null;
    if (b.secretToken) { const e = vault.get(b.secretToken); if (!e) return json(res, 400, { error: '临时令牌失效' }); base = e.baseUrl; model = e.model; key = e.apiKey; }
    if (b.configId && me) { const c = accounts.configById(me, b.configId); if (!c) return json(res, 400, { error: '没有这条配置' }); base = c.baseUrl; model = c.model; key = accounts.keyOf(c); }
    const chk = await GW.checkEgress(base, policyFor(me));
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
    // 邀请制：对面那一席只能靠邀请链接让别人进来，不接受建桌时直接挂模型
    if ((b.mode || 'invite') === 'invite') seats.B = { kind: 'open' };
    let room;
    try {
      room = registry.create({
        title: b.title, rules: b.rules, hpMax: b.hpMax, maxRounds: b.maxRounds, turnMs: b.turnMs,
        onTimeout: b.onTimeout, duplicate: b.duplicate, deals: b.deals, pass: b.pass,
        tokenBudget: +b.tokenBudget || DEFAULT_BUDGET, reflectAfter: b.reflectAfter, seats,
        mode: b.mode === 'solo' ? 'solo' : 'invite',
      }, me);
    } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    const mine = room.seats.A.token ? { seat: 'A', token: room.seats.A.token } : null;
    log('建桌', room.code, 'by', me ? me.nick : ip);
    // host = 房主控制令牌（只发给建桌这一次，界面存本地）；房间信息和事件流里查不到它
    return json(res, 200, { code: room.code, you: mine, host: room.hostToken, room: registry.info(room), invite: '?room=' + room.code });
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
  // 观战席：默认进来就是观战（全知视角）
  if (p === '/api/room/watch' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = registry.watchSeat(String(b.code || '').toUpperCase(), { nick: b.nick, pass: b.pass, user: me });
    if (!r.ok) return json(res, 400, { error: r.reason });
    return json(res, 200, r);
  }
  // 准备 / 取消准备（只有真人席需要点；模型放上去就自动准备了）
  if (p === '/api/room/ready' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = registry.setReady(b.code, b.seat, b.token, b.ready !== false);
    return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
  }
  // 把模型 / 人机放上对战席（放上去即准备）
  if (p === '/api/room/place' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const rs = await resolveSeat(Object.assign({ kind: 'llm' }, b.seatSpec || {}), me, ip);
    if (!rs.ok) return json(res, 400, { error: rs.error });
    const r = registry.placeSeat(b.code, { seat: b.seat, seatSpec: rs.seat, user: me, host: b.host });
    return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
  }
  // 离开房间：把这个人的席位真清掉（不然别人看到的是一张「虚空的我」）
  if (p === '/api/room/leave' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = registry.leave(String(b.code || '').toUpperCase(), { user: me, token: b.token });
    return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
  }
  // 把席位上的模型放下
  if (p === '/api/room/unplace' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = registry.unplaceSeat(b.code, { seat: b.seat, user: me, host: b.host, token: b.token });
    return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
  }
  // 个人演武场：一人一份。和「自己的模型 / 人机」打（自己那席看不到对面），
  // 或让「两台模型对打」（没有真人上桌 = 全知观战）。
  if (p === '/api/solo' && req.method === 'POST') {
    if (!me) return json(res, 401, { error: '演武场要登录：每个人一份自己的模型与战绩' });
    if (!rateOk('solo:' + ip, RATE.create[0], RATE.create[1])) return json(res, 429, { error: '开得太频繁，先打完这一场' });
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const kind = b.mode === 'model-vs-model' ? 'model-vs-model' : 'vs-model';
    const seats = { A: { kind: 'me', nick: b.nick || me.nick }, B: { kind: 'open' } };
    try {
      if (kind === 'vs-model') {
        const rs = await resolveSeat(Object.assign({ kind: 'llm' }, b.seatSpec || {}), me, ip);
        if (!rs.ok) return json(res, 400, { error: '对手那一座：' + rs.error });
        seats.B = rs.seat;
      } else {
        const a = await resolveSeat(Object.assign({ kind: 'llm' }, b.seatSpecA || {}), me, ip);
        if (!a.ok) return json(res, 400, { error: '甲方：' + a.error });
        const bb = await resolveSeat(Object.assign({ kind: 'llm' }, b.seatSpecB || {}), me, ip);
        if (!bb.ok) return json(res, 400, { error: '乙方：' + bb.error });
        seats.A = a.seat; seats.B = bb.seat;
      }
    } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    let room;
    try {
      room = registry.create({
        mode: 'solo', title: b.title || '演武场', rules: b.rules, hpMax: b.hpMax, maxRounds: b.maxRounds,
        turnMs: b.turnMs, onTimeout: b.onTimeout, duplicate: !!b.duplicate, deals: b.deals,
        tokenBudget: +b.tokenBudget || 0, seats,
      }, me);
    } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    // 演武场：进来就能开练，不等准备
    room.seats.A.ready = true; room.seats.B.ready = true;
    // 演武场是自己看的场子：两台机器对打时给人机加节奏，别一秒打完
    room.watchExpected = true;
    const st = await registry.start(room.code, { user: me, host: room.hostToken });
    if (!st.ok) return json(res, 400, { error: st.reason });
    const mine = room.seats.A.token ? { seat: 'A', token: room.seats.A.token } : null;
    log('演武场', room.code, kind, 'by', me.nick);
    return json(res, 200, { code: room.code, you: mine, host: room.hostToken, room: registry.info(room), mode: kind });
  }
  if (p === '/api/room/start' && req.method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'JSON 解析失败' });
    const r = await registry.start(b.code, { token: b.token, user: me, host: b.host });
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
    const mayClose = (b.token && (registry.checkSeatToken(room, 'A', b.token) || registry.checkSeatToken(room, 'B', b.token)))
      || (b.host && room.hostToken && room.hostToken === b.host) || (me && room.ownerId === me.id);
    if (!mayClose) return json(res, 403, { error: '只有建桌的人或坐上来的人能关桌' });
    return json(res, 200, { ok: registry.close(b.code) });
  }
  // 单桌信息：邀请链接落地时先拿一份快照（事件流紧接着就会补上后续变化）
  if (req.method === 'GET' && p === '/api/room/info') {
    const room = registry.get((u.searchParams.get('code') || '').toUpperCase());
    if (!room) return json(res, 404, { error: '房间不存在或已关闭' });
    return json(res, 200, { room: registry.info(room), you: undefined });
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
          ruleset_hash: m.ruleset_hash || null, prompt_hash: m.prompt_hash || null, source: m.source || 'live',
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
      if (role === 'spec') {
        const okSpec = registry.specMayWatch(room, { user: me, token: u.searchParams.get('token') });
        if (!okSpec.ok) return json(res, 403, { error: okSpec.reason });
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
      // 角色归一化：A / B 要座位令牌；HOST 要房主令牌（建桌时发的那次）或登录的房主本人。
      // host 只多看到两座 AI 的「实时推演」，看不到任何人的骰子 —— 骰子仍按座位/观战规则发。
      const raw = (u.searchParams.get('role') || 'spec').toUpperCase();
      const tk = u.searchParams.get('token');
      let role = (raw === 'A' || raw === 'B') ? raw : 'spec';
      if (role !== 'spec' && !registry.checkSeatToken(room, role, tk)) {
        return json(res, 403, { error: '这一座的令牌不对，只能观战' });
      }
      if (role === 'spec') {
        const okSpec = registry.specMayWatch(room, { user: me, token: tk });
        if (!okSpec.ok) return json(res, 403, { error: okSpec.reason });
      }
      if (raw === 'HOST') {
        // 房主以全知身份看桌：亲自坐进座位（座位令牌/登录占席）就不许再用房主身份看对面
        const hw = registry.hostMayWatch(room, { user: me, token: tk });
        if (!hw.ok) return json(res, 403, { error: hw.reason });
        role = 'host';
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

// 页面里的 css/js 直接内联成一份 HTML 再发出去：
// 浏览器只要拿到这一个响应就完整了，不会出现「HTML 是新的、样式表还在缓存里/取不到」这种半截页面。
let inlineCache = { key: '', buf: null };
function inlinePage() {
  const f = n => path.join(ROOT, 'web', n);
  const st = ['play.html', 'play.css', 'play.js', 'ranking.js'].map(n => { try { return fs.statSync(f(n)).mtimeMs; } catch (e) { return 0; } });
  const key = st.join(':');
  if (inlineCache.buf && inlineCache.key === key) return inlineCache.buf;
  let html = fs.readFileSync(f('play.html'), 'utf8');
  const css = fs.readFileSync(f('play.css'), 'utf8');
  const js = fs.readFileSync(f('play.js'), 'utf8').replace(/<\/script>/gi, '<\\/script>');
  let rank = '';
  try { rank = fs.readFileSync(f('ranking.js'), 'utf8').replace(/<\/script>/gi, '<\\/script>'); } catch (e) { /* 排名模块可选 */ }
  html = html.replace(/<link[^>]*play\.css[^>]*>/, '<style>\n' + css + '\n</style>')
    .replace(/<script src="ranking\.js[^"]*"><\/script>/, rank ? '<script>\n' + rank + '\n</script>' : '')
    .replace(/<script src="play\.js[^"]*"><\/script>/, '<script>\n' + js + '\n</script>');
  inlineCache = { key, buf: Buffer.from(html, 'utf8') };
  return inlineCache.buf;
}

function serveStatic(req, res, u) {
  const p = u.pathname === '/' ? '/web/play.html' : u.pathname;
  if (!STATIC_OK.has(p)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
  const file = path.join(ROOT, p);
  try {
    const buf = p === '/web/play.html' ? inlinePage() : fs.readFileSync(file);
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
  log('主人账号：' + (OWNER_UIDS.length ? '按 id ' + OWNER_UIDS.join(',') : '按昵称 ' + OWNER_NICKS.join(',') + '（建议改用 DICE_OWNER_UIDS 绑定账号 id，避免被抢注）')
    + (PUBLIC ? ' · 公网模式：非主人不享受本机/隧道端点豁免' : ''));
  if (HOST !== '127.0.0.1') log('注意：监听在非环回地址，公网暴露请挂在 nginx/HTTPS 后面，并配 DICE_ALLOW_HOSTS');
});
