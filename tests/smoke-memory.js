/* 离线冒烟：桩 fetch 驱动摘要链模式，验证 backbone 增长 / working 轮末清空 / 笔记带入下一轮 / 跨局 reset。不触网。 */
const { runPK } = require('../src/runner.js');
const { makeLLMPlayer } = require('../src/llm.js');

const captured = [];
global.fetch = async (url, opt) => {
  const body = JSON.parse(opt.body);
  const msgs = body.messages;
  const lastUser = [...msgs].reverse().find(m => m.role === 'user').content;
  const isSummary = /请你自己写一段复盘总结/.test(lastUser);
  let content;
  if (isSummary) content = '复盘反思：对手这轮倾向低喊试探，亮牌看到他真实骰子，反推他是想诱我开盅，下一轮据此反制。';
  else if (/① 开盅/.test(lastUser)) content = '对手在诈。\n开盅';
  else { const m = lastUser.match(/喊 (\d+) 个 (\d+)/); content = m ? `判断。\n喊 ${m[1]} 个 ${m[2]}` : '喊 2 个 3'; }
  captured.push({ isSummary, turns: msgs.length, roles: msgs.map(m => m.role).join(','), lastUser, assistants: msgs.filter(m => m.role === 'assistant').map(m => m.content), users: msgs.filter(m => m.role === 'user').map(m => m.content) });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100 * msgs.length, completion_tokens: 20, cached_tokens: 100 * (msgs.length - 2) } }) };
};

const p0 = makeLLMPlayer({ name: 'm0', baseUrl: 'http://x/v1', model: 'm', context: 'memory' }, () => {});
const p1 = makeLLMPlayer({ name: 'm1', baseUrl: 'http://x/v1', model: 'm', context: 'memory' }, () => {});

(async () => {
  const { games, agg } = await runPK(p0, p1, { deals: 1, seed: 12345, hpMax: 10, maxRounds: 30 });
  const plays = captured.filter(c => !c.isSummary);
  const sums = captured.filter(c => c.isSummary);
  // 1 跨局 reset：第二局首个 play 应只有 system+user（turns=2，backbone 已清）
  const resetOK = plays.some((c, i) => i > 0 && c.turns === 2 && plays[i - 1].turns > 2);
  // 2 轮末总结发生：summary 调用 > 0
  const summaryHappened = sums.length > 0;
  // 3 笔记带入落子上下文：某个 play 的消息里含 backbone 标记"第 N 轮结束。请写一段复盘反思"
  const notesInContext = plays.some(c => c.users.some(u => /第 \d+ 轮结束。请写一段复盘反思/.test(u)));
  // 4 working 轮末清空：新一轮首个 play（lastUser 含"【第 N 轮开始】"）的 assistant 数应恰等于 backbone 笔记数，
  //   说明上一轮逐字工作记忆已清，只剩压缩笔记（若没清，assistant 会多于笔记数）。
  const roundStarts = plays.filter(c => /【第 \d+ 轮开始】/.test(c.lastUser));
  const workingCleared = roundStarts.some(c => {
    const markers = c.users.filter(u => /第 \d+ 轮结束。请写一段复盘反思/.test(u)).length;
    return markers >= 1 && c.assistants.length === markers;
  });
  // 5 backbone 逐轮增长：play 调用里 backbone 笔记数（标记数）随回合递增
  const markerCounts = plays.map(c => c.users.filter(u => /第 \d+ 轮结束。请写一段复盘反思/.test(u)).length);
  const backboneGrows = Math.max(...markerCounts) >= 1 && markerCounts.some((v, i) => i > 0 && v > markerCounts[i - 1]);
  const maxTurns = Math.max(...captured.map(c => c.turns));
  const forfeits = agg.p0.stats.forfeits + agg.p1.stats.forfeits;
  console.log('games:', games.length, 'play调用:', plays.length, 'summary调用:', sums.length);
  console.log('跨局reset:', resetOK, '| 轮末总结发生:', summaryHappened, '| 笔记带入落子上下文:', notesInContext);
  console.log('working轮末清空:', workingCleared, '| backbone逐轮增长:', backboneGrows, '| 最大对话长度:', maxTurns, '| 双方判负:', forfeits);
  console.log('\n--- 含记忆笔记的落子上下文样例（user 标记 + assistant 笔记）---');
  const sample = plays.find(c => c.users.some(u => /第 \d+ 轮结束。请写一段复盘反思/.test(u)));
  if (sample) {
    const idx = sample.users.findIndex(u => /第 \d+ 轮结束。请写一段复盘反思/.test(u));
    console.log('标记:', sample.users[idx]);
    console.log('笔记:', sample.assistants[idx] || '(对应assistant)');
  }
  const pass = resetOK && summaryHappened && notesInContext && workingCleared && backboneGrows && forfeits === 0;
  console.log('\n==> ' + (pass ? 'ALL PASS' : 'FAIL'));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });