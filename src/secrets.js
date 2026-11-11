/* 密钥保管（实时对战平台）
 * 两件事分开：
 *  ① 账号里长期保存的模型 API Key：落盘必须加密。主密钥单独一个文件（0600，首启随机生成），
 *     密文进 users.json。解密只发生在内存里、只用于本人座位。
 *  ② 匿名玩家临时自带的 Key：只存进程内存，进程重启即失，绝不落盘、绝不写日志。
 * 任何下发给浏览器的 profile 都只带掩码（maskKey），除非本人显式要求取回明文。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '…' + s.slice(-4);
}

function loadMaster(dir, opts = {}) {
  const file = path.join(dir, 'secret.key');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) return Buffer.from(raw, 'base64');
  } catch (e) { /* 首启没有文件 */ }
  if (opts.readOnly) throw new Error('缺少 ' + file + '（只读模式下不会新建主密钥）');
  const k = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, k.toString('base64') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* 某些文件系统不支持 */ }
  return k;
}

class Vault {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.master = loadMaster(dir, opts);
    this.ephemeral = new Map();      // token → { obj, at }：临时 BYOK，仅内存
  }

  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, this.master, iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return 'v1.' + iv.toString('base64') + '.' + c.getAuthTag().toString('base64') + '.' + enc.toString('base64');
  }

  decrypt(box) {
    const parts = String(box || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式不对');
    const d = crypto.createDecipheriv(ALGO, this.master, Buffer.from(parts[1], 'base64'));
    d.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
  }

  // —— 临时 Key（匿名自带）：只活在这一桌 ——
  put(obj, ttlMs = 3 * 3600 * 1000) {
    const token = crypto.randomBytes(16).toString('hex');
    this.ephemeral.set(token, { obj, at: Date.now(), until: Date.now() + ttlMs });
    return token;
  }
  get(token) {
    const e = token && this.ephemeral.get(token);
    if (!e) return null;
    if (e.until < Date.now()) { this.ephemeral.delete(token); return null; }
    e.at = Date.now();
    return e.obj;
  }
  drop(token) { return this.ephemeral.delete(token); }
  sweep() {
    const now = Date.now();
    let n = 0;
    for (const [k, v] of this.ephemeral) if (v.until < now) { this.ephemeral.delete(k); n++; }
    return n;
  }
  size() { return this.ephemeral.size; }
}

module.exports = { Vault, maskKey, ALGO };
