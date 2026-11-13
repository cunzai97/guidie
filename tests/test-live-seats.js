#!/usr/bin/env node
/* 座位卫生：一人两席 / 幽灵席位 / 观战席回收
 *
 * 现场：云端一张桌出现「甲方·玩家（真人·离线）」+「观战席 2·玩家」两个同名的空壳，
 * 排行榜又堆着一串匿名「玩家」。这里把三条根因逐条钉住：
 *   [1] 匿名观众坐下时，旧的观战席必须清掉（以前只按 userId 认人，匿名清不掉）
 *   [2] 同一个 watchToken 反复进观战，复用同一席（不再一人占三席）
 *   [3] 纯观战的人点离桌，观战席要真的空出来（以前拿座位令牌比观战令牌，永远对不上）
 *   [4] 关掉页面的对战席：连续离线 SEAT_TTL 之后被回收；有轮询心跳就不动
 *   [5] 已经开打的桌不回收对战席（席位归对局管，掉线认输另有一套宽限）
 *   [6] 没人看的时候，超时的观战席被回收；有人挂着观战连接时不动
 */
process.env.DICE_SEAT_TTL_MS = String(10 * 60 * 1000);
process.env.DICE_WATCH_TTL_MS = String(15 * 60 * 1000);

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Registry } = require('../src/rooms.js');
const { Vault } = require('../src/secrets.js');
const { Accounts } = require('../src/accounts.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seats-'));
function makeRegistry() {
  const dir = tmp();
  const vault = new Vault(dir);
  const accounts = new Accounts(dir, vault);
  const reg = new Registry({
    vault, accounts,
    policy: { localPorts: [9], allowHosts: [] },
    presets: () => ({ list: [], ruleSets: [] }),
    recordFile: path.join(dir, 'matches-live.jsonl'),
  });
  return reg;
}
const MIN = 60 * 1000;
let fail = 0;
function ok(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); fail++; }
}
const watchNick = room => ['S1', 'S2', 'S3'].map(k => (room.watch[k] || {}).nick || '').filter(Boolean);

/* ---------------- [1] 匿名观众坐下：旧观战席必须清掉 ---------------- */
console.log('[1] 匿名观众坐进对战席，观战席要一起空出来');
{
  const reg = makeRegistry();
  const room = reg.create({ seats: { A: { kind: 'open' } }, rules: 'flex' });
  // 匿名进来观战（没有账号，昵称回落成「玩家」）
  const w = reg.watchSeat(room.code, { nick: '玩家' });
  ok(w.ok && w.slot, '匿名观众拿到观战席 ' + w.slot);
  ok(watchNick(reg.get(room.code)).length === 1, '服务端此刻只有 1 个观战席被占');

  // 同一个人坐进甲方（带观战令牌）
  const j = reg.join(room.code, 'A', { nick: '玩家', watchToken: w.token });
  ok(j.ok && j.seat === 'A', '坐进甲方成功');
  const after = reg.get(room.code);
  ok(watchNick(after).length === 0, '旧观战席已清空（以前会留下「观战席 2 · 玩家」）');
  ok(after.seats.A.nick === '玩家' && watchNick(after).length === 0, '一个人只占一个位置');
}

/* ---------------- [2] 同一个 watchToken 复用同一席 ---------------- */
console.log('[2] 同一个观战令牌刷新/重进，不新增席位');
{
  const reg = makeRegistry();
  const room = reg.create({ seats: { A: { kind: 'open' } }, rules: 'flex' });
  const a = reg.watchSeat(room.code, { nick: '甲游客' });
  const b = reg.watchSeat(room.code, { nick: '乙游客', watchToken: a.token });
  const c = reg.watchSeat(room.code, { nick: '丙游客', watchToken: a.token });
  ok(a.slot === b.slot && b.slot === c.slot, '三次进观战都落在同一席 ' + a.slot);
  ok(watchNick(reg.get(room.code)).length === 1, '观战席只占 1 个（以前换昵称就多占一席）');
}

/* ---------------- [3] 纯观战离桌 ---------------- */
console.log('[3] 纯观战的人点离桌，观战席要真的空出来');
{
  const reg = makeRegistry();
  const room = reg.create({ seats: { A: { kind: 'open' } }, rules: 'flex' });
  reg.join(room.code, 'A', { nick: '坐着的' });          // 桌上有人在，桌才不会被「空桌回收」顺手关掉
  const w = reg.watchSeat(room.code, { nick: '路人' });
  const r = reg.leave(room.code, { watchToken: w.token });
  ok(r.ok, '离开接口返回 ok');
  ok(!r.closed, '桌上还有别人，桌不该被关掉');
  ok(watchNick(reg.get(room.code)).length === 0, '观战席已清空');
}

