/* 牌桌：一页装下大厅 + 对局 + 结算。
 *
 * 数据流向和网页版一致：服务端权威 → poll 拿到 events + 我的 view → 这里只做投影。
 * 不在这里算任何规则：合法动作来自 view.legal，血量来自 view.hp，结算真值来自 history。
 */
const app = getApp();
const api = require('../../utils/api.js');
const { createChannel } = require('../../utils/realtime.js');
const F = require('../../utils/fmt.js');

const ORD = f => (f === 1 ? 7 : f);

Page({
  data: {
    code: '', role: 'spec', loading: true,
    netText: '连接中…', netClass: '',
    room: null, phase: 'lobby',
    seatCards: [], canStart: false, turnSec: 45,
    meName: '你', oppName: '对手', meMeta: '', oppMeta: '',
    hpMe: 8, hpOpp: 8, hpMax: 8, hpMePct: 100, hpOppPct: 100,
    roundText: '—', zhai: false, countsText: '',
    myDice: [], oppDice: [], oppRevealed: false,
    bidText: '还没人喊价', bidSub: '',
    seqList: [], histList: [],
    counts: [], countSel: 0,
    faces: [], faceSel: 0,
    modeOpts: [], modeSel: 'normal', preview: '',
    canOpen: false, canSlash: false,
    myTurn: false, submitted: false, over: false,
    overTitle: '', overSub: '', overLines: [],
    leftSec: 0, msg: '', msgBad: false,
  },

  onLoad(q) {
    const code = String((q && q.room) || '').toUpperCase();
    if (!code) { wx.navigateBack(); return; }
    this.role = 'spec';
    this.seatToken = '';
    this.legal = [];
    this.sel = null;
    this.revealDice = null;
    this.lastRoundNo = null;
    this.setData({ code });
    this.init(code, (q && q.seat) || '');
  },

  onShow() { if (this.chan && !this.chan.running) this.chan.start(); },
  onHide() { if (this.chan) this.chan.stop(); },
  onUnload() {
    if (this.chan) this.chan.stop();
    this.stopTimer();
    if (this.msgTimer) clearTimeout(this.msgTimer);
  },

  /* ---------------- 进桌：先定身份，再连通道 ---------------- */
  async init(code, seatHint) {
    try {
      let token = app.seatToken(code);
      let role = '';

      if (token && (seatHint === 'A' || seatHint === 'B')) role = seatHint;

      // 从分享卡片进来的人没有令牌：先试着坐空位（乙方优先），坐不上就观战
      if (!token && seatHint !== 'spec') {
        const nick = wx.getStorageSync('nick') || '玩家';
        for (const s of ['B', 'A']) {
          try {
            const r = await api.post('/api/room/join', { code, seat: s, nick });
            token = r.token; role = r.seat;
            app.setSeatToken(code, token);
            break;
          } catch (e) { /* 这个座满了，试下一个 */ }
        }
      }
      if (token && !role) role = await this.guessRole(code, token);
      if (!token) role = 'spec';

      this.role = role;
      this.seatToken = token;

      const info = await api.get('/api/room/' + code);
      this.applyRoom(info.room);
      if (info.view) this.applyView(info.view);
      this.startChannel();
      this.setData({ loading: false });
    } catch (e) {
      this.setMsg(e.status === 404 ? '房间不存在或已经散了' : e.message, true);
      this.setData({ loading: false });
    }
  },

  // 令牌认座：拿 A 试一次，403 就是 B。比在 URL 里信一个参数可靠。
  async guessRole(code, token) {
    try {
      await api.get('/api/room/' + code + '/poll?role=A&token=' + encodeURIComponent(token) + '&since=0&wait=0', { timeout: 8000 });
      return 'A';
    } catch (e) {
      return e.status === 403 ? 'B' : 'spec';
    }
  },

  startChannel() {
    if (this.chan) this.chan.stop();
    this.chan = createChannel({
      code: this.data.code,
      role: this.role,
      token: this.seatToken,
      onStatus: (s, e) => this.onNet(s, e),
      onRoom: room => this.applyRoom(room),
      onView: v => this.applyView(v),
      onEvents: evs => this.onEvents(evs),
      onGone: () => this.setMsg('这桌已经被回收了', true),
    });
    this.chan.start();
  },

  onNet(state, err) {
    if (state === 'online') this.setData({ netText: '已连接', netClass: 'live' });
    else this.setData({ netText: '重连中…', netClass: 'dead' });
  },

  /* ---------------- 房间投影 ---------------- */
  applyRoom(room) {
    if (!room) return;
    const role = this.role;
    const seatMe = role === 'A' || role === 'B' ? role : 'A';
    const seatOpp = F.other(seatMe);
    const hp = room.hp || {};
    const hpMax = room.hpMax || 8;

    const seatCards = ['A', 'B'].map(p => {
      const s = room.seats[p] || {};
      return {
        seat: p,
        title: p === 'A' ? '甲方' : '乙方',
        nick: s.nick || (s.kind === 'open' ? '（空位）' : '—'),
        meta: F.seatMeta(s),
        stateText: s.kind === 'open' ? '等邀请' : (s.connected ? '在线' : '离线'),
        isMe: p === role,
        connected: !!s.connected,
      };
    });

    this.setData({
      room,
      seatCards,
      canStart: room.state === 'lobby' && role !== 'spec' && room.seats.A.kind !== 'open' && room.seats.B.kind !== 'open',
      phase: room.state === 'lobby' ? 'lobby' : 'playing',
      turnSec: Math.round((room.turnMs || 45000) / 1000),
      meName: role === 'spec' ? (room.seats.A.nick || '甲方') : F.seatNick(room, seatMe, '你'),
      oppName: role === 'spec' ? (room.seats.B.nick || '乙方') : F.seatNick(room, seatOpp, '对手'),
      meMeta: F.seatMeta(room.seats[seatMe]),
      oppMeta: F.seatMeta(room.seats[seatOpp]),
      hpMe: hp[seatMe] == null ? hpMax : hp[seatMe],
      hpOpp: hp[seatOpp] == null ? hpMax : hp[seatOpp],
      hpMax,
      hpMePct: F.pct(hp[seatMe] == null ? hpMax : hp[seatMe], hpMax),
      hpOppPct: F.pct(hp[seatOpp] == null ? hpMax : hp[seatOpp], hpMax),
    });
    wx.setNavigationBarTitle({ title: '鬼骰 · ' + room.code });
  },

  /* ---------------- 视角投影 ---------------- */
  applyView(v) {
    if (!v) return;
    const isSpec = this.role === 'spec';
    const room = this.data.room || { seats: {} };
    const seatMe = isSpec ? 'A' : this.role;
    const seatOpp = isSpec ? 'B' : F.other(this.role);
    const hpMax = v.hpMax || this.data.hpMax || 8;

    // 新的一轮：上轮亮出的牌要盖回去
    if (this.lastRoundNo !== v.roundNo) {
      this.lastRoundNo = v.roundNo;
      this.revealDice = null;
      this.sel = null;
    }

    const hpMe = isSpec ? (v.hp ? v.hp.A : hpMax) : (v.hp ? v.hp.me : hpMax);
    const hpOpp = isSpec ? (v.hp ? v.hp.B : hpMax) : (v.hp ? v.hp.opp : hpMax);

    const myDice = (!isSpec && v.dice) ? F.diceView(v.dice, v.zhai) : [];
    const revealed = !isSpec && this.revealDice && this.revealDice[seatOpp];
    const oppDice = revealed ? F.diceView(this.revealDice[seatOpp], v.zhai)
      : F.backView(!isSpec && v.dice ? v.dice.length : 5);

    let countsText = '';
    if (!isSpec && v.counts) {
      countsText = [1, 2, 3, 4, 5, 6].map(f => f + '×' + (v.counts[f] || 0)).join('  ') + (v.zhai ? ' · 斋：1 只算 1' : ' · 未斋：1 万能');
    }

    const nickOf = x => (isSpec ? F.seatNick(room, x) : (x === 'me' ? '你' : '对手'));
    let bidText = '还没人喊价', bidSub = '';
    if (v.bid) {
      const prefix = v.bid.mode === 'breakZhai' ? '破斋 ' : v.bid.mode === 'toZhai' ? '转斋 ' : '';
      bidText = prefix + v.bid.count + ' 个 ' + v.bid.face + (v.bid.zhai ? '（斋）' : '');
      bidSub = nickOf(v.bid.by) + ' 喊的 · 该' + nickOf(v.turn) + '走';
    } else if (!v.over) {
      bidSub = isSpec ? '等他们开始' : (v.turn === 'me' ? '轮到你首喊' : '等对手首喊');
    }

    const seqList = (v.seq || []).map(s => ({
      mine: !isSpec && s.by === 'me',
      text: s.at + '. ' + nickOf(s.by) + ' 喊 ' + s.count + ' 个 ' + s.face
        + (s.zhai ? '（斋）' : '')
        + (s.mode === 'toZhai' ? ' · 转斋' : s.mode === 'breakZhai' ? ' · 破斋' : ''),
    }));

    const histList = (v.history || []).map(h => {
      const tail = h.bid
        ? ' · ' + nickOf(h.bid.by) + ' 喊 ' + h.bid.count + ' 个 ' + h.bid.face + (h.bid.zhai ? '（斋）' : '')
        : '';
      const head = '第 ' + h.no + ' 轮' + tail;
      let body = '';
      if (h.forfeit) body = '这一轮有人认输/掉线，直接判负。';
      else body = nickOf(h.opener) + (h.slash ? ' 劈' : ' 开盅') + ' · 实际 ' + h.actual + ' 个 → '
        + (h.truth ? '够，喊的人输' : '不够，喊的人赢') + ' · 输家 ' + nickOf(h.loser);
      return { head, body };
    });

    this.legal = v.legal || [];
    this.setData({
      zhai: !!v.zhai,
      myDice, oppDice, oppRevealed: !!revealed, countsText,
      bidText, bidSub, seqList, histList,
      roundText: '第 ' + (v.roundNo || 0) + ' 轮',
      hpMe, hpOpp, hpMax,
      hpMePct: F.pct(hpMe, hpMax), hpOppPct: F.pct(hpOpp, hpMax),
      myTurn: !isSpec && v.turn === 'me' && !v.over,
      canOpen: !isSpec && (v.legal || []).some(a => a.type === 'open' && !a.slash),
      canSlash: !isSpec && (v.legal || []).some(a => a.type === 'open' && a.slash),
    });
    this.refreshOptions();
  },

  /* ---------------- 合法动作选择器（完全由服务端的 legal 驱动）---------------- */
  refreshOptions() {
    const bids = (this.legal || []).filter(a => a.type === 'bid');
    const counts = [...new Set(bids.map(a => a.count))].sort((x, y) => x - y);
    const faceList = [...new Set(bids.map(a => a.face))].sort((x, y) => ORD(x) - ORD(y));
    const modesFor = (c, f) => [...new Set(bids.filter(a => a.count === c && a.face === f).map(a => a.mode || 'normal'))];

    let sel = this.sel;
    const stillValid = sel && bids.some(a => a.count === sel.count && a.face === sel.face && (a.mode || 'normal') === sel.mode);
    if (!stillValid) {
      const alt = (sel && bids.find(a => a.count === sel.count && a.face === sel.face)) || bids[0] || null;
      sel = alt ? { count: alt.count, face: alt.face, mode: alt.mode || 'normal' } : null;
    }
    this.sel = sel;

    const faces = faceList.map(f => ({
      face: f,
      enabled: !!(sel && modesFor(sel.count, f).length),
      on: !!(sel && sel.face === f),
    }));
    const modeOpts = sel ? modesFor(sel.count, sel.face).map(m => ({ id: m, label: F.modeLabel(m) })) : [];

    this.setData({
      counts,
      countSel: sel ? sel.count : 0,
      faces,
      faceSel: sel ? sel.face : 0,
      modeOpts,
      modeSel: sel ? sel.mode : 'normal',
      preview: sel ? F.actText({ type: 'bid', count: sel.count, face: sel.face, mode: sel.mode }) : '',
    });
  },

  onPickCount(e) {
    const c = +e.currentTarget.dataset.c;
    const sel = this.sel;
    if (!sel) return;
    const same = this.legal.filter(a => a.type === 'bid' && a.count === c);
    const keep = same.find(a => a.face === sel.face) || same[0];
    if (keep) this.sel = { count: keep.count, face: keep.face, mode: keep.mode || 'normal' };
    this.refreshOptions();
  },

  onPickFace(e) {
    const f = +e.currentTarget.dataset.f;
    const sel = this.sel;
    if (!sel) return;
    const hit = this.legal.filter(a => a.type === 'bid' && a.count === sel.count && a.face === f);
    if (!hit.length) return;
    const pick = hit.find(a => (a.mode || 'normal') === sel.mode) || hit[0];
    this.sel = { count: sel.count, face: f, mode: pick.mode || 'normal' };
    this.refreshOptions();
  },

  onPickMode(e) {
    const m = e.currentTarget.dataset.m;
    const sel = this.sel;
    if (!sel) return;
    this.sel = { count: sel.count, face: sel.face, mode: m };
    this.refreshOptions();
  },

  /* ---------------- 事件 ---------------- */
  onEvents(evs) {
    const room = this.data.room || { seats: {} };
    for (const ev of evs) {
      const p = ev.payload || {};
      switch (ev.type) {
        case 'room':
          if (p.room) this.applyRoom(p.room);
          if (p.kind === 'rearm') this.setData({ over: false });
          break;
        case 'state':
          if (p.room) this.applyRoom(p.room);
          break;
        case 'presence':
          if (this.data.room && this.data.room.seats && this.data.room.seats[p.seat]) {
            this.data.room.seats[p.seat].connected = p.online ? 1 : 0;
            this.applyRoom(this.data.room);
          }
          break;
        case 'round':
          this.setData({ roundText: '第 ' + p.roundNo + ' 轮' });
          break;
        case 'ask':
          this.setData({ submitted: false, myTurn: true });
          if (p.view) this.applyView(p.view);
          if (p.deadline) this.startTimer(p.deadline);
          break;
        case 'acted':
          if (p.seat === this.role) { this.setData({ submitted: true }); this.stopTimer(); }
          break;
        case 'bid':
          this.setMsg((p.seat === this.role ? '你' : (p.nick || '对手')) + ' 喊 ' + p.count + ' 个 ' + p.face + (p.zhai ? '（斋）' : ''));
          break;
        case 'open':
          this.onOpen(p);
          break;
        case 'notice':
          this.setMsg((p.kind === 'timeout' ? '超时：' : '') + (p.seat === this.role ? '你' : (p.nick || '对手')) + ' 被自动接手为 ' + F.actText(p.action), p.seat === this.role);
          break;
        case 'abandon':
          this.setMsg((p.nick || '有人') + ' 认输或无法行动', true);
          break;
        case 'aborted':
          this.setMsg('这桌中断：' + (p.reason || ''), true);
          break;
        case 'game':
          this.revealDice = null;
          this.lastRoundNo = null;
          this.sel = null;
          this.setData({ over: false, seqList: [], histList: [], submitted: false,
            roundText: '第 ' + (p.game || 1) + ' 把' });
          break;
        case 'gameover':
          if (p.hp) this.setData({ hpMe: p.hp[this.role === 'spec' ? 'A' : this.role], hpOpp: p.hp[this.role === 'spec' ? 'B' : F.other(this.role)] });
          break;
        case 'matchover':
          this.onMatchOver(p);
          break;
        case 'usage':
          break;
        default:
          break;
      }
    }
  },

  onOpen(p) {
    this.stopTimer();
    this.setData({ submitted: false });
    if (p.reveal && p.reveal.dice) {
      // reveal.dice 以「座位(甲/乙)」为键，用昵称对齐我这一侧，复式换座也不会张冠李戴
      const myNick = this.data.meName;
      const myKey = p.reveal.A === myNick ? 'A' : (p.reveal.B === myNick ? 'B' : null);
      this.revealDice = p.reveal.dice;
      const oppKey = myKey === 'A' ? 'B' : 'A';
      const room = this.data.room || {};
      if (myKey) {
        this.setData({
          oppRevealed: true,
          oppDice: F.diceView(p.reveal.dice[oppKey], this.data.zhai),
          oppName: p.reveal[oppKey] || this.data.oppName,
        });
      }
      this.setMsg(p.truth ? '开盅：够了，喊的人输' : '开盅：不够，喊的人赢');
    }
    if (p.hp) {
      const seatMe = this.role === 'spec' ? 'A' : this.role;
      const seatOpp = this.role === 'spec' ? 'B' : F.other(this.role);
      this.setData({
        hpMe: p.hp[seatMe], hpOpp: p.hp[seatOpp],
        hpMePct: F.pct(p.hp[seatMe], this.data.hpMax), hpOppPct: F.pct(p.hp[seatOpp], this.data.hpMax),
      });
    }
  },

  onMatchOver(p) {
    const room = this.data.room || { seats: {} };
    const net = p.net || { A: 0, B: 0 };
    const nameOf = pl => F.seatNick(room, pl);
    const lines = ['A', 'B'].map(pl =>
      nameOf(pl) + '：净胜血 ' + (net[pl] > 0 ? '+' : '') + net[pl] + (pl === this.role ? '（你）' : ''));
    lines.push('共 ' + ((p.games || []).length) + ' 把 · token 用量 ' + (p.usedTokens || 0));
    this.setData({
      over: true,
      overTitle: p.winner ? ((p.winnerNick || nameOf(p.winner)) + ' 拿下这桌') : '打平',
      overSub: p.duplicate ? '复式：同一副骰子各打一次并换座位，比净胜血之和。' : '单局。',
      overLines: lines,
    });
    this.stopTimer();
  },

  /* ---------------- 动作 ---------------- */
  async submit(action) {
    if (this.data.submitted) return;
    try {
      await api.post('/api/room/action', {
        code: this.data.code, seat: this.role, token: this.seatToken, action,
      });
      this.setData({ submitted: true });
      this.stopTimer();
      this.setMsg('已提交：' + F.actText(action) + ' · 等对手', false);
    } catch (e) {
      this.setMsg(e.message, true);
    }
  },

  onGo() {
    const s = this.sel;
    if (!s) return;
    this.submit({ type: 'bid', count: s.count, face: s.face, mode: s.mode === 'normal' ? null : s.mode });
  },
  onOpenTap() { this.submit({ type: 'open', slash: false }); },
  onSlash() { this.submit({ type: 'open', slash: true }); },

  async onStart() {
    try {
      const r = await api.post('/api/room/start', { code: this.data.code, token: this.seatToken });
      if (r.room) this.applyRoom(r.room);
      this.setMsg('开局');
    } catch (e) { this.setMsg(e.message, true); }
  },

  async onAgain() {
    try {
      const r = await api.post('/api/room/start', { code: this.data.code, token: this.seatToken });
      this.revealDice = null; this.lastRoundNo = null; this.sel = null; this.legal = [];
      this.setData({ over: false, submitted: false, seqList: [], histList: [], myDice: [], oppDice: [] });
      if (r.room) this.applyRoom(r.room);
    } catch (e) { this.setMsg(e.message, true); }
  },

  async onResign() {
    try {
      await api.post('/api/room/resign', { code: this.data.code, seat: this.role, token: this.seatToken });
      this.setMsg('已认输');
    } catch (e) { this.setMsg(e.message, true); }
  },

  async onSwitchSeat() {
    const room = this.data.room;
    if (!room || room.state !== 'lobby') return this.setMsg('开打之后不能换座', true);
    const target = this.role === 'A' ? 'B' : 'A';
    if (room.seats[target].kind !== 'open') return this.setMsg('那个座位有人了', true);
    try {
      const nick = wx.getStorageSync('nick') || '玩家';
      const r = await api.post('/api/room/join', { code: this.data.code, seat: target, nick });
      app.setSeatToken(this.data.code, r.token);
      this.seatToken = r.token;
      this.role = r.seat;
      this.startChannel();
      this.setMsg('已换到' + (r.seat === 'A' ? '甲方' : '乙方'));
    } catch (e) { this.setMsg(e.message, true); }
  },

  onLeave() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  /* ---------------- 计时与提示 ---------------- */
  startTimer(deadline) {
    this.stopTimer();
    if (!deadline) return;
    const tick = () => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      this.setData({ leftSec: left });
      if (left <= 0) this.stopTimer();
    };
    tick();
    this.timer = setInterval(tick, 1000);
  },
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },

  setMsg(t, bad) {
    this.setData({ msg: t, msgBad: !!bad });
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => this.setData({ msg: '' }), 3200);
  },

  onShareAppMessage() {
    return {
      title: '鬼骰 · 房号 ' + this.data.code + '，来一局',
      path: '/pages/table/table?room=' + this.data.code,
    };
  },
});
