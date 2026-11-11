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
    baseUrl: null, model: null, alias: null, secretToken: null,
    guideText: '', guideChars: 0, effort: null, thinking: null, maxTokens: 0, temperature: null,
    connected: 0, host: null, armId: null, promptHash: null, hasKey: false,
  };
}
function registry_chairOfPlan(room, plan) { return room.chairPlan.A === plan ? 'A' : 'B'; }
function visibleTo(role, scope) {
  if (scope === 'all') return true;
  if (role === 'spec') return false;
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
    return [...this.rooms.values()].filter(r => r.state === 'lobby' && !r.passHash)
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
      return s;
    }
    throw new Error('未知座位类型：' + kind);
  }

  join(code, slot, { nick, pass, user } = {}) {
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
    room.lastActive = now();
    this.emit(room, 'room', { kind: 'seat', seat: w, nick: s.nick, room: this.info(room) }, 'all');
    return { ok: true, seat: w, token: s.token, room: this.info(room) };
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
      notice: (chair, note) => this.emit(room, 'notice', Object.assign({}, note, { seat: this.planOfChair(room, chair) }), 'all'),
    };
    const actors = {};
    for (const w of ['A', 'B']) {
      const s = room.seats[w];
      if (s.kind === 'me') {
        actors[w] = makeHumanPlayer({ nick: s.nick, timeoutMs: room.turnMs, onTimeout: room.onTimeout, io });
      } else if (s.kind === 'bot') {
        actors[w] = makeBot(s.bot, Math.random);
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
        for (const a of ((act && act.attempts) || [])) {
          room.usedTokens = (room.usedTokens || 0) + (a.promptTokens || 0) + (a.completionTokens || 0);
        }
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
  async start(code, { token, user } = {}) {
    const room = this.get(code);
    if (!room) return { ok: false, reason: '房间不存在' };
    if (room.state === 'playing') return { ok: false, reason: '这桌正在打' };
    const holder = (token && (this.checkSeatToken(room, 'A', token) || this.checkSeatToken(room, 'B', token))) || (user && room.ownerId === user.id);
    if (!holder) return { ok: false, reason: '只有坐上来的人能开局' };
    if (room.state === 'finished') this.rearm(room);
    if (room.seats.A.kind === 'open' || room.seats.B.kind === 'open') {
      return { ok: false, reason: '还有空位：邀请好友入座，或把那一座换成模型 / 人机' };
    }
    room.usedTokens = 0;
    room.tally = { A: blankTally(), B: blankTally() };
    const built = await this.buildActors(room);
    if (!built.ok) return built;
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

  onMatchEvent(room, ev) {
    const clean = V.sanitizeEvent(ev);
    const plan = this.planOfChair(room, ev.who);
    clean.seat = plan;
    clean.nick = room.seats[plan] ? room.seats[plan].nick : null;
    if (ev.kind === 'bid') { this.emit(room, 'bid', clean, 'all'); return; }
    if (ev.kind === 'open') {
      const h = room.m ? room.m.history[room.m.history.length - 1] : null;
      clean.truth = ev.truth;              // 这时候已亮牌，真值可以公布
      clean.hp = this.hpByPlan(room, room.m);
      clean.reveal = h && h.dice ? { A: room.seats[room.chairPlan.A].nick, B: room.seats[room.chairPlan.B].nick,
        dice: { A: h.dice.A, B: h.dice.B }, actual: h.actual, wild: h.wild, all: h.all } : null;
      this.emit(room, 'open', clean, 'all');
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
      if (s.connected === 0 && a && a.giveUp) a.giveUp(reason || 'offline');
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
        if (emptyTooLong || (t - room.lastActive) > IDLE_MS) this.close(code);
      }
      if (this.opts.vault) this.opts.vault.sweep();
    }, 60000);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }
}

module.exports = { Registry, blankSeat, visibleTo, writeSSE, makeCode, nickClean, IDLE_MS, EMPTY_MS, EFFORTS };
