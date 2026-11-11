/* 接口封装：所有请求都从这里出，令牌、超时、报错口径统一。
 * 小程序没有 cookie，会话走 Authorization: Bearer（服务端 sessionToken() 已支持）。
 *
 * 两种传输：
 *   http  —— wx.request 打你自己的地址（局域网 IP / 服务器 IP / 备案域名）
 *   cloud —— wx.cloud.callContainer 打微信云托管的内网通道
 *            不走公网域名，所以免域名、免备案、免 request 合法域名配置；
 *            代价是客户端超时上限 15s，长轮询挂起时间要压到 10s 以内。
 */
const CFG = require('../config.js');

const CLOUD_HARD_TIMEOUT = 15000;   // callContainer 官方硬限制，超过直接报错

// 运行时可以覆盖：'我的' 页里能切，换通道不用改代码重发版
function kind() {
  try {
    const v = wx.getStorageSync('transport');
    if (v === 'http' || v === 'cloud') return v;
  } catch (e) { /* 读不到就用内置的 */ }
  return CFG.TRANSPORT || 'http';
}

function cloudReady() {
  return !!(typeof wx !== 'undefined' && wx.cloud && CFG.CLOUD && CFG.CLOUD.env && CFG.CLOUD.service);
}

// 运行时地址（只有 http 模式用得上）
function baseUrl() {
  try {
    const v = wx.getStorageSync('baseUrl');
    if (v && /^https?:\/\//.test(v)) return String(v).replace(/\/+$/, '');
  } catch (e) { /* 读不到就用内置的 */ }
  return CFG.BASE_URL;
}

// 长轮询参数：cloud 模式自动收紧，别让客户端先超时
function pollWait() {
  return kind() === 'cloud' ? CFG.CLOUD_WAIT_MS : CFG.POLL_WAIT_MS;
}
function pollTimeout(wait) {
  const w = wait || pollWait();
  return kind() === 'cloud' ? Math.min(CLOUD_HARD_TIMEOUT, w + 4000) : w + 8000;
}

function headers() {
  const h = { 'content-type': 'application/json' };
  const t = wx.getStorageSync('token');
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}

let cloudInited = false;
function initCloud() {
  if (cloudInited) return;
  wx.cloud.init({ env: CFG.CLOUD.env, traceUser: false });
  cloudInited = true;
}

// 把微信的 errMsg 翻译成「下一步该干什么」，别让人对着原始报错猜
function wrapFail(raw) {
  const msg = String((raw && (raw.errMsg || raw.message)) || '');
  let err;
  if (/domain list|合法域名|not in domain|url not in/i.test(msg)) {
    err = new Error('这个地址没在小程序后台登记。开发版/体验版可以绕过：右上角 ··· → 开发调试 → 打开调试，重进一次；正式上线必须换成备案域名。');
    err.domain = true;
  } else if (/timeout/i.test(msg)) {
    err = new Error('网络超时，检查一下服务器地址和网络');
    err.network = true;
  } else if (/cloud\.callContainer|env|未开通/i.test(msg)) {
    err = new Error('云托管通道不可用：检查 config.js 的 CLOUD.env / CLOUD.service，以及云环境是否已开通');
    err.cloud = true;
  } else {
    err = new Error('连不上服务器（' + msg + '）');
    err.network = true;
  }
  err.raw = raw;
  return err;
}

function sendHttp(path, opts) {
  const url = /^https?:\/\//.test(path) ? path : baseUrl() + path;
  return new Promise((resolve, reject) => {
    const task = wx.request({
      url,
      method: opts.method || 'GET',
      data: opts.data,
      timeout: opts.timeout || CFG.REQUEST_TIMEOUT_MS,
      header: Object.assign(headers(), opts.header),
      success(res) {
        const code = res.statusCode;
        if (code >= 200 && code < 300) return resolve(res.data);
        const body = res.data || {};
        const err = new Error(body.error || ('请求失败 HTTP ' + code));
        err.status = code;
        err.body = body;
        reject(err);
      },
      fail(raw) { reject(wrapFail(raw)); },
    });
    if (opts.onTask) opts.onTask(task);   // 长轮询要能被 stop() 主动 abort
  });
}

function sendCloud(path, opts) {
  // callContainer 只收相对路径，不接受域名；query 直接拼在 path 上（官方文档：path 可含参数）
  let p = path;
  const m = /^https?:\/\/[^/]+(\/.*)$/.exec(p);
  if (m) p = m[1];
  if (p[0] !== '/') p = '/' + p;

  // 刻意不把 timeout 传给 SDK：官方文档对它的上限说法不一致（一处写 15s，一处写 1500ms），
  // 与其赌，不如不传。请求在 10s 内由服务端 wait 主动返回，下面自己再兜一层超时。
  const budget = Math.min(CLOUD_HARD_TIMEOUT, (opts.timeout || CFG.REQUEST_TIMEOUT_MS) + 2000);

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };

    // 官方限制 15s，网络抖动时自己再兜一层，避免请求永远挂着
    const timer = setTimeout(() => {
      finish(reject, wrapFail({ errMsg: 'cloud.callContainer:fail timeout' }));
    }, budget + 2000);

    try { initCloud(); } catch (e) {
      clearTimeout(timer);
      return finish(reject, wrapFail({ errMsg: 'cloud.init fail: ' + (e && e.message) }));
    }

    try {
      wx.cloud.callContainer({
        config: { env: CFG.CLOUD.env },
        path: p,
        method: opts.method || 'GET',
        data: opts.data,
        header: Object.assign(headers(), { 'X-WX-SERVICE': CFG.CLOUD.service }, opts.header),
        success(res) {
          clearTimeout(timer);
          const code = res.statusCode;
          if (code >= 200 && code < 300) return finish(resolve, res.data);
          const body = res.data || {};
          const err = new Error(body.error || ('请求失败 HTTP ' + code));
          err.status = code;
          err.body = body;
          finish(reject, err);
        },
        fail(raw) {
          clearTimeout(timer);
          finish(reject, wrapFail(raw));
        },
      });
    } catch (e) {
      clearTimeout(timer);
      finish(reject, wrapFail({ errMsg: 'cloud.callContainer 调用失败: ' + (e && e.message) }));
    }
  });
}

function request(path, opts = {}) {
  if (kind() === 'cloud') {
    if (!cloudReady()) {
      return Promise.reject(Object.assign(
        new Error('选了云托管通道，但 config.js 里的 CLOUD.env / CLOUD.service 还没填'), { cloud: true }));
    }
    return sendCloud(path, opts);
  }
  return sendHttp(path, opts);
}

module.exports = {
  get: (p, o) => request(p, Object.assign({ method: 'GET' }, o)),
  post: (p, data, o) => request(p, Object.assign({ method: 'POST', data }, o)),
  baseUrl,
  kind,
  pollWait,
  pollTimeout,
  cloudReady,
  BASE_URL: CFG.BASE_URL,
};
