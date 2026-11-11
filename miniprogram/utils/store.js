/* 本地配置（匿名模式用）
 * 登录后配置存在服务端（Key 是 AES 密文）；没登录就存在这台手机上 —— 明文，界面里要如实告知。
 * 两种来源在页面层合成同一个列表，上桌时用 seatSpec() 归一成服务端认识的座位格式。
 */
const KEY = 'localConfigs';

function uid() { return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function list() {
  const raw = wx.getStorageSync(KEY);
  return Array.isArray(raw) ? raw : [];
}

function save(cfg) {
  const all = list();
  const one = Object.assign({}, cfg);
  if (!one.id) one.id = uid();
  const i = all.findIndex(x => x.id === one.id);
  if (i >= 0) all[i] = Object.assign(all[i], one);
  else all.push(one);
  wx.setStorageSync(KEY, all);
  return one;
}

function drop(id) {
  wx.setStorageSync(KEY, list().filter(x => x.id !== id));
}

module.exports = { list, save, drop, uid };
