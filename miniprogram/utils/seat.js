/* 把「界面里的一条配置」变成服务端认的座位格式。
 * 与 web/play.js 的 seatPicker 同口径：
 *   me      → 本人手打
 *   bot     → 内置人机
 *   preset  → 平台预设（Key 在服务器）
 *   configId→ 账号里存的模型（Key 在服务端密文盒）
 *   裸配置  → 先换临时 secretToken，Key 只在内存保险柜里活 3 小时
 */
const api = require('./api.js');

async function seatSpec(cfg, nick) {
  if (!cfg || cfg.kind === 'me') return { kind: 'me', nick: cfg && cfg.nick ? cfg.nick : nick };
  if (cfg.kind === 'bot') return { kind: 'bot', bot: cfg.bot || 'reader' };
  if (cfg.kind === 'preset') return { kind: 'preset', presetId: cfg.presetId, guideText: cfg.guideText || null };
  if (cfg.configId) return { kind: 'llm', configId: cfg.configId, guideText: cfg.guideText || null };
  if (!cfg.baseUrl || !cfg.model) throw new Error('模型座位要有 Base URL 和模型名');
  const r = await api.post('/api/secret', {
    baseUrl: cfg.baseUrl, model: cfg.model,
    apiKey: cfg.apiKey || null, guideText: cfg.guideText || null,
  });
  return {
    kind: 'llm', secretToken: r.secretToken, baseUrl: cfg.baseUrl, model: cfg.model,
    guideText: cfg.guideText || null,
  };
}

module.exports = { seatSpec };
