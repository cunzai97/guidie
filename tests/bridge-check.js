/* 桥接自检：云上平台的「平台预设」座位真经 llm-relay 的桥打一手。
 * 证明的是链路：云上平台 → 云机 loopback 18444 → ssh -R 隧道 → 家里鉴权网关 → web-llama。
 * 会真花钱（一次几个请求），零 Key 打印：钥匙只从 presets.json 读进内存，不进输出。
 *
 * 用法：BASE=http://127.0.0.1:18899 PRESET=home-llm node tests/bridge-check.js
 */
'use strict';
const BASE = process.env.BASE || 'http://127.0.0.1:18898';
const PRESET = process.env.PRESET || 'home-llm';
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

(async () => {
  const ping = (await api('/api/ping')).body;
  if (!ping || !ping.ok) { console.log('平台没起来：', BASE); process.exit(2); }
  const p = (ping.models || []).find(m => m.id === PRESET);
  console.log('平台预设：', p ? `${p.alias} · ${p.model} · hasKey=${p.hasKey} · host=${p.host}` : '（没有这个预设）');
  console.log('出网放行端口：', JSON.stringify(ping.policy.localPorts));
  if (!p || !p.hasKey) { console.log('✗ 这一座不可用 —— 先跑 deploy/wire-bridge.sh'); process.exit(1); }

  const reg = await api('/api/signup', { nick: 'bridge' + Math.random().toString(36).slice(2, 6), pass: 'pass1234' });
  const tok = reg.body.token;
  const c = await api('/api/room/create', {
    seats: { A: { kind: 'preset', presetId: PRESET, guideText: '只准走最小合法加价，别急着开盅。' }, B: { kind: 'bot', bot: 'reader' } },
    rules: 'flex', hpMax: 2, turnMs: 90000, maxRounds: 3, duplicate: false, tokenBudget: 120000,
  }, tok);
  if (c.status !== 200) { console.log('✗ 建桌失败：', c.body); process.exit(1); }
  const code = c.body.code;
  let go = null, usage = null, warn = null;
  const st = await fetch(BASE + '/api/room/' + code + '/stream?role=spec');
  const dec = new TextDecoder(); let buf = '';
  (async () => {
    for await (const ch of st.body) {
      buf += dec.decode(ch, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = raw.match(/event: (\w+)\ndata: ([\s\S]*)/);
        if (!m) continue;
        try { const d = JSON.parse(m[2]); if (m[1] === 'gameover') go = d; if (m[1] === 'usage') usage = d; if (m[1] === 'seatwarn') warn = d; } catch (e) { }
      }
    }
  })().catch(() => { });
  const s = await api('/api/room/start', { code }, tok);
  console.log('开局：', s.status === 200 ? 'ok' : JSON.stringify(s.body));
  for (let i = 0; i < 3600 && !go; i++) await sleep(50);
  try { st.body.cancel(); } catch (e) { }
  if (!go) { console.log('✗ 没等到结算', warn ? '（连接告警：' + warn.error + '）' : ''); process.exit(1); }
  console.log('整局结果：胜者 ' + (go.winner || '无') + '，血量 ' + JSON.stringify(go.hp) + '，' + go.rounds + ' 轮');
  console.log('模型调用统计：', JSON.stringify(usage));
  if (warn) console.log('连接告警（可能被夹 max_tokens 或限流）：', warn.error);
  const okTok = usage && usage.calls > 0 && usage.promptTokens > 0;
  console.log(okTok ? '==> 桥接通了：模型确实经隧道回你机器答了话' : '==> 没拿到 token 统计，模型可能没真答');
  process.exit(okTok ? 0 : 1);
})().catch(e => { console.log('炸了', e && e.message || e); process.exit(2); });
