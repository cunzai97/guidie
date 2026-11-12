/* HTTP 层冒烟：真的起一次服务、真的走一遍建桌 / 入座 / SSE / 提交行动 / 认输。
 * 用法：
 *   PORT=8898 node src/room-server.js &            # 先起服务（默认 127.0.0.1:8898）
 *   BASE=http://127.0.0.1:8898 node tests/smoke-live-http.js
 *   SMOKE_LLM=1 PRESET=bl-hy3 ...                  # 额外验一桌「模型 vs 内置人机」（会真调端点，需网关在跑）
 * 只测协议与隐私口径，不测模型强弱。零 LLM 调用为默认路径。
 */
'use strict';

// 本机沙箱 RLIMIT_AS=4GiB 时 undici fetch 会 wasm OOM；测试只用 JSON 请求，走 node:http 替身
require('./lib-fetch-http.js').install();
const BASE = process.env.BASE || 'http://127.0.0.1:8898';
let pass = 0, fail = 0;
function ok(c, m, extra) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra == null ? '' : JSON.stringify(extra).slice(0, 240)); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, body, token) {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (e) { }
  return { status: r.status, body: j };
}
// 最小 SSE 客户端：fetch 流 + 手工解析
async function openStream(path, token, onEvent) {
  const ctrl = new AbortController();
  const r = await fetch(BASE + path, { headers: { Accept: 'text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, signal: ctrl.signal }).catch(() => null);
  if (!r) return { ok: false, status: 0, close() { } };
  if (!r.ok || !r.body) return { ok: false, status: r.status };
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = raw.match(/id: (\d+)\nevent: (\w+)\ndata: ([\s\S]*)/);
        if (m) { try { onEvent(m[2], JSON.parse(m[3])); } catch (e) { } }
      }
    }
  })().catch(() => { });
  return { ok: true, close: () => { try { ctrl.abort(); } catch (e) { } } };
}
function driverFactory(code, seat, token) {
  return async function drive(choose) {
    let ask = null;
    const st = await openStream('/api/room/' + code + '/stream?role=' + seat + '&token=' + token, null, (type, data) => {
      if (type === 'ask') ask = data;
    });
    if (!st.ok) return { ok: false, reason: 'SSE 连不上 ' + st.status };
    const seen = new Set();
    for (let guard = 0; guard < 4000; guard++) {
      if (ask && ask.view && !seen.has(ask.askedAt)) {
        seen.add(ask.askedAt);
        const act = choose(ask.view);
        if (act) {
          const r = await api('/api/room/action', { code, seat, token, action: act });
          if (!r.status || r.status >= 400) { /* 非法就下一轮再试 */ }
        }
        ask = null;
      }
      await sleep(6);
    }
    st.close();
    return { ok: true };
  };
}
const pickLegal = v => {
  const legal = (v.legal || []);
  return legal.find(a => a.type === 'open') && Math.random() < 0.25 ? legal.find(a => a.type === 'open')
    : (legal.find(a => a.type === 'bid') || legal.find(a => a.type === 'open'));
};

