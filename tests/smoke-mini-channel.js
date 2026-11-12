#!/usr/bin/env node
/* 小程序通道的端到端冒烟：把 realtime.js 原样搬到 Node 里，对着真服务打几手。
 *
 * 验的是「小程序端那层代码」而不是协议本身：
 *   - wx.request 适配层能跑通长轮询
 *   - 游标单调推进，同一事件不会重复交给页面
 *   - ask 到达后按 view.legal 提交，服务端接受
 *   - abort（页面 onHide）能真的停掉挂起请求
 *
 * 用法：node tests/smoke-mini-channel.js
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.dirname(__dirname);
const PORT = 19100 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dice-chan-'));

let pass = 0, fail = 0;
const ok = (c, n, e) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 240) : '')); }
};

// —— 把小程序运行时要的东西最小化：只实现真正用到的那几个 wx API ——
function installWxShim() {
  global.wx = {
    // 页面里存的服务器地址优先（和真机上「我的」页改地址走同一条路）
    getStorageSync: k => (k === 'baseUrl' ? BASE : ''),
    setStorageSync() { }, removeStorageSync() { },
    request(o) {
      const ctl = new AbortController();
      const opts = { method: o.method || 'GET', headers: o.header || {}, signal: ctl.signal };
      if (o.data !== undefined && (o.method || 'GET').toUpperCase() !== 'GET') opts.body = JSON.stringify(o.data);
      fetch(o.url, opts)
        .then(async r => {
          const body = await r.json().catch(() => null);
          o.success({ statusCode: r.status, data: body });
        })
        .catch(e => {
          if (ctl.signal.aborted) return;
          o.fail({ errMsg: 'request:fail ' + (e && e.message || e) });
        });
      return { abort() { ctl.abort(); } };
    },
    setNavigationBarTitle() { },
  };
}

async function call(method, p, body) {
  const r = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('· 小程序通道端到端（端口 ' + PORT + '）');
  const child = spawn(process.execPath, [path.join(ROOT, 'src/room-server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DICE_DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await call('GET', '/api/ping'); if (r.status === 200) break; } catch (e) { }
      await sleep(100);
    }

    installWxShim();
    const { createChannel } = require(path.join(ROOT, 'miniprogram/utils/realtime.js'));

    // 甲是我（真人），乙交给内置人机：这样只需要一个客户端就能把整把推下去
    const cr = await call('POST', '/api/room/create', {
      rules: 'flex', hpMax: 4, turnMs: 20000, duplicate: false,
      seats: { A: { kind: 'me', nick: '测试甲' }, B: { kind: 'bot', bot: 'reader' } },
    });
    ok(cr.status === 200, '建桌成功', cr.body);
    const code = cr.body.code, token = cr.body.you.token;

    // 邀请制建桌乙方是空位：房主把内置人机放上去（放上即自动准备），真人这边自己点准备
    const placed = await call('POST', '/api/room/place', { code, seat: 'B', host: cr.body.host, seatSpec: { kind: 'bot', bot: 'reader' } });
    ok(placed.status === 200, '房主把内置人机放上乙方', placed.body);
    const rd = await call('POST', '/api/room/ready', { code, seat: 'A', token, ready: true });
    ok(rd.status === 200, '甲点准备', rd.body);
    const st = await call('POST', '/api/room/start', { code, token });
    ok(st.status === 200, '开局成功', st.body);

    const seen = new Set();
    const asks = [];
    let lastView = null;
    let dupEvents = 0;
    let statuses = [];
    let submitting = false;
    let finished = null;

    const chan = createChannel({
      code, role: 'A', token,
      onStatus: s => statuses.push(s),
      onView: v => { lastView = v; },
      onEvents(evs) {
        for (const e of evs) {
          if (seen.has(e.id)) dupEvents++;
          seen.add(e.id);
          const p = e.payload || {};
          if (e.type === 'ask') asks.push(p);
          if (e.type === 'matchover') finished = p;
          if (e.type === 'ask' && !submitting && p.view && p.view.legal && p.view.legal.length) {
            submitting = true;
            // 挑一个合法加价；没有就开盅——完全按服务端给的 legal 走
            const bid = p.view.legal.find(a => a.type === 'bid');
            const act = bid || p.view.legal.find(a => a.type === 'open');
            setTimeout(async () => {
              const r = await call('POST', '/api/room/action', { code, seat: 'A', token, action: act });
              if (r.status !== 200) console.log('    提交被拒：' + JSON.stringify(r.body));
              submitting = false;
            }, 30);
          }
        }
      },
      onGone: () => { },
    });

    chan.start();
    await sleep(300);
    ok(statuses.includes('online'), '通道上线', statuses);
    ok(chan.cursor > 0, '拿到了游标', chan.cursor);

    // 最多等 12 秒 / 20 手，够把 4 血打完
    const t0 = Date.now();
    while (!finished && Date.now() - t0 < 12000) await sleep(120);

    ok(asks.length >= 2, '收到多次 ask（轮到我）', asks.length);
    ok(!!finished, '整桌打完并收到 matchover', { asks: asks.length, ms: Date.now() - t0 });
    ok(dupEvents === 0, '同一事件没有重复下发', dupEvents);
    ok(lastView && Array.isArray(lastView.dice) && lastView.dice.length === 5, '最新视角里是 5 颗骰子', lastView && lastView.dice);
    ok(asks.every(a => a.view && Array.isArray(a.view.legal)), '每次 ask 都带合法动作集');
    ok(asks.every(a => a.seat === 'A' || a.you === 'A'), 'ask 只投给甲');

    // abort 要真的停：stop 之后不应再产生新请求
    const before = seen.size;
    chan.stop();
    await sleep(600);
    ok(chan.running === false, 'stop() 后通道停止');
    ok(seen.size === before || seen.size - before < 3, '停止后不再堆积事件', { before, after: seen.size });

    // 再起一次：新通道从 since=0 起，应该能立刻拿到房间现状而不是空白
    const chan2 = createChannel({ code, role: 'A', token, onEvents() { }, onView() { } });
    let got2 = 0;
    chan2.start();
    await sleep(500);
    got2 = chan2.cursor;
    ok(got2 > 0, '重连能接上（游标非 0）', got2);
    chan2.stop();

    // 越权：换个错令牌，页面层应当拿到 403 而不是别人的视角
    const bad = await call('GET', '/api/room/' + code + '/poll?role=A&token=bad&since=0&wait=0');
    ok(bad.status === 403, '错令牌的 poll 被拒', bad.status);

  } catch (e) {
    fail++;
    console.log('  ✗ 冒烟异常：' + (e && e.stack || e));
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { }
  }

  console.log('\n' + (fail ? 'FAIL' : 'ALL PASS') + '  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('\n服务端日志：\n' + log.split('\n').slice(-25).join('\n'));
  process.exit(fail ? 1 : 0);
})();
