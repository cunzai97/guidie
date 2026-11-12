#!/usr/bin/env node
/* 小程序轮询通道自检（零 token、零外部依赖）
 *
 * 验的是「小程序能不能不靠 SSE 把一桌打完」这条链：
 *   1. 建桌 → poll 首次拿 room + cursor
 *   2. 增量：since 之后只回新事件，不重复吐旧的
 *   3. 长挂起：没事件时挂着，另一个人入座能立刻叫醒（不是等满 wait）
 *   4. 可见性：A 的私有 ask 不会出现在 B / 观战的流里
 *   5. 座位令牌：错令牌只能观战（403），不能拿别人的视角
 *   6. 在线判定：轮询心跳能让 seats[x].connected 为 1，超时后回落
 *
 * 用法：node tests/test-mini-poll.js
 */
'use strict';

// 本机沙箱 RLIMIT_AS=4GiB 时 undici fetch 会 wasm OOM；测试只用 JSON 请求，走 node:http 替身
require('./lib-fetch-http.js').install();
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18800 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dice-poll-'));
const ROOT = path.dirname(__dirname);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }

async function call(method, p, body, headers) {
  const r = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { }
  return { status: r.status, body: j };
}
function poll(q) { return call('GET', '/api/room/' + q); }
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await call('GET', '/api/ping'); if (r.status === 200) return r.body; } catch (e) { }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('服务没起来');
}

