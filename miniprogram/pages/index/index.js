const app = getApp();
const api = require('../../utils/api.js');
const F = require('../../utils/fmt.js');
const store = require('../../utils/store.js');
const { seatSpec } = require('../../utils/seat.js');
const { BASE_URL, ENV } = require('../../config.js');

const B_KINDS = [
  { id: 'open', label: '等朋友' },
  { id: 'bot', label: '人机练手' },
  { id: 'llm', label: '我的模型' },
  { id: 'preset', label: '平台预设' },
];

Page({
  data: {
    nick: '', env: ENV, baseUrl: BASE_URL, pingOk: false, wxLogin: false,
    rules: [], ruleNames: [], ruleIndex: 0,
    hp: 8, turnSec: 45, dup: true, pass: '',
    code: '', joinPass: '',
    bKinds: B_KINDS, bKind: 'open',
    bots: [], botNames: [], botIndex: 0,
    cfgs: [], cfgNames: [], cfgIndex: 0,
    presets: [], presetNames: [], presetIndex: 0,
    rooms: [], matches: [],
    msg: '', msgBad: false, busy: false, joining: false,
  },

  onLoad() {
    this.setData({ nick: wx.getStorageSync('nick') || '' });
    this.bootstrap();
  },

  onShow() {
    // 点分享卡片 / 冷启动带房号进来：直接进桌，不让人再输一遍房号
    const room = app.globalData.enterRoom;
    if (room) {
      app.globalData.enterRoom = '';
      this.gotoTable(room, '');
    }
    if (!this.data.pingOk) this.bootstrap();
    else { this.loadRooms(); this.loadMatches(); this.refreshConfigs(); }
  },

  async bootstrap() {
    try {
      const ping = await api.get('/api/ping');
      app.globalData.ping = ping;
      const rules = (ping.rules || []).map(r => ({ id: r.id, name: r.name }));
      const bots = (ping.bots || []).map(b => ({ id: b.id, label: b.label, desc: b.desc }));
      const presets = (ping.models || []).map(m => ({ id: m.id, label: m.alias || m.model, host: m.host }));
      this.setData({
        pingOk: true, rules, ruleNames: rules.map(r => r.name), wxLogin: !!ping.wxLogin,
        bots, botNames: bots.map(b => b.label),
        presets, presetNames: presets.map(p => p.label + (p.host ? ' · ' + p.host : '')),
        msg: '', msgBad: false,
      });
      this.refreshConfigs();
      this.loadRooms();
      this.loadMatches();
      if (ping.wxLogin) this.tryWxLogin();
    } catch (e) {
      this.setData({ pingOk: false, msg: e.message, msgBad: true });
    }
  },

  // 服务端配了 DICE_WX_APPID / DICE_WX_SECRET 才走微信登录；没配就匿名，功能一样，只是存不了模型配置
  tryWxLogin() {
    if (wx.getStorageSync('token')) return;
    wx.login({
      success: async r => {
        if (!r.code) return;
        try {
          const out = await api.post('/api/mini/login', { code: r.code, nick: this.data.nick || wx.getStorageSync('nick') || '' });
          if (out && out.token) app.setSession(out.token, out.me);
          if (out && out.me && out.me.nick && !this.data.nick) this.setData({ nick: out.me.nick });
        } catch (e) { /* 登录失败就匿名上桌，不拦 */ }
      },
    });
  },

  // 乙方座位：空位等朋友 / 内置人机练手 / 我自己的模型 / 平台预设
  async refreshConfigs() {
    let list = [];
    if (wx.getStorageSync('token')) {
      if (!app.globalData.me) {
        try { const r = await api.get('/api/me'); app.globalData.me = r.me; } catch (e) { }
      }
      list = ((app.globalData.me || {}).configs || [])
        .filter(c => c.kind !== 'me')
        .map(c => ({
          id: c.id, src: 'server', kind: c.kind, name: c.name, bot: c.bot,
          model: c.model, configId: c.id, baseUrl: c.baseUrl, guideText: c.guideText, hasKey: c.hasKey,
        }));
    } else {
      list = store.list().filter(c => c.kind !== 'me').map(c => Object.assign({ src: 'local' }, c));
    }
    const names = list.map(c => c.name + ' · ' + (c.kind === 'bot' ? (c.bot || '人机') : (c.model || '模型')));
    this.setData({
      cfgs: list, cfgNames: names,
      cfgIndex: Math.max(0, Math.min(this.data.cfgIndex, names.length - 1)),
    });
  },

  async buildSeatB(nick) {
    const k = this.data.bKind;
    if (k === 'open') return { kind: 'open' };
    if (k === 'bot') {
      const b = this.data.bots[this.data.botIndex];
      if (!b) throw new Error('服务器没给出内置人机列表');
      return { kind: 'bot', bot: b.id };
    }
    if (k === 'preset') {
      const p = this.data.presets[this.data.presetIndex];
      if (!p) throw new Error('没有可选的平台预设模型');
      return { kind: 'preset', presetId: p.id };
    }
    const c = this.data.cfgs[this.data.cfgIndex];
    if (!c) throw new Error('还没有模型配置，去「我的」新建一条');
    return seatSpec(c, nick);
  },

  onPickBKind(e) { this.setData({ bKind: e.currentTarget.dataset.k }); },
  onBotIdx(e) { this.setData({ botIndex: +e.detail.value }); },
  onCfgIdx(e) { this.setData({ cfgIndex: +e.detail.value }); },
  onPresetIdx(e) { this.setData({ presetIndex: +e.detail.value }); },

  onNick(e) { this.setData({ nick: e.detail.value }); },
  onRule(e) { this.setData({ ruleIndex: +e.detail.value }); },
  onHp(e) { this.setData({ hp: e.detail.value }); },
  onTurn(e) { this.setData({ turnSec: e.detail.value }); },
  onDup(e) { this.setData({ dup: e.detail.value }); },
  onPass(e) { this.setData({ pass: e.detail.value }); },
  onCode(e) { this.setData({ code: e.detail.value.toUpperCase() }); },
  onJoinPass(e) { this.setData({ joinPass: e.detail.value }); },

  toast(t) { wx.showToast({ title: t, icon: 'none' }); },

  async onCreate() {
    const nick = String(this.data.nick || '').trim();
    if (!nick) return this.toast('先填个昵称');
    if (this.data.busy) return;
    this.setData({ busy: true, msg: '' });
    try {
      const rule = this.data.rules[this.data.ruleIndex];
      const seatB = await this.buildSeatB(nick);
      const r = await api.post('/api/room/create', {
        title: '',
        seats: { A: { kind: 'me', nick }, B: seatB },
        rules: rule ? rule.id : 'flex',
        hpMax: +this.data.hp || 8,
        turnMs: (+this.data.turnSec || 45) * 1000,
        duplicate: !!this.data.dup,
        pass: this.data.pass || null,
      });
      wx.setStorageSync('nick', nick);
      app.globalData.nick = nick;
      app.setSeatToken(r.code, r.you && r.you.token);
      this.gotoTable(r.code, 'A');
    } catch (e) {
      this.setData({ msg: e.message, msgBad: true });
    } finally {
      this.setData({ busy: false });
    }
  },

  async onJoin() {
    const code = String(this.data.code || '').trim().toUpperCase();
    if (!code) return this.toast('先填房号');
    if (this.data.joining) return;
    const nick = String(this.data.nick || '').trim() || '玩家';
    this.setData({ joining: true, msg: '' });
    try { await this.joinAndGo(code, nick, this.data.joinPass || null); }
    catch (e) { this.setData({ msg: e.message, msgBad: true }); }
    finally { this.setData({ joining: false }); }
  },

  onQuickJoin(e) {
    const code = e.currentTarget.dataset.code;
    const nick = String(this.data.nick || '').trim() || '玩家';
    this.setData({ code });
    this.joinAndGo(code, nick, null).catch(err => this.toast(err.message));
  },

  // 先试乙方（朋友位）再试甲方；都不行就观战——不让「进不去」变成死路
  async joinAndGo(code, nick, pass) {
    let got = null, lastErr = '';
    for (const seat of ['B', 'A']) {
      try { got = await api.post('/api/room/join', { code, seat, nick, pass }); break; }
      catch (e) { lastErr = e.message; }
    }
    wx.setStorageSync('nick', nick);
    app.globalData.nick = nick;
    if (got) {
      app.setSeatToken(code, got.token);
      this.gotoTable(code, got.seat);
      return;
    }
    this.toast('以观战进入：' + (lastErr || '没有空位'));
    this.gotoTable(code, 'spec');
  },

  gotoTable(code, seat) {
    wx.navigateTo({ url: '/pages/table/table?room=' + code + (seat ? '&seat=' + seat : '') });
  },

  async loadRooms() {
    try {
      const r = await api.get('/api/rooms');
      const rooms = (r.rooms || []).map(x => ({
        code: x.code, title: x.title || '', rulesId: x.rulesId, hpMax: x.hpMax,
        seatsText: (x.seats.A === 'open' ? '甲空' : '甲有人') + ' / ' + (x.seats.B === 'open' ? '乙空' : '乙有人'),
      }));
      this.setData({ rooms });
    } catch (e) { /* 列表拉不到不影响开桌 */ }
  },

  async loadMatches() {
    try {
      const r = await api.get('/api/matches?limit=8');
      const me = this.data.nick;
      const matches = (r.matches || []).map((m, i) => {
        const a = (m.seats && m.seats.A) || {}, b = (m.seats && m.seats.B) || {};
        const win = m.draw ? null : m.winner;
        const aName = a.alias || '甲', bName = b.alias || '乙';
        return {
          idx: i, time: F.hhmm(m.t),
          rulesName: (m.rules && m.rules.name) || '',
          aName, bName,
          resultText: m.draw ? '平' : (win ? (win === 'A' ? aName : bName) + ' 胜' : '—'),
          win: !!win && me && ((win === 'A' && aName === me) || (win === 'B' && bName === me)),
        };
      });
      this.setData({ matches });
    } catch (e) { }
  },

  onShareAppMessage() {
    // 首页分享出去的是「来打鬼骰」，进桌分享才带房号
    return { title: '鬼骰 · 来一局大话骰', path: '/pages/index/index' };
  },
});