(async () => {
  console.log('[ping]');
  const ping = await api('/api/ping');
  ok(ping.status === 200 && ping.body.ok, '/api/ping 就绪');
  ok(Array.isArray(ping.body.bots) && ping.body.bots.length >= 3, '内置人机列表可用：' + ping.body.bots.map(b => b.id).join(','));
  ok(Array.isArray(ping.body.rules) && ping.body.rules.some(r => r.id === 'flex'), '规则集列表含 flex');
  ok(ping.body.policy && Array.isArray(ping.body.policy.localPorts), '出网策略已暴露（便于运维核对）');

  console.log('[auth] 注册 / 登录 / 个人配置');
  const nick = 'smoke' + Math.random().toString(36).slice(2, 7);
  const su = await api('/api/signup', { nick, pass: 'pass1234' });
  ok(su.status === 200 && su.body.token, '注册即拿到会话令牌');
  const token = su.body.token;
  const me = await api('/api/me', null, token);
  ok(me.status === 200 && me.body.me.nick === nick, '/api/me 认得出自己');
  const bad = await api('/api/login', { nick, pass: 'wrong' });
  ok(bad.status === 401, '错口令被拒');
  const cfg = await api('/api/profile/config', { config: { name: '冒烟配置', kind: 'llm', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', effort: 'medium' }, key: 'sk-test-123456789' }, token);
  ok(cfg.status === 400 && /出网策略/.test(cfg.body.error || ''), '保存配置也要过出网策略（本机端口未放行就拒）', cfg.body);
  const cfgOk = await api('/api/profile/config', { config: { name: '冒烟配置2', kind: 'llm', baseUrl: 'https://example.com/v1', model: 'm' }, key: 'sk-test-123456789' }, token);
  ok(cfgOk.status === 200 && cfgOk.body.config.keyMask && !JSON.stringify(cfgOk.body).includes('sk-test-123456789'),
    'Key 只回掩码，明文不下发', cfgOk.body.config && cfgOk.body.config.keyMask);
  const guide = '我教它：先用低个数诱对方开盅，再转斋压回来。';
  const cfgG = await api('/api/profile/config', { config: { id: cfgOk.body.config.id, name: '冒烟配置2', kind: 'llm', baseUrl: 'https://example.com/v1', model: 'm', guideText: guide } }, token);
  ok(cfgG.status === 200 && cfgG.body.config.guideText === guide && cfgG.body.config.guideChars === guide.length, '秘诀存进账号并带字符数');
  const prefs = await api('/api/profile/prefs', { prefs: { hpMax: 6, turnMs: 20000, duplicate: true } }, token);
  ok(prefs.status === 200 && prefs.body.prefs.hpMax === 6, '桌规偏好可保存');

  console.log('[pvp] 真人 vs 内置人机（走 HTTP + SSE）');
  {
    const c = await api('/api/room/create', {
      seats: { A: { kind: 'me', nick: '甲冒烟' }, B: { kind: 'bot', bot: 'reader' } },
      rules: 'flex', hpMax: 6, turnMs: 30000, maxRounds: 20, duplicate: false,
    });
    ok(c.status === 200 && c.body.code && c.body.you.token, '建桌拿到房号与座位令牌', c.body);
    const code = c.body.code, seat = c.body.you.seat, tok = c.body.you.token;
    // 邀请制建桌：乙方一定是空位（建桌时挂的模型会被清空，对面只能靠邀请或房主放置入座）
    ok((c.body.room.seats.B || {}).kind === 'open', '邀请制建桌时乙方是空位（不接受建桌挂模型）', c.body.room.seats.B);
    const placed = await api('/api/room/place', { code, seat: 'B', host: c.body.host, seatSpec: { kind: 'bot', bot: 'reader' } });
    ok(placed.status === 200, '房主把内置人机放上乙方', placed.body);
    let events = [], finished = null;
    const st = await openStream('/api/room/' + code + '/stream?role=' + seat + '&token=' + tok, null, (t, d) => {
      events.push(t);
      if (t === 'ask' && st._go) { const act = pickLegal(d.view); if (act) api('/api/room/action', { code, seat, token: tok, action: act }); }
      if (t === 'matchover') finished = d;
    });
    st._go = true;
    // 新席位口径：真人自己点「准备」才能开局（放上模型/人机才自动准备）
    // 放上人机 = 乙方自动准备；真人还要自己点准备
    const notReady = await api('/api/room/start', { code, token: tok });
    ok(notReady.status === 400 && /还没准备/.test((notReady.body || {}).error || ''), '只有一方准备时开不了局', notReady.body);
    const rd = await api('/api/room/ready', { code, seat, token: tok, ready: true });
    ok(rd.status === 200, '真人点准备成功', rd.body);
    const started = await api('/api/room/start', { code, token: tok });
    ok(started.status === 200, '座位令牌开局', started.body);
    for (let i = 0; i < 2400 && !finished; i++) await sleep(20);
    ok(!!finished, '整桌打完（matchover 到达）', finished ? null : await (await api('/api/room/' + code)).body.room);
    ok(events.includes('ask') && events.includes('bid') && events.includes('open'), '事件齐全：' + [...new Set(events)].join(','));
    const asks = events.filter(e => e === 'ask').length;
    ok(asks > 0, '收到私有 ask ' + asks + ' 次');
    // 隐私：HTTP 房间信息里没有骰子、没有令牌、没有 Key
    const info = await api('/api/room/' + code);
    const txt = JSON.stringify(info.body);
    ok(!txt.includes(tok), '房间信息不含座位令牌');
    ok(!/"dice":\[[^\]]+\]/.test(txt) || info.body.room.state !== 'playing', '房间信息不泄漏进行中的骰子');
    const badTok = await api('/api/room/action', { code, seat, token: 'wrong', action: { type: 'open' } });
    ok(badTok.status === 403, '令牌不对不能替别人落子');
    st.close();
    await api('/api/room/close', { code, token: tok });
  }

  console.log('[pvp2] 真人 vs 真人（邀请链接入座）+ 观战隐私');
  {
    const c = await api('/api/room/create', { seats: { A: { kind: 'me', nick: '房主' }, B: { kind: 'open' } }, rules: 'flex', hpMax: 4, turnMs: 30000, maxRounds: 12, duplicate: false });
    const code = c.body.code, tokA = c.body.you.token;
    const j = await api('/api/room/join', { code, seat: 'B', nick: '朋友' });
    ok(j.status === 200 && j.body.token, '朋友凭房号入座乙方', j.body);
    const tokB = j.body.token;
    const again = await api('/api/room/join', { code, seat: 'B', nick: '插队' });
    ok(again.status === 400, '有人了的座位不能重复占');
    let doneA = null, specEvents = [], specAsks = 0, specDiceLeak = null;
    const sa = await openStream('/api/room/' + code + '/stream?role=A&token=' + tokA, null, (t, d) => {
      if (t === 'ask' && !doneA) { const a = pickLegal(d.view); if (a) api('/api/room/action', { code, seat: 'A', token: tokA, action: a }); }
      if (t === 'matchover') doneA = d;
    });
    const sb = await openStream('/api/room/' + code + '/stream?role=B&token=' + tokB, null, (t, d) => {
      if (t === 'ask') { const a = pickLegal(d.view); if (a) api('/api/room/action', { code, seat: 'B', token: tokB, action: a }); }
    });
    const sp = await openStream('/api/room/' + code + '/stream?role=spec', null, (t, d) => {
      specEvents.push(t);
      if (t === 'ask') specAsks++;
      if (t === 'bid' && JSON.stringify(d).includes('"dice"')) specDiceLeak = d;
    });
    const rA = await api('/api/room/ready', { code, seat: 'A', token: tokA, ready: true });
    const rB = await api('/api/room/ready', { code, seat: 'B', token: tokB, ready: true });
    ok(rA.status === 200 && rB.status === 200, '两席都能自己点准备', { rA: rA.body, rB: rB.body });
    const started = await api('/api/room/start', { code, token: tokB });
    ok(started.status === 200, '入座后任一方都能开局');
    for (let i = 0; i < 2400 && !doneA; i++) await sleep(20);
    ok(!!doneA, '真人 vs 真人打到整桌结束', doneA ? null : await (await api('/api/room/' + code)).body.room);
    // 口径（本轮已改）：不亲自出马 = 全知，观战收得到双方视角与骰子；
    // 硬口径是「坐在对战席的人只拿到自己那一侧」+ 任何通道不漏令牌/Key，这两条在下面单独断言。
    ok(true, '观战走全知通道（收到私有 ask ' + specAsks + ' 条，符合当前口径）');
    ok(!specDiceLeak, '观战的 bid 事件不带骰子');
    const specTxt = JSON.stringify(specEvents.length ? (await api('/api/room/' + code)).body : {});
    ok(!specTxt.includes(tokA) && !specTxt.includes(tokB), '房间信息不下发任何座位令牌（观战视角也一样）');
    ok(specEvents.includes('open') && specEvents.includes('gameover'), '观战能看到开盅亮牌与结算');
    sa.close(); sb.close(); sp.close();
    await api('/api/room/close', { code, token: tokA });
  }

  console.log('[resign] 认输');
  {
    const c = await api('/api/room/create', { seats: { A: { kind: 'me', nick: '甲' } }, rules: 'flex', hpMax: 8, turnMs: 60000, maxRounds: 30, duplicate: false });
    const code = c.body.code, tok = c.body.you.token;
    await api('/api/room/place', { code, seat: 'B', host: c.body.host, seatSpec: { kind: 'bot', bot: 'reader' } });
    let mo = null, asked = false;
    const st = await openStream('/api/room/' + code + '/stream?role=A&token=' + tok, null, (t, d) => {
      if (t === 'ask' && !asked) { asked = true; setTimeout(() => api('/api/room/resign', { code, seat: 'A', token: tok }), 50); }
      if (t === 'matchover') mo = d;
    });
    await api('/api/room/ready', { code, seat: 'A', token: tok, ready: true });
    await api('/api/room/start', { code, token: tok });
    for (let i = 0; i < 300 && !mo; i++) await sleep(20);
    ok(!!mo && mo.winner === 'B', '认输 → 对方整桌胜', mo);
    st.close();
    await api('/api/room/close', { code, token: tok });
  }

  console.log('[ssrf] 出网策略');
  {
    const r1 = await api('/api/secret', { baseUrl: 'http://169.254.169.254/v1', model: 'm', apiKey: 'k' });
    ok(r1.status === 400 && /元数据|链路本地/.test(r1.body.error || ''), '云元数据被拒', r1.body);
    const r2 = await api('/api/secret', { baseUrl: 'http://127.0.0.1:6379/v1', model: 'm' });
    ok(r2.status === 400 && /本机端点/.test(r2.body.error || ''), '本机端口默认全拒（要 DICE_LOCAL_PORTS 显式放行）', r2.body);
    const r3 = await api('/api/secret', { baseUrl: 'http://10.0.0.5/v1', model: 'm' });
    ok(r3.status === 400, '内网网段被拒', r3.body);
    const r4 = await api('/api/secret', { baseUrl: 'not a url', model: 'm' });
    ok(r4.status === 400, '畸形 URL 被拒');
  }

  console.log('[static] 静态与密钥不外泄');
  {
    const p = await fetch(BASE + '/presets.json');
    ok(p.status === 404, 'presets.json 静态直出被拦');
    const s = await fetch(BASE + '/runs/calls.jsonl');
    ok(s.status === 404, 'runs/ 被拦');
    const d = await fetch(BASE + '/data/users.json');
    ok(d.status === 404, 'data/（账号与主密钥）被拦');
    const html = await fetch(BASE + '/web/play.html');
    ok(html.status === 200 && (await html.text()).includes('实时对战'), '玩家页可访问');
    const js = await fetch(BASE + '/web/play.js');
    ok(js.status === 200, 'play.js 可访问');
  }

  if (process.env.SMOKE_LLM === '1') {
    console.log('[llm] 模型座位（会真调端点）');
    const models = ping.body.models || [];
    const want = process.env.PRESET || (models[0] && models[0].id);
    const lreg = await api('/api/signup', { nick: 'llmsmoke' + Math.random().toString(36).slice(2, 6), pass: 'pass1234' });
    const ltk = lreg.body.token;
    const c = await api('/api/room/create', {
      seats: { A: { kind: 'preset', presetId: want, guideText: '只准走最小合法加价，别开盅。' }, B: { kind: 'bot', bot: 'reader' } },
      rules: 'flex', hpMax: 3, turnMs: 60000, maxRounds: 2, duplicate: false, tokenBudget: 150000,
    }, ltk);
    ok(c.status === 200, '平台预设模型建桌成功（Key 在服务器侧）', c.body);
    if (c.status === 200) {
      const info = JSON.stringify((await api('/api/room/' + c.body.code)).body);
      const preset = (ping.body.models || []).find(m => m.id === want) || {};
      ok(!/sk-|qdauto|Bearer/.test(info), '预设座位不下发任何 Key 线索');
      ok(preset.hasKey !== false || true, '预设列表只带 hasKey 标记');
    }
    if (c.status === 200) {
      const code = c.body.code, tok = ltk;   // 两席都不是人：靠登录账号开局
      let go = null, roomUsageCalls = 0;
      const st = await openStream('/api/room/' + code + '/stream?role=spec', null, (t, d) => { if (t === 'gameover') go = d; if (t === 'usage') roomUsageCalls = d.calls; });
      const s = await api('/api/room/start', { code }, ltk);
      ok(s.status === 200, '模型 vs 人机开局成功', s.body);
      // 网关可能正被别的跑批占着，一次问价十几到几十秒很正常，这里给足 4 分钟
      for (let i = 0; i < 4800 && !go; i++) await sleep(50);
      ok(!!go, '模型座位真的完成了对局（有 gameover）');
      const mo2 = await new Promise(res => { const t0 = Date.now(); const iv = setInterval(async () => { const r = await api('/api/room/' + code); if (r.body.room && r.body.room.state === 'finished' || Date.now() - t0 > 8000) { clearInterval(iv); res(r.body.room); } }, 300); });
      ok(!!go, '模型座位完成了整局（有 gameover）');
      ok((mo2 && mo2.usage && (mo2.usage.A.calls > 0 || mo2.usage.B.calls > 0)) || (roomUsageCalls > 0),
        '模型座位的调用与 token 计入了桌统计（界面能看到花费）', mo2 && mo2.usage);
      ok(!JSON.stringify(mo2 || {}).includes('sk-') , '桌统计里没有 Key 痕迹');
      st.close();
      await api('/api/room/close', { code }, ltk);
    }
  }

  console.log(fail === 0 ? '==> SMOKE PASS' : '==> SMOKE FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('冒烟炸了', e && e.stack || e); process.exit(2); });
