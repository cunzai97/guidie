#!/usr/bin/env node
/* 测试用的零依赖 fetch 替身（node:http 实现，只覆盖本项目测试真正用到的形状）。
 *
 * 为什么需要：有些机器的沙箱把 RLIMIT_AS 卡在 4 GiB，Node 22/24 的 undici fetch
 * 会在 WebAssembly.instantiate(llhttp) 处抛
 *   RangeError: Out of memory: Cannot allocate Wasm memory for new instance
 * 连 fetch('http://127.0.0.1/...') 都跑不了。node:http 用的是原生 llhttp，
 * 不走 wasm，因此不受影响。
 *
 * 实现的是 fetch 的最小子集：method / headers / string body / AbortSignal，
 * 以及 Response 的 status / ok / json() / text()。本项目所有 fetch 测试只用到这些。
 * 调用 install() 才覆盖 globalThis.fetch；不调用就完全不碰运行时。
 */
'use strict';
const http = require('node:http');
const https = require('node:https');

function fetchHttp(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = opts.body;
    const headers = Object.assign({}, opts.headers || {});
    if (body != null) headers['content-length'] = Buffer.byteLength(String(body));
    const req = lib.request(u, { method: opts.method || 'GET', headers }, res => {
      // 收到响应头就 resolve，SSE 这类长连接才能立刻拿到 r.body 开始读流。
      // json() / text() 另等一个「流结束」的 Promise。
      const chunks = [];
      let endResolve, endReject;
      const done = new Promise((a, b) => { endResolve = a; endReject = b; });
      // SSE 请求不会调 json()/text()，abort 时 done 会被 reject；不挂这个空 catch
      // 就会变成 unhandled rejection 把进程炸掉。
      done.catch(() => { });
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => endResolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', endReject);
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        body: res,                                   // Readable，支持 for await（SSE 测试用）
        json: async () => { try { return JSON.parse(await done); } catch (e) { return null; } },
        text: async () => done,
      });
    });
    req.on('error', reject);
    const sig = opts.signal;
    if (sig) {
      if (sig.aborted) { req.destroy(); return reject(new Error('aborted')); }
      const onAbort = () => req.destroy(new Error('aborted'));
      sig.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => sig.removeEventListener('abort', onAbort));
    }
    if (body != null) req.write(String(body));
    req.end();
  });
}

function install() { globalThis.fetch = fetchHttp; }
module.exports = { fetchHttp, install };
