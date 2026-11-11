const app = getApp();
const api = require('../../utils/api.js');
const store = require('../../utils/store.js');
const { BASE_URL, ENV } = require('../../config.js');
const apiMod = require('../../utils/api.js');

const KINDS = [
  { id: 'llm', label: '大模型' },
  { id: 'bot', label: '内置人机' },
  { id: 'me', label: '本人' },
];
const EFFORTS = [
  { id: 'off', label: '关' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
];

function blankForm() {
  return { id: '', src: '', kind: 'llm', name: '', bot: 'reader', baseUrl: '', model: '', apiKey: '', effort: 'medium', guideText: '', hasKey: false, keyMask: '' };
}

Page({
  data: {
    nick: '', logged: false, wxLogin: false, baseUrl: BASE_URL, liveBase: BASE_URL, baseUrlInput: '', env: ENV,
    configs: [], editing: false, form: blankForm(), formMsg: '', formMsgBad: false,
    kinds: KINDS, efforts: EFFORTS, bots: [], botDesc: '',
    rules: [], ruleNames: [], ruleIndex: 0, hp: 8, turnSec: 45, dup: true,
  },

  onShow() {
    this.setData({
      nick: wx.getStorageSync('nick') || '',
      logged: !!wx.getStorageSync('token'),
      liveBase: apiMod.baseUrl(),
      baseUrlInput: wx.getStorageSync('baseUrl') || '',
    });
    this.bootstrap();
  },

  async bootstrap() {
    try {
      const ping = await api.get('/api/ping');
      app.globalData.ping = ping;
      const rules = (ping.rules || []).map(r => ({ id: r.id, name: r.name }));
      this.setData({
        wxLogin: !!ping.wxLogin,
        bots: (ping.bots || []).map(b => ({ id: b.id, label: b.label, desc: b.desc })),
        rules, ruleNames: rules.map(r => r.name),
      });
    } catch (e) { /* 连不上时仍可编辑本地配置 */ }

    if (this.data.logged) await this.loadServer();
    this.loadConfigs();
  },

  async loadServer() {
    try {
      const r = await api.get('/api/me');
      const me = r.me;
      app.globalData.me = me;
      const p = me.prefs || {};
      const idx = Math.max(0, (this.data.rules || []).findIndex(x => x.id === (p.rules || 'flex')));
      this.setData({
        nick: me.nick || this.data.nick,
        hp: p.hpMax || 8,
        turnSec: Math.round((p.turnMs || 45000) / 1000),
        dup: p.duplicate !== false,
        ruleIndex: idx,
      });
    } catch (e) {
      if (e.status === 401) {
        wx.removeStorageSync('token');
        app.globalData.token = '';
        this.setData({ logged: false });
      }
    }
  },

  // 登录用服务端，没登录用本机；两种在这里合成同一个列表
  loadConfigs() {
    const list = [];
    if (this.data.logged && app.globalData.me) {
      for (const c of (app.globalData.me.configs || [])) {
        list.push({
          id: c.id, src: 'server', kind: c.kind, name: c.name,
          bot: c.bot, baseUrl: c.baseUrl, model: c.model,
          effort: c.effort, guideText: c.guideText, hasKey: c.hasKey, keyMask: c.keyMask,
          sub: this.subOf(c),
        });
      }
    } else {
      for (const c of store.list()) {
        list.push(Object.assign({}, c, { src: 'local', sub: this.subOf(c) }));
      }
    }
    this.setData({ configs: list });
  },

  subOf(c) {
    if (c.kind === 'bot') return '内置人机 · ' + (c.bot || 'reader');
    if (c.kind === 'me') return '本人手打';
    const bits = [c.model || '未填模型'];
    if (c.hasKey || c.apiKey) bits.push('有 Key');
    if (c.guideText) bits.push('秘诀 ' + c.guideText.length + ' 字');
    if (c.effort) bits.push('思考 ' + c.effort);
    return bits.join(' · ');
  },

  onNick(e) {
    const nick = e.detail.value;
    this.setData({ nick });
    wx.setStorageSync('nick', nick);
    app.globalData.nick = nick;
  },

  async onLogin() {
    if (!this.data.wxLogin) return wx.showToast({ title: '服务器没配 AppID', icon: 'none' });
    wx.login({
      success: async r => {
        try {
          const out = await api.post('/api/mini/login', { code: r.code, nick: this.data.nick });
          app.setSession(out.token, out.me);
          this.setData({ logged: true });
          await this.loadServer();
          this.loadConfigs();
          wx.showToast({ title: '登录成功' });
        } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
      },
      fail: () => wx.showToast({ title: '微信登录没走通', icon: 'none' }),
    });
  },

  async onLogout() {
    try { await api.post('/api/logout', {}); } catch (e) { }
    wx.removeStorageSync('token');
    app.globalData.token = ''; app.globalData.me = null;
    this.setData({ logged: false });
    this.loadConfigs();
  },

  /* ---------------- 配置编辑 ---------------- */
  onNew() {
    this.setData({ editing: true, form: blankForm(), formMsg: '', formMsgBad: false, botDesc: this.descOf('reader') });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    const c = this.data.configs.find(x => x.id === id);
    if (!c) return;
    this.setData({
      editing: true,
      form: Object.assign(blankForm(), c, { apiKey: '' }),
      formMsg: '', formMsgBad: false,
      botDesc: this.descOf(c.bot),
    });
  },

  onCancel() { this.setData({ editing: false, formMsg: '' }); },

  onPickKind(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ 'form.kind': k, 'formMsg': '' });
  },
  onPickBot(e) {
    const b = e.currentTarget.dataset.b;
    this.setData({ 'form.bot': b, botDesc: this.descOf(b) });
  },
  onPickEffort(e) { this.setData({ 'form.effort': e.currentTarget.dataset.e }); },
  onField(e) {
    const f = e.currentTarget.dataset.f;
    this.setData({ ['form.' + f]: e.detail.value });
  },

  onBaseUrl(e) { this.setData({ baseUrlInput: e.detail.value }); },
  onSaveBaseUrl() {
    const v = String(this.data.baseUrlInput || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(v)) return wx.showToast({ title: '要写 http:// 或 https://', icon: 'none' });
    wx.setStorageSync('baseUrl', v);
    this.setData({ liveBase: v });
    wx.showToast({ title: '已切换' });
    this.bootstrap();
  },
  onResetBaseUrl() {
    wx.removeStorageSync('baseUrl');
    this.setData({ liveBase: BASE_URL, baseUrlInput: '' });
    wx.showToast({ title: '已恢复' });
    this.bootstrap();
  },

  descOf(id) {
    const b = (this.data.bots || []).find(x => x.id === id);
    return b ? b.desc : '';
  },

  async onSave() {
    const f = this.data.form;
    const name = String(f.name || '').trim() || (f.kind === 'bot' ? '人机' : f.kind === 'me' ? '本人' : '我的模型');
    if (f.kind === 'llm' && (!f.baseUrl || !f.model)) {
      return this.setData({ formMsg: '模型要填 Base URL 和模型名', formMsgBad: true });
    }
    this.setData({ formMsg: '保存中…', formMsgBad: false });
    try {
      if (f.src === 'server' && this.data.logged) {
        await api.post('/api/profile/config', {
          config: {
            id: f.id || undefined, kind: f.kind, name, bot: f.bot,
            baseUrl: f.baseUrl, model: f.model, effort: f.effort, guideText: f.guideText,
          },
          key: f.apiKey || undefined,
        });
        await this.loadServer();
      } else {
        store.save({
          id: f.src === 'local' ? f.id : '', kind: f.kind, name, bot: f.bot,
          baseUrl: f.baseUrl, model: f.model, apiKey: f.apiKey || '', effort: f.effort,
          guideText: f.guideText,
        });
      }
      this.loadConfigs();
      this.setData({ editing: false, formMsg: '' });
      wx.showToast({ title: '已保存' });
    } catch (e) {
      this.setData({ formMsg: e.message, formMsgBad: true });
    }
  },

  async onDrop(e) {
    const id = e.currentTarget.dataset.id;
    const c = this.data.configs.find(x => x.id === id);
    if (!c) return;
    try {
      if (c.src === 'server') {
        await api.post('/api/profile/drop', { id });
        await this.loadServer();
      } else {
        store.drop(id);
      }
      this.loadConfigs();
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
  },

  /* ---------------- 默认桌规 ---------------- */
  onRule(e) { this.setData({ ruleIndex: +e.detail.value }); },
  onHp(e) { this.setData({ hp: e.detail.value }); },
  onTurn(e) { this.setData({ turnSec: e.detail.value }); },
  onDup(e) { this.setData({ dup: e.detail.value }); },

  async onSavePrefs() {
    const prefs = {
      rules: (this.data.rules[this.data.ruleIndex] || {}).id || 'flex',
      hpMax: +this.data.hp || 8,
      turnMs: (+this.data.turnSec || 45) * 1000,
      duplicate: !!this.data.dup,
    };
    if (this.data.logged) {
      try { await api.post('/api/profile/prefs', { prefs }); wx.showToast({ title: '已保存' }); }
      catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
    } else {
      wx.setStorageSync('prefs', prefs);
      wx.showToast({ title: '已存在本机' });
    }
  },
});
