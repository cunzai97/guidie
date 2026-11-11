/* 接口封装：所有请求都从这里出，令牌、超时、报错口径统一。
 * 小程序没有 cookie，会话走 Authorization: Bearer（服务端 sessionToken() 已支持）。
 */
const { BASE_URL, REQUEST_TIMEOUT_MS } = require('../config.js');

// 运行时可以覆盖服务器地址（「我的」页里能改，存本地）：上线换域名、临时连别人的服务都不用重新发版
function baseUrl() {
  try {
    const v = wx.getStorageSync('baseUrl');
    if (v && /^https?:\/\//.test(v)) return String(v).replace(/\/+$/, '');
  } catch (e) { /* 读不到就用内置的 */ }
  return BASE_URL;
}

function headers() {
  const h = { 'content-type': 'application/json' };
  const t = wx.getStorageSync('token');
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}

function request(path, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : baseUrl() + path;
  return new Promise((resolve, reject) => {
    const task = wx.request({
      url,
      method: opts.method || 'GET',
      data: opts.data,
      timeout: opts.timeout || REQUEST_TIMEOUT_MS,
      header: headers(),
      success(res) {
        const code = res.statusCode;
        if (code >= 200 && code < 300) return resolve(res.data);
        const body = res.data || {};
        const err = new Error(body.error || ('请求失败 HTTP ' + code));
        err.status = code;
        err.body = body;
        reject(err);
      },
      fail(raw) {
        const timeout = raw && raw.errMsg && /timeout/i.test(raw.errMsg);
        const err = new Error(timeout ? '网络超时，检查一下服务器地址' : '连不上服务器（' + ((raw && raw.errMsg) || '') + '）');
        err.network = true;
        err.raw = raw;
        reject(err);
      },
    });
    if (opts.onTask) opts.onTask(task);   // 长轮询要能被 stop() 主动 abort
  });
}

module.exports = {
  get: (p, o) => request(p, Object.assign({ method: 'GET' }, o)),
  post: (p, data, o) => request(p, Object.assign({ method: 'POST', data }, o)),
  baseUrl,
  BASE_URL,
};
