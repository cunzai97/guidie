/* 定向回归：退化回声不得进入持久历史、不得级联放大。
 * 桩模型可控地在开局前 N 次调用照抄提示（回声），之后正常落子。
 * 验证修复后的结构不变量：原始回声永不作为 assistant 内容入史；判负只留中性记录；后续回合干净。 */
const { runPK } = require('../src/runner.js');
const { makeLLMPlayer } = require('../src/llm.js');

function scenario(echoFirst, label) {
  const captured = [];
  let echoerCalls = 0;
  global.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    const msgs = body.messages;
    const lastUser = [...msgs].reverse().find(m => m.role === 'user').content;
    captured.push({ model: body.model, msgs: msgs.map(m => ({ role: m.role, content: m.content })) });
    let action;
    if (body.model === 'echoer' && echoerCalls < echoFirst) {
      echoerCalls++;
      action = lastUser.split('\n\n')[0];                 // 退化回声：照抄提示第一段
    } else {
      const ctx = ([...msgs].reverse().find(m => m.role === 'user' && /① 开盅|合法的有|你是首喊/.test(m.content)) || {}).content || lastUser;
      if (/① 开盅/.test(ctx)) action = '对手在诈。\n开盅';
      else { const m = ctx.match(/喊 (\d+) 个 (\d+)/); action = m ? `判断。\n喊 ${m[1]} 个 ${m[2]}` : '喊 2 个 3'; }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: action }, finish_reason: 'stop' }], usage: { prompt_tokens: 100 * msgs.length, completion_tokens: 20, cached_tokens: 100 * (msgs.length - 2) } }) };
  };
  const p0 = makeLLMPlayer({ name: 'echoer', baseUrl: 'http://x/v1', model: 'echoer', context: 'chat' }, () => {});
  const p1 = makeLLMPlayer({ name: 'clean', baseUrl: 'http://x/v1', model: 'clean', context: 'chat' }, () => {});
  return runPK(p0, p1, { deals: 1, seed: 12345, roundTarget: 3, maxRounds: 30 }).then(({ games, agg }) => {
    // 不变量1：任何 assistant 内容都不以"【第"开头（原始回声从未入史，连临时副本里也被中性标记替换）
    const rawEchoInHistory = captured.some(c => c.msgs.some(m => m.role === 'assistant' && /^【第\s*\d+\s*轮开始】/.test(m.content.trim())));
    // 不变量2：echoer 的判负次数（场景A应0，场景B应1，绝不级联成整局）
    const forfeits = agg.p0.stats.forfeits;
    // 不变量3：对话累积 + 跨局 reset
    const maxTurns = Math.max(...captured.map(c => c.msgs.length));
    const resetOK = captured.some((c, i) => i > 0 && c.msgs.length === 2 && captured[i - 1].msgs.length > 2);
    // 不变量4：判负后持久历史只留中性判负记录（原始回声永不入史，重试脚手架只在临时副本，下一回合从干净前缀继续）
    const forfeitMarker = captured.some(c => c.msgs.some(m => m.role === 'assistant' && m.content.includes('本回合我未能给出合法行动')));
    const expectForfeit = echoFirst >= 3 ? 1 : 0;
    const pass = !rawEchoInHistory && forfeits === expectForfeit && maxTurns > 2 && resetOK && (echoFirst < 3 || forfeitMarker);
    console.log(`\n[${label}] echoFirst=${echoFirst}`);
    console.log(`  原始回声入史: ${rawEchoInHistory} (应 false)`);
    console.log(`  echoer 判负: ${forfeits} (应 ${expectForfeit}，绝不级联)`);
    console.log(`  最大对话长度: ${maxTurns} (应 >2)  跨局reset: ${resetOK}`);
    if (echoFirst >= 3) console.log(`  中性判负记录入史: ${forfeitMarker} (应 true)`);
    console.log(`  ==> ${pass ? 'PASS' : 'FAIL'}`);
    return pass;
  });
}

(async () => {
  const a = await scenario(1, '场景A：一次回声后恢复');
  const b = await scenario(3, '场景B：三回声判负后下一回合干净');
  console.log(`\n总计: ${a && b ? 'ALL PASS' : 'FAIL'}`);
  process.exit(a && b ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });