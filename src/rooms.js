/* 房间与对局宿主（实时对战平台）
 * 一份权威对局 = src/runner.js 的 runMatch；座位是同一接口的不同实现：
 *   me（人类，src/human.js）｜ llm（模型，src/llm.js，Key 在账号里或临时自带）｜ bot（内置人机，src/bots.js）｜ preset（平台供模型）
 * 四种座位任意混排 → 人人 / 人模 / 模人 / 人机 / 机人 / 模模 / 模机 / 机模 / 机机，一套代码。
 *
 * 两套「座位」别混：
 *   plan（A/B）  = 建桌时定下的两把「人」（房间信息、订阅身份、令牌、战绩归属都按它）
 *   chair（A/B） = 每一局引擎里的物理椅子；复式第二把换座位 = chairA 坐 planB
 *   room.chairPlan = { A: 'B', B: 'A' } 表示此刻 chairA 上坐的是 planB
 * 广播一律按 plan 标座位，客户端只认自己那个人，换座不用改客户端逻辑。
 *
 * 隐私口径（必须守住）：
 *   · 座位只收到 scope=自己 的 ask，内容是自己那份视角（view.js 投影，不含对方骰子）
 *   · 广播走 view.sanitizeEvent：runner 的 ev 带 truth（这一手真假），当场公布等于替对手读牌
 *   · 本轮骰子只在轮末 open/settle 事件里出现；观战只拿 publicView
 *   · 任何下发给浏览器的房间信息都不含 Key、不含座位令牌
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const E = require('./dice-engine.js');
const RS = require('./dice-rulesets.js');
const C = require('./context.js');
const RK = require('../web/ranking.js');
const { runMatch } = require('./runner.js');
const { makeHumanPlayer } = require('./human.js');
const { makeBot, BOTS } = require('./bots.js');
const { makeLLMPlayer } = require('./llm.js');
const V = require('./view.js');
const GW = require('./model-gw.js');

// 端点地址只公布「不是本机/内网」的那部分：朋友知道你用的是公网服务就够了，
// 我家里跑着什么端口不该出现在别人的屏幕上。
function pubHost(h) {
  if (!h) return null;
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(h)) ? '（服务器本机端点）' : String(h);
}
function blankTally() { return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, ms: 0, errors: 0, reflections: 0 }; }
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉 I/O/0/1，口头报号不会听错
const EVENT_CAP = 600;
const IDLE_MS = 30 * 60 * 1000;        // 一直没人活动 → 回收
const EMPTY_MS = 10 * 60 * 1000;       // 一条连接都不剩 → 回收
const POLL_ALIVE_MS = 30000;           // 轮询心跳：25s 一次长轮询 + 5s 余量，超过就算掉线
/* 空壳席位回收：关掉页面的人不该永远占着座位 —— 以前「离线」的红字能挂一整晚，
 * 观战席更是三个坑位被同一批匿名游客占死。两条 TTL 都只在「还没开局」时生效。 */
const SEAT_TTL_MS = +(process.env.DICE_SEAT_TTL_MS || 10 * 60 * 1000);    // 对战席：连续离线 10 分钟就放出来
const WATCH_TTL_MS = +(process.env.DICE_WATCH_TTL_MS || 15 * 60 * 1000);  // 观战席：15 分钟没心跳就放出来
const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];

const now = () => Date.now();
function makeCode(n = 6) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
const seatToken = () => crypto.randomBytes(16).toString('hex');
function nickClean(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F\u200B-\u200F]/g, '').trim().slice(0, 24) || '玩家';
}
function blankSeat() {
  return {
    kind: 'open', nick: '', token: null, userId: null, bot: null,
    // ready：真人自己点「准备」；把模型放上对战席 = 自动准备（放置的人负责，不用再点）
    // placed：这一座是「被放置的模型/人机」，不是本人亲自出马
    ready: false, placed: false,
    baseUrl: null, model: null, alias: null, secretToken: null,
    guideText: '', guideChars: 0, effort: null, thinking: null, maxTokens: 0, temperature: null,
    connected: 0, host: null, armId: null, promptHash: null, hasKey: false,
  };
}
function registry_chairOfPlan(room, plan) { return room.chairPlan.A === plan ? 'A' : 'B'; }
/* 谁能看到什么（潘潘定的规则）：
 *   · 不亲自出马（观战 / 房主令牌进来的人）= 全知：双方骰子、双方推演、全部事件都看得到。
 *   · 亲自出马（坐在座位里打）= 只看自己那一侧：座位私有事件只发给自己，别人的推演不外泄。
 * 注意：观战全知意味着场外的人可以把牌面转告给场内玩家 —— 朋友局里没问题，正式比赛别这么开。 */
function visibleTo(role, scope) {
  if (scope === 'all') return true;
  if (scope === 'omni') return role === 'spec' || role === 'host';        // 全知通道：只给观战/房主
  const watching = role === 'spec' || role === 'host';
  if (scope === 'thinkA' || scope === 'thinkB') {
    const seat = scope === 'thinkA' ? 'A' : 'B';
    return watching || role === seat;                                     // 推演：观战全知 + 本座自己
  }
  if (watching) return true;                                              // 观战/房主要的全知：其余私有事件也给他
  return scope === role || scope === 'players';
}
function writeSSE(res, e) {
  try { res.write('id: ' + e.id + '\nevent: ' + e.type + '\ndata: ' + JSON.stringify(e.payload) + '\n\n'); }
  catch (err) { /* 断开由订阅清理层处理 */ }
}

class Registry {
  /* opts = { vault, accounts, policy, presets:()=>({list:[],ruleSets:[]}), recordFile } */
  constructor(opts = {}) {
    this.opts = opts;
    this.rooms = new Map();
    this.gcTimer = null;
  }
  presets() { try { return (this.opts.presets && this.opts.presets()) || { list: [], ruleSets: [] }; } catch (e) { return { list: [], ruleSets: [] }; } }

  /* ---------------- 建桌 / 入座 ---------------- */
  create(cfg = {}, owner = null) {
    const code = this.freeCode();
    const ps = this.presets();
    const custom = (ps.ruleSets || []).find(r => r && r.id === cfg.rules) || null;
    const rulesId = cfg.rules || 'flex';
    const room = {
      code, title: String(cfg.title || '').slice(0, 40),
      createdAt: now(), lastActive: now(), emptySince: 0,
      ownerId: owner ? owner.id : null,
      // 房主控制令牌：谁建了这桌谁就能开局 / 关桌。两座都不是「真人」时（模型 vs 人机、
      // 模型 vs 模型）没有座位令牌可发，之前创建者反而开不了局 —— 这令牌补上这个缺口。
      // 它只用于开局/关桌，不能替任何座位落子或认输；也绝不出现在 info() / 事件流里。
      hostToken: seatToken(),
      rulesId, rules: RS.normalize(custom || rulesId),
      hpMax: Math.min(40, Math.max(1, +cfg.hpMax || 8)),
      maxRounds: Math.min(300, Math.max(3, +cfg.maxRounds || 60)),
      turnMs: Math.min(600000, Math.max(5000, +cfg.turnMs || 45000)),
      onTimeout: cfg.onTimeout === 'forfeit' ? 'forfeit' : 'auto',
      duplicate: !!cfg.duplicate,
      deals: Math.min(20, Math.max(1, +cfg.deals || 1)),
      tokenBudget: Math.max(0, +cfg.tokenBudget || 0),
      reflectAfter: Math.min(20, Math.max(0, +cfg.reflectAfter || 0)),
      passHash: cfg.pass ? crypto.createHash('sha256').update(String(cfg.pass)).digest('hex') : null,
      state: 'lobby', seats: { A: blankSeat(), B: blankSeat() },
      // 3 个观战席：观战看得到全部信息（不亲自出马 = 全知）
      watch: { S1: blankSeat(), S2: blankSeat(), S3: blankSeat() },
      // mode: 'invite' 邀请制房间（对面那一席只能靠邀请链接入座）
      //       'solo'   个人演武场（不进公开列表，AI 座默认准备，建好就能开）
      mode: cfg.mode === 'solo' ? 'solo' : 'invite',
      unlisted: cfg.mode === 'solo' || !!cfg.unlisted,
      actors: {}, chairPlan: { A: 'A', B: 'B' }, m: null,
      seedBase: (crypto.randomBytes(4).readUInt32BE(0) & 0x3fffffff) || 1,
      events: [], nextEventId: 1, subs: new Map(), subSeq: 1,
      // 轮询通道（微信小程序没有 EventSource）：pollAt 记每个座位最后一次拉取时间，
      // waiters 是挂起中的长轮询，emit 时一次性叫醒。SSE 与轮询共用同一条事件流，不另开一套协议。
      pollAt: { A: 0, B: 0, spec: 0 }, waiters: [], polling: 0,
      games: [], net: { A: 0, B: 0 }, usedTokens: 0, lastRoundSeen: 0, lastMs: 0, resigned: {},
    };
    for (const w of ['A', 'B']) {
      const spec = (cfg.seats && cfg.seats[w]) || { kind: 'open' };
      room.seats[w] = this.planSeat(room, w, spec, w === 'A' ? owner : null);
    }
    this.rooms.set(code, room);
    this.emit(room, 'room', { kind: 'created', room: this.info(room) }, 'all');
    this.ensureGc();
    return room;
  }
  freeCode() {
    for (let i = 0; i < 50; i++) { const c = makeCode(); if (!this.rooms.has(c)) return c; }
    return makeCode(8);
  }
  get(code) { return this.rooms.get(String(code || '').toUpperCase()) || null; }
  listPublic() {
    return [...this.rooms.values()].filter(r => r.state === 'lobby' && !r.passHash && !r.unlisted)
      .map(r => ({ code: r.code, title: r.title, seats: { A: r.seats.A.kind, B: r.seats.B.kind }, createdAt: r.createdAt, rulesId: r.rulesId, hpMax: r.hpMax }));
  }

  planSeat(room, slot, spec = {}, owner = null) {
    const s = blankSeat();
    const kind = String(spec.kind || 'me');
    s.kind = kind;
    if (kind === 'open') return s;

    if (kind === 'me') {
      s.nick = nickClean(spec.nick || (owner && owner.nick) || '玩家');
      s.userId = owner ? owner.id : null;
      s.token = seatToken();
      return s;
    }
    if (kind === 'bot') {
      if (!BOTS[spec.bot || 'reader']) throw new Error('未知人机：' + spec.bot);
      s.bot = spec.bot || 'reader';
      s.nick = BOTS[s.bot].label || s.bot;
      s.ready = true; s.placed = true; s.userId = owner ? owner.id : null;
      return s;
    }
    if (kind === 'llm' || kind === 'preset') {
      let base = null, model = null, key = null, alias = '';
      const g = spec;
      if (kind === 'preset') {
        const p = (this.presets().list || []).find(x => x.id === spec.presetId);
        if (!p) throw new Error('平台预设里没有这个模型：' + spec.presetId);
        base = p.base; model = p.model; key = p.apiKey || null; alias = p.alias || p.model;
      } else if (spec.configId && owner) {
        const c = this.opts.accounts.configById(owner, spec.configId);
        if (!c || c.kind !== 'llm') throw new Error('你自己的配置里没有这一条');
        base = c.baseUrl; model = c.model; key = this.opts.accounts.keyOf(c) || null; alias = c.name;
        if (g.guideText == null) g.guideText = c.guideText;
        if (g.effort == null) g.effort = c.effort;
        if (g.thinking == null) g.thinking = c.thinking;
        if (g.maxTokens == null) g.maxTokens = c.maxTokens;
        if (g.temperature == null) g.temperature = c.temperature;
      } else if (spec.secretToken) {
        const e = this.opts.vault.get(spec.secretToken);
        if (!e) throw new Error('临时 Key 已失效，请重新填写');
        base = e.baseUrl; model = e.model; key = e.apiKey || null; alias = e.alias || e.model;
        if (g.guideText == null) g.guideText = e.guideText;
      } else {
        base = spec.baseUrl; model = spec.model; key = spec.apiKey || null; alias = spec.alias || spec.model;
      }
      if (!base || !model) throw new Error('模型座位需要 Base URL 与模型 ID');
      // Key 只进内存保险柜（临时座位级），房间对象与快照里都不留明文
      if (key) s.secretToken = this.opts.vault.put({ baseUrl: base, model, apiKey: key, alias, guideText: g.guideText });
      s.baseUrl = base; s.model = model; s.alias = nickClean(alias); s.nick = s.alias;
      s.guideText = C.cleanGuide(g.guideText || '');
      s.guideChars = s.guideText.length;
      s.effort = EFFORTS.includes(g.effort) ? g.effort : 'medium';
      s.thinking = g.thinking !== false;
      s.maxTokens = Math.min(65536, Math.max(256, +g.maxTokens || 8192));
      s.temperature = Math.min(2, Math.max(0, +g.temperature || 0.7));
      s.ready = true; s.placed = true; s.userId = owner ? owner.id : null;   // 放上模型 = 默认准备
      return s;
    }
    throw new Error('未知座位类型：' + kind);
  }

