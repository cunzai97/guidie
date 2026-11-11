/* 云托管传输层自检：不依赖真实云环境，用假的 wx.cloud.callContainer 验协议。
 *
 * 验的不是「云托管好不好用」，而是「换通道之后请求长什么样」：
 *   - path 必须是相对路径（带 query 也要保留）
 *   - 服务名必须进 header X-WX-SERVICE，否则打到别的服务
 *   - 不能把 timeout 传给 SDK（官方对上限的说法不一致，1.5s 那条会直接废掉长轮询）
 *   - 长轮询挂起时间要跟着通道收紧到 15s 以内
 *   - 出错时要能告诉人下一步干什么（域名没配 / 云环境没开 / 单纯连不上）
 */
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const ROOT = path.join(__dirname, '..');
const CFG_PATH = require.resolve(path.join(ROOT, 'miniprogram/config.js'));
const API_PATH = require.resolve(path.join(ROOT, 'miniprogram/utils/api.js'));
const ORIG_CFG = require(CFG_PATH);

const store = {};
const calls = [];
let nextFail = null;

global.wx = {
  cloud: {
    init(o) { calls.push({ kind: 'init', o }); },
    callContainer(o) {
      calls.push({ kind: 'container', o });
      setTimeout(() => {
        if (nextFail) { const f = nextFail; nextFail = null; return o.fail(f); }
        o.success({ statusCode: 200, data: { ok: true, echoed: o.path } });
      }, 0);
    },
  },
  getStorageSync: k => store[k] || '',
  setStorageSync: (k, v) => { store[k] = v; },
  request(o) {
    calls.push({ kind: 'request', o });
    setTimeout(() => o.success({ statusCode: 200, data: { ok: true, via: 'request' } }), 0);
    return { abort() { } };
  },
};

// 每个用例用不同的 config 重新加载 api，避免模块级 cloudInited 串味
function loadApi(over) {
  delete require.cache[CFG_PATH];
  delete require.cache[API_PATH];
  require.cache[CFG_PATH] = {
    id: CFG_PATH, filename: CFG_PATH, loaded: true, children: [], paths: [],
    exports: Object.assign({}, ORIG_CFG, over),
  };
  return require(API_PATH);
}

const CLOUD_OK = { TRANSPORT: 'cloud', CLOUD: { env: 'prod-3gxxx', service: 'guidie' } };

(async () => {
  // —— 云通道：正常请求 ——
  calls.length = 0;
  store.transport = 'cloud';
  let api = loadApi(CLOUD_OK);
  ok(api.kind() === 'cloud', '传输通道识别为 cloud');

  let r = await api.get('/api/ping');
  ok(r && r.ok === true, 'cloud 模式下请求成功');
  const c1 = calls.find(c => c.kind === 'container');
  ok(!!c1, '走的是 callContainer 而不是 wx.request');
  ok(c1 && c1.o.path === '/api/ping', 'path 原样传相对路径', c1 && c1.o.path);
  ok(c1 && c1.o.header && c1.o.header['X-WX-SERVICE'] === 'guidie', 'header 带 X-WX-SERVICE', c1 && c1.o.header);
  ok(c1 && c1.o.config && c1.o.config.env === 'prod-3gxxx', 'config.env 是云环境 ID', c1 && c1.o.config);
  ok(c1 && !('timeout' in c1.o), '不把 timeout 塞给 SDK（官方上限说法矛盾）', c1 && Object.keys(c1.o));
  ok(calls.some(c => c.kind === 'init'), '首次调用前做了 wx.cloud.init');

  // —— query 必须保留，长轮询全靠它 ——
  calls.length = 0;
  await api.get('/api/room/ABCDEF/poll?role=A&since=12&wait=10000');
  const c2 = calls.find(c => c.kind === 'container');
  ok(c2 && c2.o.path === '/api/room/ABCDEF/poll?role=A&since=12&wait=10000', 'query 参数完整保留', c2 && c2.o.path);

  // —— 有人传了完整 URL 也要剥成相对路径，否则网关 404 ——
  calls.length = 0;
  await api.get('http://192.168.1.9:8898/api/me');
  const c3 = calls.find(c => c.kind === 'container');
  ok(c3 && c3.o.path === '/api/me', '完整 URL 被剥成相对路径', c3 && c3.o.path);

  // —— 长轮询预算：cloud 模式必须收进 15s ——
  ok(api.pollWait() <= 10000, 'cloud 模式挂起 ≤ 10s', api.pollWait());
  ok(api.pollTimeout() <= 15000, 'cloud 模式客户端超时 ≤ 15s', api.pollTimeout());

  // —— 域名被拦：要给出可操作的下一步 ——
  api = loadApi(CLOUD_OK);
  nextFail = { errMsg: 'callContainer:fail url not in domain list' };
  let e1 = null;
  try { await api.get('/api/ping'); } catch (e) { e1 = e; }
  ok(e1 && e1.domain === true, '域名未登记时标记 domain', e1 && e1.message);
  ok(e1 && /开发调试/.test(e1.message), '提示里告诉用户去打开调试', e1 && e1.message);

  // —— 云环境没配：要明确说「去填 CLOUD.env」，而不是丢一个 undefined ——
  store.transport = 'cloud';
  api = loadApi({ TRANSPORT: 'cloud', CLOUD: { env: '', service: '' } });
  let e2 = null;
  try { await api.get('/api/ping'); } catch (e) { e2 = e; }
  ok(e2 && e2.cloud === true, '没配云环境时标记 cloud');
  ok(e2 && /CLOUD\.env/.test(e2.message), '报错里点名要改哪个字段', e2 && e2.message);

  // —— 切回直连：必须回到 wx.request ——
  calls.length = 0;
  store.transport = 'http';
  api = loadApi({ TRANSPORT: 'http', BASE_URL: 'http://10.0.0.5:8898', REQUEST_TIMEOUT_MS: 32000, POLL_WAIT_MS: 25000 });
  const r3 = await api.get('/api/ping');
  ok(r3 && r3.via === 'request', 'http 模式走 wx.request');
  const c4 = calls.find(c => c.kind === 'request');
  ok(c4 && c4.o.url === 'http://10.0.0.5:8898/api/ping', 'http 模式拼的是 BASE_URL', c4 && c4.o.url);
  ok(api.pollWait() === 25000, 'http 模式挂起回到 25s', api.pollWait());

  // —— 运行时改地址优先级高于内置 ——
  store.baseUrl = 'http://172.16.0.9:9000/';
  api = loadApi({ TRANSPORT: 'http', BASE_URL: 'http://10.0.0.5:8898', REQUEST_TIMEOUT_MS: 32000, POLL_WAIT_MS: 25000 });
  calls.length = 0;
  await api.get('/api/ping');
  const c5 = calls.find(c => c.kind === 'request');
  ok(c5 && c5.o.url === 'http://172.16.0.9:9000/api/ping', '本机覆盖的地址优先，且去掉尾斜杠', c5 && c5.o.url);

  console.log('\n' + (fail ? 'FAIL' : 'ALL PASS') + '  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试自身炸了:', e); process.exit(1); });
