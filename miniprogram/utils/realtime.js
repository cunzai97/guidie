/* 长轮询通道：把服务端的 room.events 一条条搬到页面里。
 *
 * 为什么不是 WebSocket：小程序支持 wx.connectSocket，但 wss 也要配 socket 合法域名，
 * 且服务端要加 upgrade 处理与心跳；长轮询复用现有 HTTP 与同一把座位令牌，先跑通再升级。
 * 协议没变：事件类型、payload、可见性全由服务端决定，这里只负责「拉到就交出去」。
 */
const api = require('./api.js');
const { POLL_WAIT_MS } = require('../config.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createChannel(opt) {
  const code = String(opt.code || '').toUpperCase();
  const role = opt.role === 'A' || opt.role === 'B' ? opt.role : 'spec';
  const token = opt.token || '';
  const wait = opt.wait || POLL_WAIT_MS;
  const qs = 'role=' + role + (token ? '&token=' + encodeURIComponent(token) : '');

  let cursor = 0;
  let stopped = true;
  let task = null;
  let failures = 0;

  async function pump() {
    while (!stopped) {
      try {
        const r = await api.get('/api/room/' + code + '/poll?' + qs + '&since=' + cursor + '&wait=' + wait, {
          timeout: wait + 8000,
          onTask: t => { task = t; },
        });
        if (stopped) return;
        const next = typeof r.cursor === 'number' ? r.cursor : cursor;
        cursor = Math.max(cursor, next);
        failures = 0;
        if (opt.onStatus) opt.onStatus('online');
        if (r.room && opt.onRoom) opt.onRoom(r.room);
        if (r.view && opt.onView) opt.onView(r.view);
        if (r.events && r.events.length && opt.onEvents) opt.onEvents(r.events);
      } catch (e) {
        if (stopped) return;
        failures++;
        if (opt.onStatus) opt.onStatus('offline', e);
        // 404 说明桌被回收了，没必要再退避重连
        if (e && e.status === 404) { if (opt.onGone) opt.onGone(e); return; }
        await sleep(Math.min(8000, 600 * Math.pow(1.6, Math.min(failures, 6))));
      }
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      failures = 0;
      pump();
    },
    stop() {
      stopped = true;
      if (task && task.abort) { try { task.abort(); } catch (e) { } }
      task = null;
    },
    get cursor() { return cursor; },
    get running() { return !stopped; },
  };
}

module.exports = { createChannel };