/* ---------------- [4] 离线对战席回收 ---------------- */
console.log('[4] 关掉页面的对战席，超时后放出来');
{
  const reg = makeRegistry();
  const room = reg.create({ seats: { A: { kind: 'open' }, B: { kind: 'open' } }, rules: 'flex' });
  const j = reg.join(room.code, 'A', { nick: '僵尸' });
  ok(j.ok, '匿名坐进甲方');
  const rm = reg.get(room.code);
  // 模拟：没有任何连接、也没有轮询心跳（关掉页面）
  rm.seats.A.connected = 0;
  rm.pollAt.A = 0;
  rm.seats.A.offSince = Date.now() - 11 * MIN;      // 已经离线 11 分钟（阈值 10 分钟）
  const reaped = reg.reapIdleSeats(rm, Date.now());
  ok(reaped === true, 'GC 报告回收了席位');
  ok(reg.get(room.code).seats.A.kind === 'open', '甲方空出来了（不再显示「真人 · 离线」）');

  // 反向：有轮询心跳的席位不能动
  const room2 = reg.create({ seats: { A: { kind: 'open' } }, rules: 'flex' });
  reg.join(room2.code, 'A', { nick: '在线的' });
  const rm2 = reg.get(room2.code);
  rm2.pollAt.A = Date.now() - 2000;                  // 2 秒前刚拉过事件
  rm2.seats.A.offSince = Date.now() - 11 * MIN;
  reg.reapIdleSeats(rm2, Date.now());
  ok(reg.get(room2.code).seats.A.kind === 'me', '心跳还热着的席位不动');
}

/* ---------------- [5] 开打中的桌不回收 ---------------- */
console.log('[5] 已经开打的桌，席位不归 GC 管');
{
  const reg = makeRegistry();
  const room = reg.create({ seats: { A: { kind: 'open' }, B: { kind: 'open' } }, rules: 'flex' });
  reg.join(room.code, 'A', { nick: '打到一半掉线的' });
  const rm = reg.get(room.code);
  rm.state = 'playing';
  rm.seats.A.offSince = Date.now() - 30 * MIN;
  reg.reapIdleSeats(rm, Date.now());
  ok(reg.get(room.code).seats.A.kind === 'me', 'playing 状态下不掉席（掉线由认输宽限处理）');
}

/* ---------------- [6] 观战席超时回收 ---------------- */
console.log('[6] 没人看时，超时的观战席回收');
{
  const reg = makeRegistry();
  const room = reg.create({ seats: { A: { kind: 'open' } }, rules: 'flex' });
  const w = reg.watchSeat(room.code, { nick: '幽灵观众' });
  const rm = reg.get(room.code);
  rm.watch[w.slot].seenAt = Date.now() - 16 * MIN;   // 16 分钟没心跳（阈值 15 分钟）
  rm.pollAt.spec = 0;
  reg.reapIdleSeats(rm, Date.now());
  ok(watchNick(reg.get(room.code)).length === 0, '超时观战席被回收');

  // 反向：正在看的（刚的心跳）不动
  const room2 = reg.create({ seats: { A: { kind: 'open' } }, rules: 'flex' });
  const w2 = reg.watchSeat(room2.code, { nick: '真在看' });
  const rm2 = reg.get(room2.code);
  rm2.watch[w2.slot].seenAt = Date.now();
  reg.reapIdleSeats(rm2, Date.now());
  ok(watchNick(reg.get(room2.code)).length === 1, '心跳新鲜的观战席不动');

  // 反向：心跳把 seenAt 续上之后，同一席不会被误清（前端每 4 分钟就是这么续的）
  const room3 = reg.create({ seats: { A: { kind: 'open' } }, rules: 'flex' });
  const w3 = reg.watchSeat(room3.code, { nick: '一直在看' });
  const rm3 = reg.get(room3.code);
  rm3.watch[w3.slot].seenAt = Date.now() - 20 * MIN;
  ok(reg.touchWatch(rm3, w3.token) === true, '观战心跳打中了自己那一席');
  reg.reapIdleSeats(rm3, Date.now());
  ok(watchNick(reg.get(room3.code)).length === 1, '续过心跳的观战席不动');
}

console.log(fail ? '\n==> SEAT HYGIENE FAIL ' + fail : '\n==> ALL PASS');
process.exit(fail ? 1 : 0);
