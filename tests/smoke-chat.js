/* 离线冒烟：桩 fetch 驱动持久对话模式，验证对话累积/跨局 reset/增量渲染。不触网、不烧积分。 */
const { runPK } = require('../src/runner.js');
const { makeLLMPlayer } = require('../src/llm.js');

const calls = [];
global.fetch = async (url, opt) => {
  const body = JSON.parse(opt.body);
  const msgs = body.messages;
  const lastUser = [...msgs].reverse().find(m => m.role === 'user').content;
  // 桩策略：能开就开（快速结算产生多轮局史），否则喊合法菜单里第一个价
  let action;
  if (/① 开盅/.test(lastUser)) action = '我判断对手在诈。\n开盅';
  else { const m = lastUser.match(/喊 (\d+) 个 (\d+)/); action = m ? `试试这手。\n喊 ${m[1]} 个 ${m[2]}` : '喊 2 个 3'; }
  calls.push({ turns: msgs.length, roles: msgs.map(m => m.role).join(','), lastUser });
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: action }, finish_reason: 'stop' }], usage: { prompt_tokens: 100 * msgs.length, completion_tokens: 20, cached_tokens: 100 * (msgs.length - 2) } }),
  };
};

const log = () => {};
const p0 = makeLLMPlayer({ name: 'stub0', baseUrl: 'http://x/v1', model: 'm', context: 'chat' }, log);
const p1 = makeLLMPlayer({ name: 'stub1', baseUrl: 'http://x/v1', model: 'm', context: 'chat' }, log);

(async () => {
  const { games } = await runPK(p0, p1, { deals: 1, seed: 12345, roundTarget: 3, maxRounds: 30 });
  console.log('games:', games.length, 'calls:', calls.length);
  // 跨局 reset 检查：第二局首个 call 应只有 system+user（turns=2）
  const firstOfGame2 = calls.find((c, i) => i > 0 && c.turns === 2 && calls[i - 1].turns > 2);
  console.log('reset between games OK:', !!firstOfGame2);
  // 对话累积检查：存在 turns 递增
  const maxTurns = Math.max(...calls.map(c => c.turns));
  console.log('max conversation turns:', maxTurns, '(应 > 2，说明前文被复用)');
  // 增量渲染检查：找一条含"结算结果"的非首回合 user 消息
  const withHistory = calls.find(c => /结算结果（亮牌后的事实）/.test(c.lastUser) && /第 \d+ 轮开始/.test(c.lastUser));
  console.log('\n--- 含上一轮结算的新回合消息样例 ---\n' + (withHistory ? withHistory.lastUser : '(无)'));
  console.log('\n--- 同轮再次行动样例 ---');
  const again = calls.find(c => /又轮到你/.test(c.lastUser));
  console.log(again ? again.lastUser : '(无)');
})().catch(e => { console.error(e); process.exit(1); });