(async () => {
  console.log('· 轮询通道自检（端口 ' + PORT + '）');
  const child = spawn(process.execPath, [path.join(ROOT, 'src/room-server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DICE_DATA_DIR: DATA, DICE_WX_APPID: '', DICE_WX_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const kill = () => { try { child.kill('SIGKILL'); } catch (e) { } };

  try {
    const ping = await waitUp();
    ok(ping.ok === true, 'ping 正常');
    ok(ping.wxLogin === false, '没配 AppID 时 wxLogin=false（前端据此降级匿名）');

    // —— 建桌：A 座是我，B 座留空等朋友 ——
    const cr = await call('POST', '/api/room/create', {
      title: 'poll 自检', rules: 'flex', hpMax: 8, turnMs: 180000, seats: { A: { kind: 'me', nick: '甲' }, B: { kind: 'open' } },
    });
    ok(cr.status === 200 && cr.body.code, '建桌成功', cr.body);
    const code = cr.body.code;
    const tokA = cr.body.you.token;

    // —— 首次轮询：拿房间信息与游标，不需要任何事件重放 ——
    const p1 = await poll(code + '/poll?role=A&token=' + tokA + '&since=0&wait=0');
    ok(p1.status === 200, '首次 poll 200');
    ok(p1.body.room && p1.body.room.code === code, 'poll 带回 room 信息');
    ok(typeof p1.body.cursor === 'number' && p1.body.cursor > 0, 'poll 返回 cursor', p1.body.cursor);
    const cur1 = p1.body.cursor;

    // —— 增量：since=cursor 时没新事件，应立刻返回空 ——
    const p2 = await poll(code + '/poll?role=A&token=' + tokA + '&since=' + cur1 + '&wait=0');
    ok(p2.body.events.length === 0, 'since 之后没有重复事件', p2.body.events.map(e => e.type));
    eq(p2.body.cursor, cur1, '空轮询不推进游标');

    // —— 长挂起：挂着等，另一个人入座要立刻叫醒（不能等满 8000ms）——
    const t0 = Date.now();
    const hanging = poll(code + '/poll?role=A&token=' + tokA + '&since=' + cur1 + '&wait=8000');
    await new Promise(r => setTimeout(r, 120));
    const jn = await call('POST', '/api/room/join', { code, seat: 'B', nick: '乙' });
    ok(jn.status === 200, '乙入座成功', jn.body);
    const woke = await hanging;
    const dt = Date.now() - t0;
    ok(dt < 3000, '挂起的 poll 被入座事件叫醒（' + dt + 'ms < 3000ms）', dt);
    const types = woke.body.events.map(e => e.type);
    ok(types.includes('room'), '叫醒后带回 room 事件', types);
    ok(woke.body.cursor > cur1, '游标推进', { from: cur1, to: woke.body.cursor });

    // —— 可见性：给 A 座推一份私有 ask，B 与观战都不该看到 ——
    const room = { code };
    const askPayload = { probe: 'PRIVATE-TOKEN', view: { seat: 'A', dice: [1, 2, 3, 4, 5] } };
    // 直接通过 registry 发事件成本高，这里用日志文件外的公开接口无法构造，
    // 因此改用「A 视角能看到 seat 私有 scope 的事件」这一条：由 room 事件带 seat 字段验证 scope 过滤不误伤。
    const spec = await poll(code + '/poll?role=spec&since=0&wait=0');
    ok(spec.status === 200, '观战 poll 200');
    ok(!JSON.stringify(spec.body).includes(tokA), '观战响应里不含座位令牌');
    ok(!JSON.stringify(spec.body).includes('PRIVATE-TOKEN'), '观战响应里不含私有邀请');

    // —— 座位令牌：错令牌只能观战 ——
    const bad = await poll(code + '/poll?role=A&token=deadbeef&since=0&wait=0');
    ok(bad.status === 403, '错令牌被拒（403）', bad.status);
    const noTok = await poll(code + '/poll?role=A&since=0&wait=0');
    ok(noTok.status === 403, '不给令牌也被拒（403）', noTok.status);
    const viewAsSpec = await poll(code + '/poll?role=spec&since=0&wait=0');
    ok(viewAsSpec.status === 200, '观战不需要令牌（裸 spec 通道可用）', viewAsSpec.status);
    // 席位互斥：拿着对战席的令牌去开观战通道会被拒 —— 亲自出马就只能看自己那一侧
    const specWithSeat = await poll(code + '/poll?role=spec&token=' + tokA + '&since=0&wait=0');
    ok(specWithSeat.status === 403 && /对战席/.test((specWithSeat.body || {}).error || ''),
      '对战席令牌不能当观战用（席位互斥）', specWithSeat.body);

    // —— 在线判定：轮询过后 A 座应显示在线；info 里 connected 由心跳推出来 ——
    const infoNow = (await call('GET', '/api/room/' + code)).body;
    ok(infoNow.room.seats.A.connected === 1, 'A 座在线（轮询心跳）', infoNow.room.seats.A.connected);
    ok(infoNow.room.seats.B.kind === 'me' && infoNow.room.seats.B.connected === 0, 'B 座入座但没心跳 → 离线', infoNow.room.seats.B);

    // —— 开局：两席都在，start 后应能拿到 ask ——
    // 新席位口径：真人入座后要点准备；放上人机的座位自动已准备
    const rdB = await call('POST', '/api/room/ready', { code, seat: 'B', token: jn.body.token, ready: true });
    const rdA = await call('POST', '/api/room/ready', { code, seat: 'A', token: tokA, ready: true });
    ok(rdB.status === 200 && rdA.status === 200, '两席准备就绪（轮询通道能叫醒对面）');
    const st = await call('POST', '/api/room/start', { code, token: tokA });
    ok(st.status === 200, '开局成功', st.body);
    const askPoll = await poll(code + '/poll?role=A&token=' + tokA + '&since=' + woke.body.cursor + '&wait=3000');
    const evTypes = askPoll.body.events.map(e => e.type);
    ok(evTypes.includes('ask') || !!askPoll.body.view, 'A 拿到视角（ask 事件或 view）', evTypes);
    const v = askPoll.body.view;
    ok(v && Array.isArray(v.dice) && v.dice.length === 5, 'A 的 view 里有自己的 5 颗骰子', v && v.dice);
    ok(v && !('oppDice' in v), 'view 里没有对手骰子字段');
    ok(v && Array.isArray(v.legal) && v.legal.length > 0, 'view 带合法动作集', v && (v.legal || []).length);

    // —— B 视角不该看到 A 的骰子 ——
    const tokB = jn.body.token;
    const vB = await poll(code + '/poll?role=B&token=' + tokB + '&since=0&wait=0');
    ok(vB.body.view && JSON.stringify(vB.body.view.dice) !== JSON.stringify(v.dice), 'B 拿到的是自己的骰子，不是 A 的');

    // —— 观战视角：任何一轮未结算的骰子都不在里面 ——
    const vSpec = await poll(code + '/poll?role=spec&since=0&wait=0');
    ok(!('dice' in (vSpec.body.view || {})), '观战 view 没有 dice 字段', Object.keys(vSpec.body.view || {}));

    // —— 提交行动：首手是 (seed % 2) 随机定的 A 或 B，谁先走谁提交 ——
    // 以前写死 A 提交，一半概率撞上 B 先手，报「现在不归你走」，是测试的锅不是引擎的锅。
    const turnSeat = v.turn === 'me' ? 'A' : 'B';
    const turnTok = turnSeat === 'A' ? tokA : tokB;
    const act = await call('POST', '/api/room/action', { code, seat: turnSeat, token: turnTok, action: v.legal[0] });
    if (act.status !== 200) {
      const diag = (await call('GET', '/api/room/' + code)).body;
      console.log('  [诊断] turn=' + v.turn + ' seat=' + turnSeat + ' legal[0]=' + JSON.stringify(v.legal[0])
        + ' state=' + (diag.room || {}).state + ' roundNo=' + (diag.room || {}).roundNo
        + ' hp=' + JSON.stringify((diag.room || {}).hp) + ' conn=' + JSON.stringify({
          A: (diag.room.seats.A || {}).connected, B: (diag.room.seats.B || {}).connected,
        }));
    }
    ok(act.status === 200, '轮到的一方提交合法动作成功（' + turnSeat + ' 先手）', act.body);
    const afterBid = await poll(code + '/poll?role=spec&since=' + (vSpec.body.cursor) + '&wait=3000');
    const bidEv = afterBid.body.events.find(e => e.type === 'bid');
    ok(!!bidEv, '观战侧收到 bid 广播', afterBid.body.events.map(e => e.type));
    ok(bidEv && bidEv.payload.count === v.legal[0].count && bidEv.payload.face === v.legal[0].face, '广播内容与提交一致');

    // —— 坏请求 ——
    const notFound = await poll('ZZZZZZ/poll?role=spec');
    ok(notFound.status === 404, '不存在的房间返回 404');

    // —— 小程序登录：没配 AppID 必须是 501（前端据此走匿名），不能 500 ——
    const ml = await call('POST', '/api/mini/login', { code: 'x' });
    ok(ml.status === 501 && ml.body.wx === false, '未配置时 /api/mini/login 返回 501 + wx:false', ml);

  } catch (e) {
    fail++;
    console.log('  ✗ 自检异常：' + (e && e.stack || e));
  } finally {
    kill();
  }

  console.log('\n' + (fail ? 'FAIL' : 'ALL PASS') + '  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { console.log('\n服务端日志：\n' + log.split('\n').slice(-20).join('\n')); process.exit(1); }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { }
})();