  join(code, slot, { nick, pass, user, watchToken } = {}) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在或已关闭' };
    if (room.passHash && crypto.createHash('sha256').update(String(pass || '')).digest('hex') !== room.passHash) {
      return { ok: false, reason: '房间口令不对' };
    }
    if (room.state !== 'lobby') return { ok: false, reason: '这桌已经开打了，可以先观战，或另开一桌' };
    const w = slot === 'B' ? 'B' : 'A';
    if (room.seats[w].kind !== 'open') return { ok: false, reason: (w === 'A' ? '甲方' : '乙方') + '已经有人了' };
    const s = room.seats[w];
    s.kind = 'me'; s.nick = nickClean(nick || (user && user.nick)); s.userId = user ? user.id : null;
    s.token = seatToken();
    // 从观战席挪到对战席：把原来那张观战席空出来，一个人只占一个位置。
    // 认人三件套：登录账号 / 观战令牌 / —— 匿名访客没有账号，光靠 userId 清不掉，
    // 于是就出现「同一个人既是甲方的离线玩家、又是观战席 2 的玩家」。令牌必须一起认。
    this.dropWatchSeat(room, { userId: user && user.id, token: watchToken });
    room.lastActive = now();
    this.emit(room, 'room', { kind: 'seat', seat: w, nick: s.nick, room: this.info(room) }, 'all');
    return { ok: true, seat: w, token: s.token, room: this.info(room) };
  }
  /* 房主能不能以「观战/全知」身份看这一桌：亲自坐进座位之后就不能。
     潘潘的规则：亲自出马就只能看自己那一侧 —— 房主也不例外，否则房主可以一边打一边开
     第二个连接用全知通道看对面的牌。坐在座位里的判定：这条连接的座位令牌有效，或登录账号
     已占着某一席。 */
  /* 有没有人「在看」：观战席上坐了人，或有 spec 视角的订阅（观战页/房主全知连接）。
     人机延迟、以及「要不要放慢」都看这个。 */
  watcherCount(room) {
    let n = 0;
    for (const slot of ['S1', 'S2', 'S3']) { const w = (room.watch || {})[slot]; if (w && w.kind === 'me') n++; }
    for (const v of room.subs.values()) { if (v && v.role === 'spec') n++; }
    return n;
  }
  // 人机每步的思考时间；DICE_BOT_DELAY_MS=0 可整体关掉
  botDelayMs() {
    const v = process.env.DICE_BOT_DELAY_MS;
    if (v != null && v !== '') { const n = +v; return Number.isFinite(n) ? Math.max(0, n) : 900; }
    return 900;
  }
  /* 观战席：默认进来就是观战（不亲自出马 = 全知）。3 席满了就退回「无席观战」，照样能看。 */
  watchSeat(code, { nick, pass, user, watchToken } = {}) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在或已关闭' };
    // 已经在对战席上的人，不再给观战席：不能「一边打一边看」
    if (user) for (const p of ['A', 'B']) {
      const s = room.seats[p];
      if (s && s.kind === 'me' && s.userId && s.userId === user.id) {
        return { ok: true, slot: null, token: null, room: this.info(room), reason: '你坐在' + (p === 'A' ? '甲' : '乙') + '方对战席上，观战席就不占位了' };
      }
    }
    if (room.passHash && crypto.createHash('sha256').update(String(pass || '')).digest('hex') !== room.passHash) {
      return { ok: false, reason: '房间口令不对' };
    }
    // 已经在观战席上就复用那一席（按 watchToken / 账号 / 昵称三种认法，
    // 否则匿名观众刷新一次邀请链接就多占一席，三席很快被同一个人占满）
    const nm = nickClean(nick || (user && user.nick));
    for (const slot of ['S1', 'S2', 'S3']) {
      const w = room.watch[slot];
      if (w.kind !== 'me') continue;
      if (watchToken && w.token && w.token === watchToken) { w.seenAt = now(); return { ok: true, slot, token: w.token, room: this.info(room) }; }
      if (user && w.userId === user.id) { w.seenAt = now(); return { ok: true, slot, token: w.token, room: this.info(room) }; }
      if (!user && !w.userId && nm && w.nick === nm) { w.seenAt = now(); return { ok: true, slot, token: w.token, room: this.info(room) }; }
    }
    for (const slot of ['S1', 'S2', 'S3']) {
      const w = room.watch[slot];
      if (w.kind === 'open') {
        w.kind = 'me'; w.nick = nickClean(nick || (user && user.nick)); w.userId = user ? user.id : null; w.token = seatToken();
        w.seenAt = now();
        room.lastActive = now();
        this.emit(room, 'room', { kind: 'watch', slot, nick: w.nick, room: this.info(room) }, 'all');
        return { ok: true, slot, token: w.token, room: this.info(room) };
      }
    }
    return { ok: true, slot: null, token: null, room: this.info(room), reason: '观战席满了，你以「站票」观战：照样看得到全部信息' };
  }
  checkWatchToken(room, token) {
    for (const slot of ['S1', 'S2', 'S3']) { const w = room.watch[slot]; if (w.kind === 'me' && w.token && token && w.token === token) return slot; }
    return null;
  }
  /* 准备 / 取消准备：只有真人席位需要点，AI 席位放置即准备 */
  /* 主动离开：把这个人从对战席 / 观战席上摘掉。
     之前「离开」只是前端断开，服务端那条 me 席位还挂着，别人看到的就是「虚空的我」。 */
  leave(code, { user, token, watchToken } = {}) {
    const room = this.get(code);
    if (!room) return { ok: true, gone: true };
    const iAm = p => {
      const s = room.seats[p];
      return s && s.kind === 'me' && ((token && this.checkSeatToken(room, p, token)) || (user && s.userId && s.userId === user.id));
    };
    const seated = ['A', 'B'].filter(iAm);
    if (seated.length && room.state === 'playing') {
      return { ok: false, reason: '这一局还在打：先认输，或者等这局结束再走' };
    }
    for (const p of seated) room.seats[p] = blankSeat();
    // 观战席按「账号 / 观战令牌」认人。以前这里拿座位令牌去比观战席的 token，
    // 永远对不上 —— 纯观战的人点「离桌」，那一席纹丝不动。
    this.dropWatchSeat(room, { userId: user && user.id, token: watchToken });
    room.lastActive = now();
    // 人都走光了就把这张桌收掉，别留空壳
    const empty = room.state === 'lobby' && room.seats.A.kind === 'open' && room.seats.B.kind === 'open'
      && !['S1', 'S2', 'S3'].some(slot => room.watch[slot].kind === 'me');
    if (empty) { this.close(code); return { ok: true, closed: true }; }
    this.emit(room, 'room', { kind: 'leave', room: this.info(room) }, 'all');
    return { ok: true, seat: seated[0] || null, room: this.info(room) };
  }
  /* 坐进对战席 / 让位 / 离桌时，顺手清掉这个人的观战席，避免同一个人占两个位置。
     认人两件套：登录账号（userId）、观战令牌（watchToken）。匿名访客只有后者。 */
  dropWatchSeat(room, { userId, token } = {}) {
    if (!userId && !token) return false;
    let hit = false;
    for (const slot of ['S1', 'S2', 'S3']) {
      const w = room.watch[slot];
      if (!w || w.kind !== 'me') continue;
      if ((userId && w.userId === userId) || (token && w.token && w.token === token)) {
        room.watch[slot] = blankSeat();
        hit = true;
        this.emit(room, 'room', { kind: 'watch', slot, nick: '', reason: 'seat-taken', room: this.info(room) }, 'all');
      }
    }
    return hit;
  }
  dropWatchOf(room, userId) { return this.dropWatchSeat(room, { userId }); }
  /* 观战席心跳：前端每次拉事件都带 watchToken，超时没动静的观战席由 GC 收回。 */
  touchWatch(room, token) {
    if (!token) return false;
    for (const slot of ['S1', 'S2', 'S3']) {
      const w = room.watch[slot];
      if (w && w.kind === 'me' && w.token === token) { w.seenAt = now(); return true; }
    }
    return false;
  }
  /* 空壳席位回收：只动「还没开局」的桌 —— 开打之后席位由对局自己管（掉线认输另有宽限）。 */
  reapIdleSeats(room, t = now()) {
    const alive = p => ((room.seats[p].connected || 0) > 0)
      || !!(room.pollAt && (t - (room.pollAt[p] || 0)) < POLL_ALIVE_MS);
    let changed = false;
    if (room.state === 'lobby') {
      for (const p of ['A', 'B']) {
        const s = room.seats[p];
        if (!s || s.kind !== 'me') { if (s) s.offSince = 0; continue; }
        if (alive(p)) { s.offSince = 0; continue; }
        s.offSince = s.offSince || t;
        if (t - s.offSince >= SEAT_TTL_MS) {
          const nick = s.nick;
          room.seats[p] = blankSeat();
          changed = true;
          this.emit(room, 'room', { kind: 'leave', seat: p, nick, reason: 'idle', room: this.info(room) }, 'all');
        }
      }
    }
    for (const slot of ['S1', 'S2', 'S3']) {
      const w = room.watch[slot];
      if (!w || w.kind !== 'me') continue;
      // 观战席靠「这一席自己的心跳」（前端每 4 分钟带令牌再进一次，/api/room/watch 幂等）。
      // 不再用「全场还有人挂着观战连接就不清」的粗判据 —— 那会让关掉页面的旧席位
      // 一直赖在观战席上，只要还有别人在看。
      if (t - (w.seenAt || room.lastActive || t) >= WATCH_TTL_MS) {
        room.watch[slot] = blankSeat();
        changed = true;
        this.emit(room, 'room', { kind: 'watch', slot, nick: '', reason: 'idle', room: this.info(room) }, 'all');
      }
    }
    return changed;
  }
  setReady(code, plan, token, ready) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在' };
    if (room.state === 'playing' || room.state === 'finished') return { ok: false, reason: '这一桌已经在打了' };
    const s = room.seats[plan];
    if (!s) return { ok: false, reason: '没有这一席' };
    if (s.kind !== 'me' || !this.checkSeatToken(room, plan, token)) return { ok: false, reason: '这一席不是你的（只有本人席能点准备）' };
    s.ready = !!ready;
    room.lastActive = now();
    this.emit(room, 'room', { kind: 'ready', seat: plan, ready: s.ready, room: this.info(room) }, 'all');
    return { ok: true, room: this.info(room) };
  }
  /* 把模型 / 人机放上对战席（席位必须是空的）。放上去即准备。 */
  placeSeat(code, { seat, seatSpec, user, host } = {}) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在' };
    if (room.state === 'playing') return { ok: false, reason: '这一桌已经在打了' };
    if (!(user && room.ownerId === user.id) && !(host && room.hostToken === host) && !(user && room.seats[seat] && room.seats[seat].userId === user.id)) {
      return { ok: false, reason: '只有房主能把模型放上这一席' };
    }
    const w = seat === 'B' ? 'B' : 'A';
    if (room.seats[w].kind !== 'open') return { ok: false, reason: (w === 'A' ? '甲方' : '乙方') + '已经有人了' };
    const s = this.planSeat(room, w, Object.assign({ kind: 'llm' }, seatSpec || {}), user || null);
    room.seats[w] = s;
    room.lastActive = now();
    this.emit(room, 'room', { kind: 'place', seat: w, room: this.info(room) }, 'all');
    return { ok: true, seat: w, room: this.info(room) };
  }
  /* 把模型/人机放下（清空这一席）：房主或放置它的人可以。 */
  unplaceSeat(code, { seat, user, host, token } = {}) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在' };
    if (room.state === 'playing') return { ok: false, reason: '打着的时候不能动席位' };
    const w = seat === 'B' ? 'B' : 'A';
    const s = room.seats[w];
    if (!s || s.kind === 'open') return { ok: false, reason: '这一席本来就空着' };
    const isOwner = (user && room.ownerId === user.id) || (host && room.hostToken === host);
    const isPlacer = !!(user && s.userId && s.userId === user.id);
    const isSelf = !!(token && this.checkSeatToken(room, w, token));
    if (!(isOwner || isPlacer || isSelf)) return { ok: false, reason: '只有房主或放置这一席的人能把它放下' };
    if (s.kind === 'me' && !isSelf) return { ok: false, reason: '真人坐在这一席：要离开得是本人点离开' };
    room.seats[w] = blankSeat();
    room.lastActive = now();
    this.emit(room, 'room', { kind: 'unplace', seat: w, room: this.info(room) }, 'all');
    return { ok: true, room: this.info(room) };
  }
  /* 观战（spec）连接的准入：坐在对战席里的人不能开全知连接 —— 否则「亲自出马只能看自己」
     只要多开一个 ?role=spec 就绕过去了。观战席、站票不受影响。 */
  specMayWatch(room, { user, token } = {}) {
    for (const p of ['A', 'B']) {
      const s = room.seats[p];
      if (!s) continue;
      const mine = (token && this.checkSeatToken(room, p, token)) || (user && s.kind === 'me' && s.userId && s.userId === user.id);
      if (mine) return { ok: false, reason: '你坐在' + (p === 'A' ? '甲' : '乙') + '方对战席上：亲自出马就只能看自己那一侧，不能再用观战身份看对面的信息' };
    }
    return { ok: true };
  }
  hostMayWatch(room, { user, token } = {}) {
    const seatedByToken = !!(token && (this.checkSeatToken(room, 'A', token) || this.checkSeatToken(room, 'B', token)));
    const seatedByUser = !!(user && ((room.seats.A.userId && room.seats.A.userId === user.id)
      || (room.seats.B.userId && room.seats.B.userId === user.id)));
    if (seatedByToken || seatedByUser) return { ok: false, reason: '你已经坐在这一桌里了：亲自出马就只能看自己那一侧，不能再用房主身份看对面的信息' };
    const isHost = (room.hostToken && token && room.hostToken === token) || (user && room.ownerId === user.id);
    if (!isHost) return { ok: false, reason: '不是这一桌的房主' };
    return { ok: true };
  }
  checkSeatToken(room, plan, token) {
    const s = room.seats[plan];
    return !!(s && s.kind === 'me' && s.token && token && s.token === token);
  }
  planOfChair(room, chair) { return room.chairPlan[chair] || chair; }
  chairOfPlan(room, plan) { return room.chairPlan.A === plan ? 'A' : 'B'; }
  actorOfPlan(room, plan) { return room.actors[this.chairOfPlan(room, plan)] || null; }

  /* ---------------- 演员装配 ---------------- */
  async buildActors(room) {
    const io = {
      ask: (chair, view, meta) => {
        const plan = this.planOfChair(room, chair);
        this.emit(room, 'ask', Object.assign({ chair, you: plan, view }, meta), plan);
      },
      notice: (chair, note) => {
        const plan = this.planOfChair(room, chair);
        this.emit(room, 'notice', Object.assign({}, note, {
          seat: plan, nick: room.seats[plan] ? room.seats[plan].nick : null,
        }), 'all');
      },
    };
    const actors = {};
    for (const w of ['A', 'B']) {
      const s = room.seats[w];
      if (s.kind === 'me') {
        actors[w] = makeHumanPlayer({ nick: s.nick, timeoutMs: room.turnMs, onTimeout: room.onTimeout, io });
      } else if (s.kind === 'bot') {
        // 人机瞬间出招，两台对打时人眼根本跟不上：有人在看就给人机加一点思考时间。
        // 没观众（跑批 / 自检）不延迟，测试速度不受影响。
        const base = makeBot(s.bot, Math.random);
        const other = w === 'A' ? 'B' : 'A';
        const decide0 = base.decide.bind(base);
        base.decide = async (...args) => {
          // 有人看着（观战席/全知连接）、或对手是真人时，人机才「想一想」：
          // 否则它一秒能连开好几手，血掉得莫名其妙。纯跑批/自检两边都是机器，不延迟。
          const watched = !!room.watchExpected || this.watcherCount(room) > 0
            || (room.seats[other] && room.seats[other].kind === 'me');
          const d = this.botDelayMs();
          if (watched && d > 0) await new Promise(r => setTimeout(r, Math.round(d * (0.6 + Math.random() * 0.8))));
          return decide0(...args);
        };
        actors[w] = base;
      } else if (s.kind === 'llm' || s.kind === 'preset') {
        if (s.kind === 'llm') {
          const chk = await GW.checkEgress(s.baseUrl, this.opts.policy);
          if (!chk.ok) throw new Error((w === 'A' ? '甲方' : '乙方') + '的模型端点被出网策略拒绝：' + chk.reason);
        }
        const rec = s.secretToken ? this.opts.vault.get(s.secretToken) : null;
        const key = rec ? rec.apiKey || null : null;
        s.armId = s.guideText ? C.customArmId(s.guideText) : 'plain';
        s.promptHash = RK.hashTexts(C.promptTexts(room.rules, s.armId));
        s.hasKey = !!key;
        s.host = GW.describeSeatForLog({ baseUrl: s.baseUrl, model: s.model });
        actors[w] = makeLLMPlayer({
          name: s.nick, baseUrl: s.baseUrl, model: s.model, apiKey: key,
          thinking: s.thinking, effort: s.effort, maxTokens: s.maxTokens, temperature: s.temperature,
          rules: room.rules, context: 'chat', timeoutMs: Math.max(120000, room.turnMs * 4),
          ctxLimit: 32768, reflectTokens: 4096, guideText: s.guideText || null,
        }, rec => this.onSeatLog(room, w, rec));
      } else return { ok: false, reason: (w === 'A' ? '甲方' : '乙方') + '还没人入座' };
      actors[w] = this.wrapActor(room, w, actors[w]);
    }
    return { ok: true, actors };
  }

  // 包一层：抓住权威 match 引用（round / settle 广播要读 history）、按桌统计 token、超预算叫停
  wrapActor(room, plan, actor) {
    const budget = room.tokenBudget;
    const reg = this;              // 包出来的对象上没有 emitRound，闭包拿注册表
    return Object.assign({}, actor, {
      async decide(m, who, memos, meta) {
        room.m = m;
        if (Object.keys(room.resigned || {}).length) throw new Error('__resign__');
        if (m.roundNo !== room.lastRoundSeen) {
          room.lastRoundSeen = m.roundNo;
          reg.emitRound(room, m);
        }
        const act = await actor.decide(m, who, memos, meta);
        // 用量只在 onSeatLog 里累计一次（每次模型调用都会推一条）；这里再累一遍会把预算算成两倍
        if (budget && room.usedTokens > budget) {
          throw new Error('本桌 token 预算 ' + budget + ' 已用尽（当前 ' + room.usedTokens + '）');
        }
        return act;
      },
      reset() { if (actor.reset) actor.reset(); },
    });
  }
  // 模型座位的调用流水：数字进桌统计（界面显示花了多少 token），原文进 calls 文件便于事后复盘。
  // 广播只发数字 —— 提示词内容不进事件流，观战看不到别人的策略。
  onSeatLog(room, plan, rec) {
    room.tally = room.tally || { A: blankTally(), B: blankTally() };
    const t = room.tally[plan];
    if (!t) return;
    if (rec.kind === 'call') {
      t.calls++; t.ms += rec.ms || 0;
      t.promptTokens += rec.promptTokens || 0; t.completionTokens += rec.completionTokens || 0;
      t.cachedTokens += rec.cachedTokens || 0;
      room.usedTokens = (room.usedTokens || 0) + (rec.promptTokens || 0) + (rec.completionTokens || 0);
      this.emit(room, 'usage', { plan, calls: t.calls, promptTokens: t.promptTokens, completionTokens: t.completionTokens, usedTokens: room.usedTokens, ms: t.ms }, 'all');
      // 这一座的实时推演流：模型这一手到底说了什么（只发给这一座 + 房主，见 visibleTo）
      const raw = typeof rec.content === 'string' ? rec.content.trim() : '';
      if (raw) this.emit(room, 'think', {
        seat: plan, text: raw.slice(0, 1600), truncated: raw.length > 1600,
        phase: rec.phase || null, ms: rec.ms || 0, tokens: rec.completionTokens || 0,
        finish: rec.finish || null, reasonChars: rec.reasonChars || 0, at: now(),
      }, 'think' + plan);
    } else if (rec.kind === 'conn-error') {
      t.errors++;
      this.emit(room, 'seatwarn', { plan, attempt: rec.attempt || null, error: rec.error || '' }, 'all');
    } else if (rec.kind === 'reflection') {
      t.reflections++;
    }
    if (this.opts.callFile) {
      try {
        fs.appendFileSync(this.opts.callFile, JSON.stringify(Object.assign({ t: now(), room: room.code, plan }, rec)) + '\n');
      } catch (e) { /* 流水落盘失败不影响对局 */ }
    }
  }

  emitRound(room, m) {
    const r = m.round;
    this.emit(room, 'round', {
      roundNo: m.roundNo,
      firstBidder: this.planOfChair(room, r.turn),
      hp: this.hpByPlan(room, m), hpMax: m.hpMax,
      over: !!m.over,
    }, 'all');
  }
  hpByPlan(room, m) {
    if (!m) return null;
    const out = {};
    for (const p of ['A', 'B']) {
      const chair = room.chairPlan.A === p ? 'A' : 'B';
      out[p] = m.hp[chair];
    }
    return out;
  }

  /* ---------------- 开局 / 再来一局 ---------------- */
  async start(code, { token, user, host } = {}) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在' };
    if (room.state === 'playing') return { ok: false, reason: '这桌正在打' };
    const holder = (token && (this.checkSeatToken(room, 'A', token) || this.checkSeatToken(room, 'B', token)))
      || (user && room.ownerId === user.id)
      || (host && room.hostToken && room.hostToken === host);
    if (!holder) return { ok: false, reason: '只有建桌的人或坐上来的人能开局——用邀请链接进来，或登录后再开' };
    if (room.state === 'finished') this.rearm(room);
    if (room.seats.A.kind === 'open' || room.seats.B.kind === 'open') {
      return { ok: false, reason: '还有空位：邀请好友入座，或把那一座放上模型 / 人机' };
    }
    if (!room.seats.A.ready || !room.seats.B.ready) {
      const who = !room.seats.A.ready ? '甲方' : '乙方';
      return { ok: false, reason: who + '还没准备：两边都点了准备才能开局' };
    }
    room.usedTokens = 0;
    room.resigned = {};        // 上一局的认输标记必须清掉，否则「再来一局」开局即判负
    room.tally = { A: blankTally(), B: blankTally() };
    // 建演员是异步的（要做出网检查）：先占住状态，双击 / 多标签同时点也只会起一条 runSeries
    room.state = 'starting';
    let built;
    try { built = await this.buildActors(room); }
    catch (e) { room.state = 'lobby'; throw e; }
    if (!built.ok) { room.state = 'lobby'; return built; }
    room.actors = built.actors;
    room.state = 'playing';
    room.startedAt = now();
    room.games = []; room.net = { A: 0, B: 0 }; room.lastRoundSeen = 0;
    this.emit(room, 'state', { state: 'playing', room: this.info(room) }, 'all');
    this.runSeries(room).catch(e => {
      if (process.env.DICE_DBG) console.error('runSeries 炸了：', e && e.stack || e);
      room.state = 'aborted';
      this.emit(room, 'aborted', { reason: String((e && e.message) || e) }, 'all');
    });
    return { ok: true, room: this.info(room) };
  }
  rearm(room) {
    room.state = 'lobby';
    room.resigned = {};        // 同上：认输过的桌重开时要能正常打
    room.m = null; room.lastRoundSeen = 0;
    room.seedBase = (crypto.randomBytes(4).readUInt32BE(0) & 0x3fffffff) || 1;
    room.games = []; room.net = { A: 0, B: 0 }; room.usedTokens = 0;
    this.emit(room, 'room', { kind: 'rearm', room: this.info(room) }, 'all');
  }

  async runSeries(room) {
    const swaps = room.duplicate ? [false, true] : [false];
    let game = 0;
    for (let d = 0; d < room.deals; d++) {
      const seed = room.seedBase + d * 977;
      for (const swap of swaps) {
        game++;
        room.chairPlan = swap ? { A: 'B', B: 'A' } : { A: 'A', B: 'B' };
        room.lastRoundSeen = 0;
        const firstBidder = (seed % 2 === 0) ? 'A' : 'B';
        this.emit(room, 'game', {
          game, deal: d + 1, deals: room.deals, swap, seed, hpMax: room.hpMax,
          firstBidder: this.planOfChair(room, firstBidder),
          at: { A: room.seats[room.chairPlan.A].nick, B: room.seats[room.chairPlan.B].nick },
        }, 'all');
        const t0 = now();
        const res = await runMatch(room.actors, E.mulberry32(seed), {
          hpMax: room.hpMax, maxRounds: room.maxRounds, rules: room.rules, firstBidder,
          reflectAfter: room.reflectAfter,
          meta: { run_id: room.code, game, deal: d, swap },
          onEvent: ev => this.onMatchEvent(room, ev),
        });
        room.lastMs = now() - t0;
        // 认输：runMatch 会以 ungraded 收口（我们让演员直接抛错结束这一把）。这里按「认输方该把 0 血」判负，
        // 不能让它当成未评局静默消失——真人对战里「认输了却不记」是最伤体验的 bug。
        const resignedPlan = Object.keys(room.resigned || {})[0] || null;
        if (res.ungraded && resignedPlan) {
          const otherPlan = resignedPlan === 'A' ? 'B' : 'A';
          const chR = registry_chairOfPlan(room, resignedPlan), chO = registry_chairOfPlan(room, otherPlan);
          res.ungraded = false; res.resign = resignedPlan;
          res.winner = chO; res.draw = false; res.capped = false;
          res.hp = Object.assign({}, res.hp, { [chR]: 0, [chO]: room.hpMax });
        }
        this.record(room, res, { game, deal: d, swap, seed });
        room.games.push({ game, deal: d + 1, swap, winner: res.winner ? this.planOfChair(room, res.winner) : null,
          draw: !!res.draw, capped: !!res.capped, ungraded: !!res.ungraded, hp: this.hpByPlan(room, res.hp ? { hp: res.hp, chairPlan: room.chairPlan } : null) || res.hp, rounds: res.rounds });
        if (!res.ungraded && res.hp) {
          for (const p of ['A', 'B']) {
            const chair = room.chairPlan.A === p ? 'A' : 'B';
            room.net[p] = (room.net[p] || 0) + (res.hp[chair] - room.hpMax);
          }
        }
        this.emit(room, 'gameover', {
          game, deal: d + 1, deals: room.deals, swap,
          winner: res.winner ? this.planOfChair(room, res.winner) : null,
          winnerNick: res.winner ? room.seats[this.planOfChair(room, res.winner)].nick : null,
          draw: !!res.draw, capped: !!res.capped, ungraded: !!res.ungraded,
          hp: this.hpByPlan(room, { hp: res.hp }) || res.hp, hpMax: room.hpMax,
          rounds: res.rounds, ms: room.lastMs, stats: res.stats, net: room.net,
          history: room.m ? room.m.history.map(h => V.historyView(h, null)) : [],
        }, 'all');
      }
    }
    const net = room.net;
    room.state = 'finished';
    this.emit(room, 'matchover', {
      net, winner: net.A === net.B ? null : (net.A > net.B ? 'A' : 'B'),
      winnerNick: net.A === net.B ? null : room.seats[net.A > net.B ? 'A' : 'B'].nick,
      draw: net.A === net.B, duplicate: room.duplicate, deals: room.deals, games: room.games,
      usedTokens: room.usedTokens, usage: room.tally || null,
    }, 'all');
    // Key 不在这里销毁：「再来一局」还要用同一份配置，令牌留到关桌（close）时回收
  }

  /* 观战/房主的「全知」负载：两边骰子、当前喊价、轮到谁、血量。
   只走 scope='omni'，坐在座位里的人拿不到 —— 他只能看到自己那一侧。 */
  omniPayload(room) {
    const m = room.m; if (!m) return null;
    const r = m.round || {};
    const diceOf = pl => { const ch = this.chairOfPlan(room, pl); return r.dice ? (r.dice[ch] || null) : null; };
    return {
      round: m.roundNo, over: !!m.over, zhai: !!r.zhai, winner: m.winner || null,
      turn: r.turn ? this.planOfChair(room, r.turn) : null,
      bid: r.bid ? { seat: this.planOfChair(room, r.bid.by), count: r.bid.count, face: r.bid.face, zhai: !!r.bid.zhai, mode: r.bid.mode || null } : null,
      dice: { A: diceOf('A'), B: diceOf('B') },
      hp: this.hpByPlan(room, m), hpMax: m.hpMax,
    };
  }
  emitOmni(room) { const p = this.omniPayload(room); if (p) this.emit(room, 'omni', p, 'omni'); }

  onMatchEvent(room, ev) {
    const clean = V.sanitizeEvent(ev);
    const plan = this.planOfChair(room, ev.who);
    clean.seat = plan;
    clean.nick = room.seats[plan] ? room.seats[plan].nick : null;
    if (ev.kind === 'bid') { this.emit(room, 'bid', clean, 'all'); this.emitOmni(room); return; }
    if (ev.kind === 'open') {
      const h = room.m ? room.m.history[room.m.history.length - 1] : null;
      clean.truth = ev.truth;              // 这时候已亮牌，真值可以公布
      clean.hp = this.hpByPlan(room, room.m);
      // 输家按 plan 给：hp 是 plan 键，复式换座时如果还按 chair 给，
      // 界面就会把「剩 X 血」安到另一个人头上（座位令牌、昵称全是 plan 口径）。
      clean.loser = ev.loser ? this.planOfChair(room, ev.loser) : null;
      clean.stake = h && h.stake ? h.stake : 1;     // 这一手掉多少血：给界面写「−1 血（剩 7）」
      clean.openedBy = plan;                                      // 开盅的人
      clean.bidBy = h && h.bid ? this.planOfChair(room, h.bid.by) : null;   // 被开的那手是谁喊的
      clean.hpMax = room.m ? room.m.hpMax : room.hpMax;
      // 亮牌按「座位(plan)」给键，不用 chair：复式换座时 chair 和 plan 会错位，
      // 直接给 chair 的话界面会把对面的骰子画到自己这一栏。
      clean.reveal = h && h.dice ? (() => {
        const pA = this.planOfChair(room, 'A'), pB = this.planOfChair(room, 'B');
        return {
          A: room.seats[pA] ? room.seats[pA].nick : '甲', B: room.seats[pB] ? room.seats[pB].nick : '乙',
          dice: { [pA]: h.dice.A, [pB]: h.dice.B }, actual: h.actual, wild: h.wild, all: h.all,
        };
      })() : null;
      this.emit(room, 'open', clean, 'all');
      this.emitOmni(room);
      return;
    }
    if (ev.kind === 'forfeit' || ev.kind === 'error') { this.emit(room, 'abandon', clean, 'all'); return; }
    this.emit(room, 'note', clean, 'all');
  }

  /* ---------------- 战绩落盘（沿用 arena matches 记录格式，排名页直接能读）---------------- */
  record(room, res, ctx) {
    const file = this.opts.recordFile;
    if (!file || res.ungraded) return;
    const snap = plan => {
      const s = room.seats[plan];
      return {
        id: s.kind === 'me' ? 'me:' + (s.userId || 'guest') : (s.kind === 'bot' ? 'bot:' + s.bot : 'llm:' + (s.model || '?')),
        alias: s.nick, model: s.model || s.bot || 'human',
        base: s.kind === 'me' ? 'human' : (s.kind === 'bot' ? 'bot' : (s.host || '')),
        effort: s.effort || 'off', maxTokens: s.maxTokens || 0,
        arm: s.armId || null, prompt_hash: s.promptHash || null, guideChars: s.guideChars || 0,
        userId: s.userId || null,
      };
    };
    const pt = p => C.promptTexts(room.rules, room.seats[p].armId || 'plain').join('\n');
    const rec = {
      t: now(), run_id: room.code, gameNo: ctx.game, source: 'live',
      seats: { A: snap('A'), B: snap('B') },
      ruleset_hash: RS.hash(room.rules),
      prompt_hash: RK.hashTexts([pt('A'), pt('B')]),
      rules: { id: room.rulesId, name: room.rules.name || room.rulesId },
      hpMax: room.hpMax, rounds: res.rounds, seed: ctx.seed, swap: ctx.swap, deal: ctx.deal,
      duplicate: room.duplicate, usage: room.tally || null,
      hp: this.hpByPlan(room, { hp: res.hp }), winner: res.winner ? this.planOfChair(room, res.winner) : null,
      draw: !!res.draw, capped: !!res.capped, stats: res.stats, ms: room.lastMs || 0,
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (e) { /* 落盘失败不影响对局 */ }
  }

  /* ---------------- 事件总线（SSE）---------------- */
  /* 只发给一条连接（不进事件缓冲）：握手这种「跟你自己有关」的消息不能被别的连接收到，
     否则在座玩家会收到一条 you:'spec' 的 hello，误以为自己是观战，把座位令牌丢掉。 */
  emitTo(room, subOrId, type, payload) {
    const sub = typeof subOrId === 'string' ? room.subs.get(subOrId) : subOrId;
    if (!sub) return null;
    const e = { id: room.nextEventId++, t: now(), type, scope: sub.role, payload };
    writeSSE(sub.res, e);
    return e;
  }
  emit(room, type, payload, scope) {
    room.lastActive = now();
    const e = { id: room.nextEventId++, t: now(), type, scope: scope || 'all', payload };
    room.events.push(e);
    if (room.events.length > EVENT_CAP) room.events.splice(0, room.events.length - EVENT_CAP);
    for (const sub of room.subs.values()) if (visibleTo(sub.role, e.scope)) writeSSE(sub.res, e);
    // 叫醒挂起的长轮询：事件已经到了，别再让客户端空等到超时
    if (room.waiters && room.waiters.length) {
      const ws = room.waiters; room.waiters = [];
      for (const w of ws) { try { w(); } catch (err) { } }
    }
    return e;
  }
  subscribe(room, res, role, lastEventId) {
    const id = 's' + (room.subSeq++);
    const sub = { id, res, role, at: now() };
    room.subs.set(id, sub);
    room.lastActive = now();
    if (role === 'A' || role === 'B') {
      const st = room.seats[role];
      if (st.offlineTimer) { clearTimeout(st.offlineTimer); st.offlineTimer = null; }   // 宽限期内回来了：取消自动接手
      room.seats[role].connected = (room.seats[role].connected || 0) + 1;
      this.emit(room, 'presence', { seat: role, nick: room.seats[role].nick, online: true }, 'all');
    }
    room.emptySince = 0;
    const back = room.events.filter(e => (lastEventId == null || e.id > lastEventId) && visibleTo(role, e.scope));
    return { id, backlog: back };
  }
  /* ---------------- 轮询通道（小程序 / 弱网）----------------
     与 SSE 共用 room.events 与 visibleTo：同一条事件流、同一套可见性。
     刻意不走 subscribe()——轮询会每 25 秒重连一次，走 SSE 的订阅会计满在线数并刷屏 presence。 */
  touchPoll(room, role) {
    room.pollAt = room.pollAt || { A: 0, B: 0, spec: 0 };
    const wasAlive = room.pollAt[role] && (now() - room.pollAt[role]) < POLL_ALIVE_MS;
    room.pollAt[role] = now();
    room.lastActive = now();
    room.emptySince = 0;                 // 有人在拉 = 这桌不算空，别被 GC 收走
    if (!wasAlive && (role === 'A' || role === 'B')) {
      this.emit(room, 'presence', { seat: role, nick: room.seats[role].nick, online: true, via: 'poll' }, 'all');
    }
  }
  pollEvents(room, role, since) {
    const from = Number.isFinite(since) ? since : 0;
    return room.events.filter(e => e.id > from && visibleTo(role, e.scope));
  }
  // 挂起一段长时间：期间有新事件就立刻返回，否则等到 ms 到点
  waitForEvent(room, ms) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = (room.waiters || []).indexOf(finish);
        if (i >= 0) room.waiters.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      if (timer.unref) timer.unref();
      room.waiters = room.waiters || [];
      room.waiters.push(finish);
    });
  }

  unsubscribe(room, id, reason) {
    const sub = room.subs.get(id);
    if (!sub) return false;
    room.subs.delete(id);
    if (sub.role === 'A' || sub.role === 'B') {
      const s = room.seats[sub.role];
      s.connected = Math.max(0, (s.connected || 0) - 1);
      const a = this.actorOfPlan(room, sub.role);
      this.emit(room, 'presence', { seat: sub.role, nick: s.nick, online: s.connected > 0, reason: reason || 'left' }, 'all');
      if (s.connected === 0 && a && a.giveUp) {
        // 最小化、切标签、网络抖一下都会短暂断开：给 15 秒宽限，回来就取消，
        // 不能一断线就替他自动落子/认输。
        clearTimeout(s.offlineTimer);
        s.offlineTimer = setTimeout(() => {
          s.offlineTimer = null;
          if ((s.connected || 0) === 0) a.giveUp(reason || 'offline');
        }, +(process.env.DICE_OFFLINE_GRACE_MS || 15000));
      }
    }
    if (!room.subs.size) room.emptySince = now();
    room.lastActive = now();
    return true;
  }

  /* ---------------- 房间信息（脱敏，绝不含 Key / 令牌 / 本轮骰子）---------------- */
  info(room) {
    const seat = p => {
      const s = room.seats[p];
      return {
        seat: p, kind: s.kind, nick: s.kind === 'open' ? '' : s.nick,
        bot: s.bot || null, model: s.model || null,
        arm: s.armId || null, armLabel: s.armId ? ((C.ARMS[s.armId] || {}).label || s.armId) : null,
        guideChars: s.guideChars || 0,
        hasKey: (s.kind === 'llm' || s.kind === 'preset') ? !!s.hasKey : false,
        host: (s.kind === 'llm' || s.kind === 'preset') ? pubHost(s.host) : null,
        effort: s.effort || null,
        thinking: (s.kind === 'llm' || s.kind === 'preset') ? s.thinking : null,
        // SSE 订阅数 与 轮询心跳 任一条在，都算这个人还在桌上
        connected: Math.max(s.connected || 0, (room.pollAt && now() - (room.pollAt[p] || 0) < POLL_ALIVE_MS) ? 1 : 0),
        ready: !!s.ready, placed: !!s.placed, owned: !!s.userId,
      };
    };
    return {
      code: room.code, title: room.title, state: room.state, createdAt: room.createdAt,
      usedTokens: room.usedTokens || 0,
      hasPass: !!room.passHash, rulesId: room.rulesId, rulesName: room.rules.name || room.rulesId,
      rulesHash: RS.hash(room.rules), hpMax: room.hpMax, maxRounds: room.maxRounds,
      turnMs: room.turnMs, onTimeout: room.onTimeout, duplicate: room.duplicate, deals: room.deals,
      tokenBudget: room.tokenBudget, usedTokens: room.usedTokens || 0,
      seats: { A: seat('A'), B: seat('B') },
      mode: room.mode || 'invite',
      watchers: this.watcherCount(room),   // 几个在看（观战席 + 全知连接）：人机延迟也看这个
      watch: ['S1', 'S2', 'S3'].map(slot => {
        const w = (room.watch || {})[slot] || {};
        return { slot, kind: w.kind || 'open', nick: w.kind === 'me' ? (w.nick || '') : '', connected: w.connected || 0 };
      }),
      games: room.games, net: room.net, lastMs: room.lastMs || 0,
      roundNo: room.m ? room.m.roundNo : 0, hp: this.hpByPlan(room, room.m),
      you: undefined,
    };
  }

  /* ---------------- 认输 / 关闭 / 回收 ---------------- */
  /* 认输：整局判负，不是「这一手判负」。
     做法：置桌内标记 → 解开当前挂起的一手（forfeit）→ 演员下一次 decide 直接抛错结束这一把
     → runSeries 按「认输方 0 血」收口并记账。真人对战里必须立刻见胜负，不能再拖一轮。 */
  resign(code, plan, token) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在' };
    if (!this.checkSeatToken(room, plan, token)) return { ok: false, reason: '这一座的令牌不对' };
    room.resigned = room.resigned || {};
    room.resigned[plan] = now();
    this.emit(room, 'abandon', { kind: 'resign', seat: plan, nick: room.seats[plan].nick }, 'all');
    const a = this.actorOfPlan(room, plan);
    if (a && a.resign) a.resign();
    return { ok: true, via: 'resign' };
  }
  giveUp(code, plan, reason) {
    const room = this.get(code);
    if (!room) return false;
    const a = this.actorOfPlan(room, plan);
    return !!(a && a.giveUp && a.giveUp(reason || 'left'));
  }
  close(code) {
    const room = this.get(code);
    if (!room) return false;
    for (const p of ['A', 'B']) {
      const a = this.actorOfPlan(room, p);
      if (a && a.giveUp) a.giveUp('closed');
      if (room.seats[p].secretToken) this.opts.vault.drop(room.seats[p].secretToken);
    }
    room.state = 'aborted';
    for (const sub of room.subs.values()) { try { sub.res.end(); } catch (e) { } }
    room.subs.clear();
    if (room.waiters && room.waiters.length) {   // 别让挂着的轮询空等到超时
      const ws = room.waiters; room.waiters = [];
      for (const w of ws) { try { w(); } catch (e) { } }
    }
    this.rooms.delete(room.code);
    return true;
  }
  ensureGc() {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      const t = now();
      for (const [code, room] of [...this.rooms]) {
        if (!room.subs.size && !room.emptySince) room.emptySince = t;
        const emptyTooLong = room.emptySince && (t - room.emptySince) > EMPTY_MS;
        if (emptyTooLong || (t - room.lastActive) > IDLE_MS) { this.close(code); continue; }
        this.reapIdleSeats(room, t);   // 关掉页面的空壳席位（对战席 10 分钟 / 观战席 15 分钟）放出来
      }
      if (this.opts.vault) this.opts.vault.sweep();
    }, 60000);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }
}

module.exports = { Registry, blankSeat, visibleTo, writeSSE, makeCode, nickClean, IDLE_MS, EMPTY_MS, EFFORTS };
