/* 账号与个人配置（实时对战平台）
 * 每人一个账号：昵称 + 口令（scrypt 加盐哈希，明文口令不落盘）。账号里存的是「我自己的上桌配置」：
 *   configs[]：kind='llm' 的模型配置（Base URL / 模型 ID / API Key 密文 / 思考档 / 预算 / 我的秘诀）
 *              kind='bot' 的内置人机偏好；kind='me' 表示这一座由本人手打。
 *   prefs：规则集、血量、轮数上限、每手时限、复式开关（上桌时作为默认值）。
 * Key 只以密文存在 users.json 里（主密钥在 data/secret.key，0600）；对外一律掩码，
 * 只有本人会话显式取回时才解密。同桌的对手与观众永远看不到 Key，也看不到 Base URL 之外的细节。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { maskKey } = require('./secrets.js');
const { cleanGuide, GUIDE_MAX } = require('./context.js');

const SCRYPT = { N: 16384, r: 8, p: 1, len: 64 };
const SESSION_MS = 30 * 24 * 3600 * 1000;
const NICK_MAX = 24;
const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];

function now() { return Date.now(); }
function uid() { return 'u' + crypto.randomBytes(6).toString('hex'); }
function token() { return crypto.randomBytes(24).toString('hex'); }
function nickClean(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F\u200B-\u200F]/g, '').trim().slice(0, NICK_MAX);
}
function hashPass(pass, salt, rounds) {
  const r = rounds || SCRYPT.N;
  return crypto.scryptSync(String(pass), Buffer.from(salt, 'hex'), SCRYPT.len, { N: r, r: 8, p: 1 }).toString('hex');
}
function timingEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function blankConfig(c = {}) {
  const kind = c.kind === 'bot' ? 'bot' : c.kind === 'me' ? 'me' : 'llm';
  return {
    id: 'c' + crypto.randomBytes(5).toString('hex'),
    name: String(c.name || (kind === 'llm' ? '我的模型' : kind === 'bot' ? '我的人机' : '我本人上阵')).slice(0, 40),
    kind,
    bot: kind === 'bot' ? String(c.bot || 'reader') : null,
    baseUrl: kind === 'llm' ? String(c.baseUrl || '').trim().slice(0, 300) : null,
    model: kind === 'llm' ? String(c.model || '').trim().slice(0, 120) : null,
    keyBox: null,                       // 密文；明文从不进这个对象
    thinking: !!c.thinking,
    effort: EFFORTS.includes(c.effort) ? c.effort : 'medium',
    maxTokens: Math.min(65536, Math.max(256, +c.maxTokens || 8192)),
    temperature: Math.min(2, Math.max(0, +c.temperature || 0.7)),
    guideText: kind === 'llm' ? cleanGuide(c.guideText) : '',      // 我的必胜秘诀
    note: String(c.note || '').slice(0, 120),
    createdAt: now(),
  };
}

class Accounts {
  constructor(dir, vault, opts = {}) {
    this.file = path.join(dir, 'users.json');
    this.vault = vault;
    this.opts = opts;
    this.data = { v: 1, users: {} };
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const d = JSON.parse(raw);
      if (d && typeof d === 'object' && d.users) this.data = { v: 1, users: d.users };
    } catch (e) { /* 首启没有文件 */ }
    this.byNickLower = new Map();
    for (const u of Object.values(this.data.users)) this.byNickLower.set(String(u.nickLower || '').toLowerCase(), u.id);
  }

  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const tmp = this.file + '.tmp';
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    }, 150);
    // 不 unref：150ms 的落盘定时器必须能把最后一次改动写下去（否则退出前丢账号/配置改动）
  }

  signup(nick, pass) {
    const n = nickClean(nick);
    if (n.length < 2) return { ok: false, reason: '昵称至少 2 个字符' };
    if (this.byNickLower.has(n.toLowerCase())) return { ok: false, reason: '这个昵称已经被占了' };
    if (String(pass || '').length < 6) return { ok: false, reason: '口令至少 6 位' };
    const salt = crypto.randomBytes(16).toString('hex');
    const rounds = SCRYPT.N;
    const u = {
      id: uid(), nick: n, nickLower: n.toLowerCase(),
      salt, rounds, hash: hashPass(pass, salt, rounds),
      createdAt: now(), lastSeenAt: now(),
      sessions: [], configs: [],
      prefs: { rules: 'flex', hpMax: 8, maxRounds: 60, turnMs: 45000, duplicate: true },
      stats: { wins: 0, losses: 0, draws: 0, games: 0 },
    };
    this.data.users[u.id] = u;
    this.byNickLower.set(n.toLowerCase(), u.id);
    const t = token();                       // 注册即登录：省一次口令往返
    u.sessions = [{ token: t, at: now(), until: now() + SESSION_MS }];
    this.save();
    return { ok: true, token: t, user: u };
  }

  login(nick, pass) {
    const id = this.byNickLower.get(String(nick || '').toLowerCase().trim());
    if (!id) return { ok: false, reason: '昵称或口令不对' };
    const u = this.data.users[id];
    if (!timingEq(hashPass(pass, u.salt, u.rounds), u.hash)) return { ok: false, reason: '昵称或口令不对' };
    const t = token();
    u.sessions = (u.sessions || []).filter(s => s.until > now()).slice(-8);
    u.sessions.push({ token: t, at: now(), until: now() + SESSION_MS });
    u.lastSeenAt = now();
    this.save();
    return { ok: true, token: t, user: u };
  }

  /* 小程序登录：openid 就是身份，用户不需要记口令。
     已有该 openid → 直接发会话；没有 → 建账号（口令随机、谁也不要知道，以后想用网页端登录再让用户重置）。
     昵称只作展示，重名自动加数字后缀，避免和网页端已注册的昵称撞车。 */
  loginByOpenid(openid, nick) {
    const open = String(openid || '').trim();
    if (!open) return { ok: false, reason: '缺少 openid' };
    let u = Object.values(this.data.users).find(x => x.wxOpenid === open) || null;
    if (!u) {
      let n = nickClean(nick);
      if (n.length < 2) n = '微信玩家' + open.slice(-4);
      const base = n;
      let i = 1;
      while (this.byNickLower.has(n.toLowerCase())) { n = (base + (++i)).slice(0, NICK_MAX); }
      const salt = crypto.randomBytes(16).toString('hex');
      u = {
        id: uid(), nick: n, nickLower: n.toLowerCase(), wxOpenid: open,
        salt, rounds: SCRYPT.N,
        hash: hashPass(crypto.randomBytes(24).toString('hex'), salt, SCRYPT.N),   // 占位：小程序不走口令
        createdAt: now(), lastSeenAt: now(),
        sessions: [], configs: [],
        prefs: { rules: 'flex', hpMax: 8, maxRounds: 60, turnMs: 45000, duplicate: true },
        stats: { wins: 0, losses: 0, draws: 0, games: 0 },
      };
      this.data.users[u.id] = u;
      this.byNickLower.set(u.nick.toLowerCase(), u.id);
    }
    const t = token();
    u.sessions = (u.sessions || []).filter(s => s.until > now()).slice(-8);
    u.sessions.push({ token: t, at: now(), until: now() + SESSION_MS });
    u.lastSeenAt = now();
    this.save();
    return { ok: true, token: t, user: u };
  }

  auth(t) {
    if (!t) return null;
    for (const u of Object.values(this.data.users)) {
      const s = (u.sessions || []).find(x => x.token === t && x.until > now());
      if (s) { s.at = now(); u.lastSeenAt = now(); this.save(); return u; }
    }
    return null;
  }
  logout(t) {
    for (const u of Object.values(this.data.users)) {
      const i = (u.sessions || []).findIndex(x => x.token === t);
      if (i >= 0) { u.sessions.splice(i, 1); this.save(); return true; }
    }
    return false;
  }

  // —— 上桌配置 ——
  upsertConfig(user, cfg) {
    const list = (user.configs = user.configs || []);
    const old = cfg.id ? list.find(c => c.id === cfg.id) : null;
    const next = Object.assign(old || blankConfig(cfg), blankConfig(cfg), {
      id: old ? old.id : (cfg.id || blankConfig().id),
      createdAt: old ? old.createdAt : now(),
    });
    if (next.kind === 'llm') {
      if (!next.baseUrl || !next.model) return { ok: false, reason: '模型配置需要 Base URL 与模型 ID' };
    }
    if (old) list[list.indexOf(old)] = next; else list.push(next);
    if (list.length > 24) list.splice(0, list.length - 24);
    this.save();
    return { ok: true, config: this.safeConfig(next) };
  }
  dropConfig(user, id) {
    const list = user.configs || [];
    const i = list.findIndex(c => c.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    this.save();
    return true;
  }
  // 明文 Key 只在本人请求时解密返回；日志与广播都不走这条路
  setKey(config, plainKey) {
    if (plainKey == null) return;
    const k = String(plainKey).trim();
    config.keyBox = k ? this.vault.encrypt(k) : null;
    this.save();
  }
  keyOf(config) {
    if (!config || !config.keyBox) return null;
    try { return this.vault.decrypt(config.keyBox); } catch (e) { return null; }
  }
  setPrefs(user, p = {}) {
    const d = { rules: 'flex', hpMax: 8, maxRounds: 60, turnMs: 45000, duplicate: true };
    const src = Object.assign({}, d, p);
    user.prefs = {
      rules: String(src.rules).slice(0, 40),
      hpMax: Math.min(40, Math.max(1, +src.hpMax || 8)),
      maxRounds: Math.min(300, Math.max(3, +src.maxRounds || 60)),
      turnMs: Math.min(600000, Math.max(5000, +src.turnMs || 45000)),
      duplicate: !!src.duplicate,
    };
    this.save();
    return user.prefs;
  }

  safeConfig(c) {
    return {
      id: c.id, name: c.name, kind: c.kind, bot: c.bot || null,
      baseUrl: c.baseUrl || null, model: c.model || null,
      hasKey: !!c.keyBox, keyMask: c.keyBox ? maskKey(this.keyOf(c)) : '',
      thinking: !!c.thinking, effort: c.effort, maxTokens: c.maxTokens, temperature: c.temperature,
      guideText: c.guideText || '', guideChars: (c.guideText || '').length, guideMax: GUIDE_MAX,
      note: c.note || '', createdAt: c.createdAt,
    };
  }
  // 下发给本人浏览器的 profile（Key 只有掩码）
  safe(user) {
    return {
      id: user.id, nick: user.nick, createdAt: user.createdAt, lastSeenAt: user.lastSeenAt,
      prefs: user.prefs || {}, stats: user.stats || {},
      configs: (user.configs || []).map(c => this.safeConfig(c)),
    };
  }
  configById(user, id) { return (user.configs || []).find(c => c.id === id) || null; }
  count() { return Object.keys(this.data.users).length; }
}

module.exports = { Accounts, blankConfig, nickClean, hashPass, SESSION_MS, EFFORTS, NICK_MAX };
