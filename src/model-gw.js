/* 出网策略（SSRF 防护）+ 模型调用归属
 * 云服务器替玩家调模型时，Base URL 是玩家填的——不管住就变成内网探测跳板：
 * 云厂商元数据（169.254.169.254 / metadata.google.internal）、内网网段、云服务器本机的其它端口，
 * 都能被一个「模型配置」戳到。这里做三件事：
 *   ① 协议与端口：只允许 http/https，端口默认 80/443/8xx-9xxx 之外要显式放行
 *   ② 地址解析后逐个判私网/保留段：环回、RFC1918、CGNAT、链路本地(元数据)、组播、IPv6 唯一本地/链路局部
 *   ③ 本机端点白名单：只有 DICE_LOCAL_PORTS 里列出的端口允许 127.0.0.1（自己的模型经代理转到云服务器时用的就是这条）
 * 已知残余风险：底层 fetch 会跟随重定向，恶意端点可用 302 把请求引到别的地址。
 * 公网部署强烈建议配 DICE_ALLOW_HOSTS 白名单（只允许已知厂商域名），或让模型出口走独立出网代理。
 */
'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const url = require('node:url');

const BLOCKED_HOSTNAMES = new Set([
  'metadata', 'metadata.google.internal', 'instance-data', 'metadata.google.internal.',
]);

function v4Parts(ip) {
  const m = String(ip).split('.');
  if (m.length !== 4) return null;
  const n = m.map(x => +x);
  if (n.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return n;
}

function blockedIPv4(ip) {
  const p = v4Parts(ip);
  if (!p) return '不是合法 IPv4';
  const [a, b] = p;
  if (a === 0) return '本机地址 0/8';
  if (a === 10) return '内网 10/8';
  if (a === 127) return '环回 127/8';
  if (a === 169 && b === 254) return '链路本地 169.254/16（云元数据常在这里）';
  if (a === 172 && b >= 16 && b <= 31) return '内网 172.16/12';
  if (a === 192 && b === 168) return '内网 192.168/16';
  if (a === 192 && b === 0) return '保留 192.0.0/24';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT 100.64/10';
  if (a === 198 && (b === 18 || b === 19)) return '基准测试 198.18/15';
  if (a >= 224) return '组播 / 保留';
  return null;
}

function blockedIPv6(ip) {
  const s = String(ip).toLowerCase();
  const mapped = s.match(/^::ffff:([0-9a-f.]+)$/);
  if (mapped) return blockedIPv4(mapped[1]) ? 'IPv4 映射地址' : null;
  if (s === '::' || s === '::1') return 'IPv6 环回 / 未指定';
  if (/^f[cd]/.test(s)) return 'IPv6 唯一本地 fc00::/7';
  if (/^fe[89ab]/.test(s)) return 'IPv6 链路局部 fe80::/10';
  return null;
}

function blockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return blockedIPv4(ip);
  if (v === 6) return blockedIPv6(ip);
  return '不是合法 IP';
}

function parseTarget(baseUrl) {
  let u;
  try { u = new url.URL(String(baseUrl || '').trim()); }
  catch (e) { return { ok: false, reason: 'Base URL 解析失败（要带 http:// 或 https://）' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: '只允许 http/https' };
  if (u.username || u.password) return { ok: false, reason: 'Base URL 里不要带账号密码' };
  const host = u.hostname.replace(/\[|\]/g, '');
  if (!host) return { ok: false, reason: 'Base URL 缺主机名' };
  const port = u.port ? +u.port : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: '端口不合理' };
  return { ok: true, proto: u.protocol, host, port, href: u.origin, pathname: u.pathname };
}

function normalizePolicy(p = {}) {
  return {
    // 允许戳本机端口的白名单（自己的模型经代理 / frp 转到云服务器时落在这些端口上）
    localPorts: (p.localPorts || []).map(Number).filter(Number.isInteger),
    // 主机名白名单（空 = 不按名字限制，只按地址策略）；公网部署建议填
    allowHosts: (p.allowHosts || []).map(s => String(s).toLowerCase().replace(/\.$/, '')).filter(Boolean),
    requireHttps: !!p.requireHttps,
    ports: (p.ports || []).map(Number).filter(Number.isInteger),
  };
}

/* 返回 {ok:true, host, ips, href} 或 {ok:false, reason}。
   注意：DNS 结果与实际请求之间仍有重绑定窗口；要更硬就把出网走独立代理 + 白名单。 */
async function checkEgress(baseUrl, policy = {}) {
  const P = normalizePolicy(policy);
  const t = parseTarget(baseUrl);
  if (!t.ok) return t;
  if (P.requireHttps && t.proto !== 'https:') return { ok: false, reason: '本服务器要求模型端点走 https' };
  if (P.ports.length && !P.ports.includes(t.port)) return { ok: false, reason: '端口 ' + t.port + ' 不在放行列表里' };
  const host = t.host.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: '该主机名被禁止（云元数据端点）' };

  const loopback = host === 'localhost' || host === '::1' || !!v4Parts(host) && v4Parts(host)[0] === 127;
  if (P.allowHosts.length) {
    const hit = P.allowHosts.some(h => host === h || host.endsWith('.' + h));
    if (!hit) return { ok: false, reason: '主机不在允许列表里（管理员可在 DICE_ALLOW_HOSTS 加）' };
  }
  if (loopback) {
    if (!P.localPorts.includes(t.port)) {
      return { ok: false, reason: '本机端点默认禁止。自己经代理转过来的模型，请管理员把端口 ' + t.port + ' 加进 DICE_LOCAL_PORTS' };
    }
    return { ok: true, host, ips: ['127.0.0.1'], href: t.href, loopback: true };
  }

  let ips = [];
  if (net.isIP(host)) ips = [host];
  else {
    try {
      const recs = await dns.lookup(host, { all: true, verbatim: true });
      ips = recs.map(r => r.address);
    } catch (e) {
      return { ok: false, reason: '域名解析失败：' + (e.code || e.message) };
    }
  }
  if (!ips.length) return { ok: false, reason: '域名没有解析结果' };
  for (const ip of ips) {
    const bad = blockedIp(ip);
    if (bad) return { ok: false, reason: '解析到被禁止的地址 ' + ip + '（' + bad + '）' };
  }
  return { ok: true, host, ips, href: t.href };
}

// 日志里只留这些：谁调了什么模型的哪个主机，绝不含 Key
function describeSeatForLog(spec = {}) {
  const host = (() => { try { return new url.URL(String(spec.baseUrl || '')).host; } catch (e) { return spec.source || '未知端点'; } })();
  return host + ' · ' + (spec.model || '未知模型');
}

module.exports = { checkEgress, parseTarget, normalizePolicy, blockedIp, describeSeatForLog, BLOCKED_HOSTNAMES };
