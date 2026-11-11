/* 小程序全局状态：只放「跨页面还要用」的东西。
 * 会话令牌 / 昵称 / 每桌的座位令牌 全部落在本地存储，不做共享登录态缓存以外的加工。
 */
const { BASE_URL } = require('./config.js');

App({
  globalData: {
    baseUrl: BASE_URL,
    token: '',          // 平台会话（Bearer）；匿名也能玩，只是存不了模型配置
    nick: '',
    me: null,
    ping: null,
    enterRoom: '',      // 冷启动 / 分享进入时带的房号
    lastResult: null,   // 上一把结算，用于「再来一局」提示
  },

  onLaunch(options) {
    const g = this.globalData;
    g.token = wx.getStorageSync('token') || '';
    g.nick = wx.getStorageSync('nick') || '';
    // 分享卡片带 ?room=CODE 进来：先把房号存下，首页 onShow 会自己跳过去
    const q = (options && options.query) || {};
    if (q.room) g.enterRoom = String(q.room).toUpperCase();
    // 热启动（小程序没被杀掉，点卡片进来）走 onShow 的分支
    this._pendingRoom = g.enterRoom;
  },

  onShow(options) {
    const q = (options && options.query) || {};
    if (q.room) {
      this.globalData.enterRoom = String(q.room).toUpperCase();
      this.enterRoomIfIdle();
    }
  },

  // 当前在首页才自动跳，避免把正在打牌的人顶出牌桌
  enterRoomIfIdle() {
    const pages = getCurrentPages();
    const top = pages.length ? pages[pages.length - 1].route : '';
    if (top === 'pages/index/index' && this.globalData.enterRoom) {
      wx.navigateTo({ url: '/pages/table/table?room=' + this.globalData.enterRoom });
      this.globalData.enterRoom = '';
    }
  },

  setSession(token, me) {
    this.globalData.token = token || '';
    this.globalData.me = me || null;
    if (me && me.nick) { this.globalData.nick = me.nick; wx.setStorageSync('nick', me.nick); }
    wx.setStorageSync('token', this.globalData.token);
  },

  // 每桌一个座位令牌：换房间、换设备都不影响别的桌
  seatToken(code) { return wx.getStorageSync('seat:' + code) || ''; },
  setSeatToken(code, token) { if (token) wx.setStorageSync('seat:' + code, token); },
});
