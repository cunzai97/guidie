/* 大话骰 PK 上下文与解析（Node 模块，无 UI/网络）
 * 设计原则：
 *  - 第一人称：给模型看的每一行都用"你/对手"，绝不出现甲乙这种需要模型自己换算的标签。
 *  - 规则单一真源：规则文本由 dice-rulesets.js 按当前规则集生成；不传规则集时
 *    逐字复现经典文本（历史 run 的 prompt_hash 保持可比）。
 *  - 兵书参考而非指令：默认给一部陈述性的"博弈参考"，但不规定怎么用。
 */
/* 双端加载：Node 用 require，浏览器用 window.DiceEngine / DiceRules / DiceContext / DiceRulesets。 */
(function (root) {
'use strict';
const NODE = (typeof module !== 'undefined' && module.exports);
const E = NODE ? require('./dice-engine.js') : root.DiceEngine;
const RS = NODE ? require('./dice-rulesets.js') : root.DiceRulesets;
const CLASSIC = RS.normalize('classic');
// 三种入口都认：opts 包装（{rules:...}）、规则集对象本身、内置套 id 字符串。
const rulesOf = o => RS.normalize((o && (o.rules || (o.zhaiMode ? o : null) || (typeof o === 'string' ? o : null))) || CLASSIC);

// 模型可见的规则文本：经典套返回逐字未动的旧模板，其它套按参数生成。
function rulesTextFor(rules) {
  const r = rulesOf(rules);
  return RS.rulesText(r) || RULES_TPL;
}

// 规则文本（经典套专用，与 dice-engine 完全一致）。{TARGET} 由 buildSystem 替换。
const RULES_TPL = `大话骰规则（两人对决）：
- 每人一个骰盅、5 颗骰子，全场共 10 颗。每轮开始两人各自摇骰；你只能看见自己的 5 颗，看不见对手的 5 颗。
- 两人轮流喊价，喊价形如"n 个 m"，意思是：全场 10 颗骰子里，点数 m 至少有 n 个。
- 点数大小顺序：2 < 3 < 4 < 5 < 6 < 1。
- 1 是万能牌：只要本轮还没有人喊过 1，凑任意点数 m 的个数时，全场任意一颗 1 都算作 m——你自己的和对手的都是。对手那 5 颗你看不见，但亮牌结算时同样计入。
- 一旦有人喊到点数 1（称为"斋"）：从这一手起 1 不再万能，且之后只能继续加 1 的个数（不能换别的点数）。
- 新喊价必须严格大于上一手，两种方式之一：①把个数加得比上一手多——加几个都行，可以一次跳加好几个（此时点数 2~6 可任意换，也可喊 1 转斋）；②个数不变、点数换成更大的（按 2<3<4<5<6<1）。
- 首喊（本轮第一手）：个数只能 2~6，点数只能 2~6，不能首喊 1。
- 轮到你时，你可以喊价，也可以不喊而改为"开盅"。开盅就是质疑此刻全场最新的那一手喊价（也就是当前最高价），本轮随即结束、双方亮牌结算。
- 被质疑、被检验的只有"开盅前最近的一手"，更早的喊价一概不参与结算。轮到你时，那一手是对手刚喊的；但只要你抬出一手新价，最新一手就换成你喊的——此后对手开盅，被检验的就是你这一手，输赢也按你这一手算。
- 开盅结算：亮出全场 10 颗，只数被质疑那一手喊的"n 个 m"里点数 m 的个数（未斋时 1 也算 m，双方都算）。够 n 个或更多 → 喊价成立，开盅者输、喊那一手的人赢；不足 n 个 → 喊价不成立，喊那一手的人（被开者）输、开盅者赢。
- 每轮结算血量：双方开局各有 {TARGET} 点血（上限也是 {TARGET} 点），谁的血先降到 0 谁输掉整局。开盅时输的一方 −1 点血，赢的一方 +1 点血（回满为止）。
- 每轮由上一轮输的人先喊；第一轮由系统指定。`;

/* ---------- 唯一的提示词臂 ----------
 * 2026-11-10 定稿：只留三段——完整规则 + 「这局怎么赢」（入场券 / 进攻 / 防守）+ 一句收尾。
 * 不写兵书、不给可执行结论、不预设具体招法。连败反思由 llm.js 拼在后面，不替代任何内容。
 */
const FRAME_PLAIN = '你在和对手一对一打大话骰。';

// 这局怎么赢：只说规则里没有的东西——胜率由哪几条差距决定、什么打法会被读掉。
// 不写具体招法（该喊什么、什么时候劈），留给模型自己从对手身上长出来。
const HOWTO_PLAIN = `【赢的秘诀】

算随机概率是最蠢的行为，在喊价那一刻就不再随机。这局不是比谁会算概率，而是比谁读对方更准

你喊的每一手都在暴露你的牌，对手喊的每一手也在暴露它的牌——喊多高、什么时候转斋、什么时候开盅，都是。

骰子每轮重摇，人不会：每轮亮牌，它这一轮每一手当时是真是假，轮末你都能看得见。一时失败不代表策略绝对错误。胆小只会让自己越来越被动，自信才能一剑封喉。

谁的暴露少、读到的多，谁赢。对手也知道这一条。`;

const CUE_PLAIN = '轮到你。';
const FORMAT_PLAIN = `输出格式：先写想法（可长可短），最后一行只写行动：「喊 X 个 Y」／「喊 X 个 Y 斋」／「喊 X 个 Y 破斋」（破斋必须写出这两个字）／「开盅」／「劈」。不符合规则会要求重写。`;
const FORMAT_PLAIN_CLASSIC = `输出格式：先写想法（可长可短），最后一行只写行动：「喊 X 个 Y」／「开盅」。`;
const SUMMARY_INSTRUCTION_PLAIN = '本轮结束。写一段你要带到后续回合的复盘，内容和篇幅由你定。';

/* ---------- 提示词臂注册表 ----------
 * 现在只有一套（plain）。以后加新的一套：在这里加一个条目即可——
 * buildSystem / 指纹 / CLI 的 --prompt / 竞技场的下拉框都从这张表读，不用改别处。
 */
const ARMS = {
  plain: {
    label: '这局怎么赢',
    frame: FRAME_PLAIN,
    guide: HOWTO_PLAIN,
    format: FORMAT_PLAIN,
    formatClassic: FORMAT_PLAIN_CLASSIC,
    cue: CUE_PLAIN,
    summaryInstruction: SUMMARY_INSTRUCTION_PLAIN,
  },
};
const ARM_DEFAULT = 'plain';
const armOf = id => ARMS[id] || ARMS[ARM_DEFAULT];

/* ---------- 自定义秘诀（实时对战平台用）----------
 * 玩家自己填「这局怎么赢」那一段。只替换策略段：规则文本与输出格式仍由平台硬编码，
 * 不然玩家可以把 harness 改成自己想要的样子，评测与对战口径就崩了。
 * 文本注册成一个提示词臂，id 由文本哈希得出：同文本同 id → 指纹、复现、排名分组全部自然成立。
 */
const GUIDE_MAX = 2000;
function cleanGuide(text) {
  return String(text == null ? '' : text)
    .replace(/\r/g, '')
    // 丢掉控制字符与零宽字符：别让不可见字符把注入内容藏起来
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, '')
    .trim().slice(0, GUIDE_MAX);
}
function guideHash(text) {
  // 非加密哈希（两路 32 位 FNV 拼成 16 位十六进制）：只用于把秘诀文本映射成稳定臂 id。
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
    h2 = ((h2 << 5) | (h2 >>> 27)) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
function customArmId(guideText) {
  const g = cleanGuide(guideText);
  if (!g) return ARM_DEFAULT;
  const id = 'custom-' + guideHash(g);
  if (!ARMS[id]) {
    ARMS[id] = Object.assign({}, ARMS.plain, { label: '自定义秘诀 · ' + g.slice(0, 24).replace(/\n/g, ' '), guide: g, custom: true });
  }
  return id;
}
function isCustomArm(id) { return !!(ARMS[id] && ARMS[id].custom); }
function armLabel(id) { return (ARMS[id] || ARMS[ARM_DEFAULT]).label; }

// 非经典套：把可用的行动词汇补全（转斋 / 破斋 / 劈），仍是硬格式、不喂策略。


function buildSystem(target, opts = {}) {
  const R = rulesOf(opts);
  const flex = R.zhaiMode === 'half' || R.slash;
  const arm = armOf(opts.variant);
  const rules = rulesTextFor(R).split('{TARGET}').join(String(target));   // 规则文本里可能出现多次，必须全替换
  let out = arm.frame + '\n\n' + rules;
  out += '\n\n' + arm.guide;
  // 连败反思：整段拼在「一句话」之后、输出格式之前——不替代规则，也不替代这一套提示词本身。
  if (opts.reflection && opts.reflection.text) {
    out += '\n\n【连败后的自省】连输 ' + (opts.reflection.streak || 0) + ' 轮之后，你自己写下了下面这段；它和上面的内容并存，照着它调整：\n'
      + opts.reflection.text;
  }
  out += '\n\n' + (flex ? arm.format : arm.formatClassic);
  return out;
}

// 喊价序列的标记：经典套只有「喊 1 = 斋」；新套按每一手记录的状态标注。
function seqTag(s, R) {
  if (R.zhaiMode === 'face1') return s.face === 1 ? '（斋）' : '';
  if (s.mode === 'toZhai') return '（转斋）';
  if (s.mode === 'breakZhai') return '（破斋）';
  return s.zhai ? '（斋）' : '';
}
// 结算的单句渲染：开盅可能只有输家掉血（openLoserLoses=false），劈与经典套双向（赢家回血）。
// 赢家不回血时也要点名输家是谁，否则「够→开盅方输」的因果反馈会被读丢。
function payClause(h, me, R) {
  const k = h.stake || R.stake;
  return h.loserPays === false
    ? `${me(h.loser)} −${k} 点血（${me(h.winner)} 不回血）`
    : `${me(h.winner)} +${k} 点血 / ${me(h.loser)} −${k} 点血`;
}
function resultTail(h, me, R) {
  if (R.zhaiMode === 'face1') return `${me(h.bid.by)}喊 ${h.bid.count}个${h.bid.face}，${me(h.opener)}开盅，全场${h.bid.face}实际有 ${h.actual} 个（${h.truth ? '够' : '不够'}）→ ${me(h.winner)} +1 点血 / ${me(h.loser)} −1 点血。`;
  const act = h.slash ? '劈' : '开盅', k = h.stake || R.stake;
  const z = h.bid && h.bid.zhai ? '（斋）' : '';
  return `${me(h.bid.by)}喊 ${h.bid.count}个${h.bid.face}${z}，${me(h.opener)}${act}，全场实际有 ${h.actual} 个（${h.truth ? '够' : '不够'}）→ ${payClause(h, me, R)}。`;
}

// 合法动作边界：经典套完全复刻旧菜单（逐字），新套按规则集列出转斋/破斋/劈。
function legalMenu(round, rules) {
  const R = rulesOf(rules || (round && round.rules));
  if (!round.bid) {
    const base = R.firstFace1
      ? `你是首喊：个数 ${R.firstMin}~${R.firstMax}、点数 1~6 任选（例如「喊 3 个 4」）。首喊不能开盅。`
      : '你是首喊：个数 ' + R.firstMin + '~' + R.firstMax + '、点数 2~6 任选（例如「喊 3 个 4」）。首喊不能开盅。';
    return base + ((R.zhaiMode === 'half' && R.firstZhai)
      ? '\n  首喊也可以直接喊斋：同样按上面的个数与点数选，末尾写「斋」（例如「喊 3 个 4 斋」）；不用取半，但这一手起 1 不再万能。'
      : '');
  }
  const b = round.bid;
  if (R.zhaiMode === 'face1') {
    const lines = ['你现在有两个选择：', '  ① 开盅（质疑开盅前最近的一手，也就是当前这个最高价：对手刚喊的 ' + b.count + ' 个 ' + b.face + (b.face === 1 ? '（斋）' : '') + '）'];
    const raises = [];
    if (b.face === 1) {
      if (b.count < 10) raises.push('继续加 1 的个数：喊 k 个 1，k 从 ' + (b.count + 1) + ' 到 10 任选（可以一次跳加好几个）');
    } else {
      if (b.count < 10) raises.push('把个数加到 ' + (b.count + 1) + '~10 任选（可以一次跳加好几个），此时点数 2~6 任选、也可喊 1 转斋');
      const higher = E.FACE_ORDER.filter(f => E.ord(f) > E.ord(b.face));
      if (higher.length) raises.push('个数保持 ' + b.count + ' 不变、只把点数换成更大的：' + higher.join('/') + ' 任选');
    }
    lines.push(raises.length ? ('  ② 抬价：' + raises.join('；或者 ') + '。') : '  ② 已无更高价可喊，只能开盅。');
    return lines.join('\n');
  }
  const lines = ['你现在有几个选择：'];
  const openPay = R.openLoserLoses ? `输掉的一方 −${R.stake} 点血、赢的一方 +${R.stake} 点血` : `输掉的一方 −${R.stake} 点血、赢的一方不回血`;
  lines.push(R.slash
    ? `  ① 开盅或劈（质疑开盅前最近的一手，也就是当前这个最高价：对手刚喊的 ${b.count} 个 ${b.face}${seqTag(b, R)}）。开盅${openPay}；劈输的一方 −${R.slashStake} 点血、赢的一方 +${R.slashStake} 点血（只有劈会让赢家回血）`
    : `  ① 开盅（质疑开盅前最近的一手，也就是当前这个最高价：对手刚喊的 ${b.count} 个 ${b.face}${seqTag(b, R)}）。开盅${openPay}`);
  const raises = [];
  const zc = E.zhaiCount(round), bcMin = E.breakMinCount(round);
  if (!round.zhai && zc != null && zc >= R.minCount) raises.push(`转斋：喊 ${zc} 个 ${R.faceFree ? '1~6 任选点数' : '1'}、写「斋」——个数取上一手的一半向上取整；这一手起 1 不再万能`);
  else if (!round.zhai && zc != null && zc < R.minCount) raises.push(`本轮不能转斋：取半只有 ${zc} 个，不足 ${R.minCount} 个`);
  if (round.zhai && bcMin != null && bcMin <= R.maxCount) {
    raises.push(`破斋：写明「破斋」、个数至少 ${bcMin} 个（${bcMin}~10 个都行），点数 2~6（喊 1 会立刻又进斋）；这一手起 1 恢复万能。`
      + `例：喊 ${bcMin} 个 ${R.faceFree ? '任意点数' : '1'} 破斋——不写「破斋」就只是留在斋里的普通抬价`);
  } else if (round.zhai && bcMin != null) {
    raises.push(`本轮破不了斋：个数要加到 ${bcMin} 个才够，超过全场 10 颗了`);
  }
  if (b.count < 10) raises.push('把个数加到 ' + (b.count + 1) + '~10 任选（可以一次跳加好几个），此时点数 1~6 任选'
    + (round.zhai ? '、仍留在斋状态' : '')
    + (round.zhai && bcMin != null && bcMin <= R.maxCount
        ? '；个数到 ' + bcMin + ' 个以上时，想破斋就写明「破斋」，不写仍留在斋里（1 仍不万能）' : ''));
  if (!round.zhai) raises.push('喊点数 1 即进斋（这一手起 1 不再万能），不用另写「斋」');
  if (!(round.zhai && R.lockFace)) {
    const higher = E.FACE_ORDER.filter(f => E.ord(f) > E.ord(b.face));
    if (higher.length) raises.push('个数保持 ' + b.count + ' 不变、只把点数换成更大的：' + higher.join('/') + ' 任选');
  }
  if (round.zhai) raises.push('当前是斋状态：1 不算万能，只数真实点数；普通抬价写不写「斋」都可以（写了也按普通抬价处理）。破斋必须写明「破斋」');
  lines.push(raises.length ? ('  ② 喊价：' + raises.join('；或者 ') + '。')
    : (R.slash ? '  ② 已无更高价可喊，只能开盅或劈。' : '  ② 已无更高价可喊，只能开盅。'));
  return lines.join('\n');
}

// 回看窗口统一裁剪：Infinity=全量、0=不输出、正整数=最近 N 条、null=各自的历史默认值。
function tail(arr, limit, dflt) {
  const n = limit == null ? dflt : limit;
  if (n === Infinity) return arr;
  if (n === 0) return [];
  return arr.slice(-n);
}

// 局势动态：只从真实局史聚合，给模型"变化"信号而非让它每回合重新归纳。
function momentum(m, who, limit) {
  const opp = E.other(who);
  const me = x => (x === who ? '你' : '对手');
  const recent = tail(m.history, limit, 5);
  if (!recent.length) return null;
  const L = [];
  L.push('近期走势（第' + recent[0].no + '~' + recent[recent.length - 1].no + '轮）：');
  L.push('  逐轮赢家：' + recent.map(h => me(h.winner)).join(' → '));
  let streak = 0; const lastW = recent[recent.length - 1].winner;
  for (let i = recent.length - 1; i >= 0 && recent[i].winner === lastW; i--) streak++;
  L.push('  当前：' + me(lastW) + ' 连胜 ' + streak + ' 轮。');
  let oppBid = 0, oppBidLost = 0, oppOpen = 0, oppOpenWin = 0;
  for (const h of recent) {
    if (h.forfeit) continue;
    if (h.bid && h.bid.by === opp) { oppBid++; if (h.loser === opp) oppBidLost++; }
    if (h.opener === opp) { oppOpen++; if (h.winner === opp) oppOpenWin++; }
  }
  L.push(`  对手近${recent.length}轮：喊价 ${oppBid} 次（其中被开死 ${oppBidLost} 次）；主动开盅 ${oppOpen} 次（开赢 ${oppOpenWin} 次）。`);
  return L.join('\n');
}

// 第一人称局面文本。who ∈ {'A','B'} 是当前被问模型的座位。
function buildUser(m, who, opts = {}) {
  const ownLimit = opts.ownMemoLimit == null ? 3 : opts.ownMemoLimit;
  const histLimit = opts.historyLimit == null ? 10 : opts.historyLimit;
  const R = rulesOf(opts.rules || m.rules);
  const r = m.round, opp = E.other(who);
  const me = x => (x === who ? '你' : '对手');
  const L = [];
  L.push(`【第 ${m.roundNo} 轮 · 轮到你行动】`);
  L.push('你的骰子（只有你能看见）：' + r.dice[who].join(' '));
  const own = {};
  for (let f = 1; f <= 6; f++) own[f] = r.dice[who].filter(d => d === f).length;
  L.push(`你手里各点数：1×${own[1]}  2×${own[2]}  3×${own[3]}  4×${own[4]}  5×${own[5]}  6×${own[6]}（对手那 5 颗你看不到）`);
  const diff = m.hp[who] - m.hp[opp];
  const tag = diff > 0 ? `你的血比对手多 ${diff} 点` : diff < 0 ? `你的血比对手少 ${-diff} 点` : '双方血量相同';
  L.push(`血量：你 ${m.hp[who]} 点，对手 ${m.hp[opp]} 点（上限 ${m.hpMax} 点），谁的血先降到 0 谁输掉整局（${tag}）。`);

  const mom = momentum(m, who, histLimit === Infinity ? Infinity : undefined);
  if (mom) { L.push(''); L.push(mom); }

  const past = tail(m.history, histLimit, 10);
  if (past.length) {
    L.push('');
    L.push('前几轮的真实结果（亮牌后的事实）：');
    for (const h of past) {
      if (h.forfeit) { L.push(`  第${h.no}轮：${me(h.loser)} 未能给出合法行动，判负 → ${payClause(h, me, R)}。`); continue; }
      L.push('  第' + h.no + '轮：' + resultTail(h, me, R));
      if (h.dice) L.push(`    亮牌：你 [${h.dice[who].join(' ')}]，对手 [${h.dice[opp].join(' ')}]（该轮双方真实手牌）。`);
    }
  }

  const memo = tail(opts.ownMemo || [], ownLimit, 3);
  if (memo.length) {
    L.push('');
    L.push(ownLimit === Infinity
      ? '你在本局每一手写下的判断与落子（全部保留到本局结束，回顾读牌是否成立，据此调整）：'
      : '你自己最近的判断与结果（回顾你之前的读牌是否成立，据此调整）：');
    for (const e of memo) {
      const h = m.history.find(x => x.no === e.round);
      const kk = h ? (h.stake || R.stake) : 1;
      const outcome = h ? (h.winner === who
        ? (h.loserPays === false ? '该轮你赢、血量不变' : '该轮你 +' + kk + ' 点血')
        : '该轮你 −' + kk + ' 点血') : '该轮进行中';
      // 逐手判断是模型自己写的读牌依据，只截断病态长度（旧值 160 字把推理砍成了结论）。
      const j = (e.judgment || '').slice(0, 600);
      L.push(`  第${e.round}轮你判断：${j}${j.length >= 600 ? '…' : ''} → 你${e.action || ''} → ${outcome}。`);
    }
  }

  if (!r.bid) {
    L.push('');
    L.push('本轮还没人喊价，你是第一个喊的人。');
  } else {
    L.push('');
    L.push('本轮喊价序列（从第一手到现在）：');
    for (const s of r.seq) {
      if (s.kind !== 'bid') continue;
      const cur = r.bid.at === s.at ? '  ← 当前最高价（你要超过它，或开它）' : '';
      L.push(`  ${s.at}. ${me(s.who)}喊 ${s.count} 个 ${s.face}${seqTag(s, R)}${cur}`);
    }
    if (R.zhaiMode === 'half') L.push('当前状态：' + (r.zhai ? '斋（1 不算万能，只数真实点数）' : '未斋（1 是万能牌）') + '。');
  }
  L.push('');
  L.push(legalMenu(r, R));
  L.push('');
  L.push(armOf(opts.variant).cue);
  return L.join('\n');
}

// 增量回合消息（持久对话模式）：只追加"自上次行动以来新发生的事 + 当前局面"。
function buildTurn(m, who, cursor, opts = {}) {
  const R = rulesOf(opts.rules || m.rules);
  const r = m.round, opp = E.other(who);
  const me = x => (x === who ? '你' : '对手');
  const fmtPt = x => (x > 0 ? '+' + x : String(x));
  const L = [];
  const newRound = !cursor || cursor.roundNo !== m.roundNo;

  if (newRound) {
    if (!opts.noHistory) {
      const from = cursor ? cursor.histLen : 0;
      const resolved = m.history.slice(from);
      if (resolved.length) {
        L.push('—— 结算结果（亮牌后的事实）——');
        for (const h of resolved) {
          if (h.forfeit) { L.push(`  第${h.no}轮：${me(h.loser)} 未能给出合法行动，判负 → ${payClause(h, me, R)}。`); continue; }
          L.push('  第' + h.no + '轮：' + resultTail(h, me, R));
          if (h.dice) L.push(`    亮牌：你 [${h.dice[who].join(' ')}]，对手 [${h.dice[opp].join(' ')}]（该轮双方真实手牌）。`);
        }
        L.push('');
      }
    }
    L.push(`【第 ${m.roundNo} 轮开始】`);
    L.push('你的新骰子（只有你能看见）：' + r.dice[who].join(' '));
    const own = {};
    for (let f = 1; f <= 6; f++) own[f] = r.dice[who].filter(d => d === f).length;
    L.push(`你手里各点数：1×${own[1]}  2×${own[2]}  3×${own[3]}  4×${own[4]}  5×${own[5]}  6×${own[6]}（对手那 5 颗你看不到）`);
    const diff = m.hp[who] - m.hp[opp];
    const tag = diff > 0 ? `你的血比对手多 ${diff} 点` : diff < 0 ? `你的血比对手少 ${-diff} 点` : '双方血量相同';
    L.push(`血量：你 ${m.hp[who]} 点，对手 ${m.hp[opp]} 点（上限 ${m.hpMax} 点），谁的血先降到 0 谁输掉整局（${tag}）。`);
    L.push(m.firstBidder === who || (m.lastLoser === who) ? '本轮由你先喊。' : '本轮对手先喊。');
  } else {
    L.push(`【第 ${m.roundNo} 轮 · 又轮到你】`);
    L.push('你的骰子仍是：' + r.dice[who].join(' '));
    L.push(`血量：你 ${m.hp[who]} / 对手 ${m.hp[opp]}。`);
  }

  const startAt = newRound ? 0 : (cursor.seqAt || 0);
  const newBids = r.seq.filter(s => s.kind === 'bid' && s.at > startAt);
  if (newBids.length) {
    L.push('');
    L.push(newRound ? '本轮喊价：' : '你上次行动之后，新的喊价：');
    for (const s of newBids) L.push(`  ${s.at}. ${me(s.who)}喊 ${s.count} 个 ${s.face}${seqTag(s, R)}`);
  }
  if (!r.bid) {
    L.push('');
    L.push('本轮还没人喊价，你是第一个喊的人。');
  } else {
    L.push(`当前最高价：${me(r.bid.by)}喊的 ${r.bid.count} 个 ${r.bid.face}${seqTag(r.bid, R)}（你要超过它，或开它）。`);
    if (R.zhaiMode === 'half') L.push('当前状态：' + (r.zhai ? '斋（1 不算万能）' : '未斋（1 是万能牌）') + '。');
  }
  L.push('');
  L.push(legalMenu(r, R));
  L.push('');
  L.push(armOf(opts.variant).cue);

  const next = { roundNo: m.roundNo, histLen: m.history.length, seqAt: r.seq.length ? r.seq[r.seq.length - 1].at : 0 };
  return { text: L.join('\n'), next };
}

/* 连败深度反思的提示词（CLI 的 llm.js 与竞技场共用这一份，措辞只在这里维护）。
 * 输入是本局逐轮完整记录（双方真实手牌 / 喊价 / 被质疑那一手 / 结算）+ 连输轮数。 */
function buildReflectPrompt(opts = {}) {
  const streakN = opts.streak || 0;
  const seat = opts.seat || 'A';
  const h = opts.history || [];
  const me = x => (x === seat ? '你' : '对手');
  const L = [];
  L.push(`你正在和同一个对手对局。你目前已经连续输掉 ${streakN} 轮。`);
  L.push('下面是你本局到目前为止的完整记录：每轮双方真实手牌、喊价、被质疑的那一手、亮牌结算。');
  for (const r of h) {
    const handTxt = side => '[' + ((r.dice && r.dice[side]) || []).join(' ') + ']';
    const b = r.bid || { count: 0, face: 0, by: seat, zhai: false };
    const z = b.zhai ? '（斋）' : '';
    const act = r.slash ? '劈' : '开盅';
    const pay = r.loserPays === false ? '（赢家不回血）' : '';
    L.push(`第${r.no}轮：你 ${handTxt(seat)}，对手 ${handTxt(seat === 'A' ? 'B' : 'A')}；`
      + `${me(b.by)}喊 ${b.count}个${b.face}${z}，${me(r.opener)}${act}，全场实际 ${r.actual} 个`
      + `（${r.truth ? '够' : '不够'}）→ ${me(r.winner)} 赢，${me(r.loser)} 输${pay}。`);
  }
  L.push('请做一次深刻的反思总结，把你学到的全部写下来：');
  L.push('1) 对手的打法规律是什么？它凭什么连续赢你？');
  L.push('2) 你的哪些判断、习惯、前提错了？被利用的是哪一点？');
  L.push('3) 接下来每一手具体该怎么打？写成可执行的规则（什么局面开盅/劈、什么局面喊什么、什么时候诈唬）。');
  L.push('事实提醒：本游戏没有「过 / 接受 / 跟注 / 不质疑」这类选项，轮到你时只能在合法喊价或开盅/劈之间选择。');
  L.push('不要省略，不要客套，尽量详尽。这段总结立刻生效，成为你此后这局的打法指导。');
  return [
    { role: 'system', content: '你正在复盘自己连输的对局，目标是把教训写成可执行的打法规则。' },
    { role: 'user', content: L.join('\n') },
  ];
}

/* 普通反思：深度反思没写出正文（预算全耗在思考里）时的退化路径。
 * 只要一段短的、能立刻执行的打法，不要求长篇复盘——这样它一定能落在正文里。 */
function buildPlainReflectPrompt(opts = {}) {
  const streakN = opts.streak || 0;
  const L = [];
  L.push(`你正在和同一个对手对局，已经连续输掉 ${streakN} 轮。`);
  L.push('用一段话写下接下来几轮你要改什么（不超过 300 字），只写正文，不要罗列分析。');
  return [
    { role: 'system', content: '你在给自己写一条简短的临场打法，只输出正文。' },
    { role: 'user', content: L.join('\n') },
  ];
}

function buildSummaryPrompt(m, who, result, opts = {}) {
  const R = rulesOf(opts.rules || m.rules);
  const opp = E.other(who);
  const me = x => (x === who ? '你' : '对手');
  const L = ['本轮结束。下面是本轮的全部信息，供你复盘。'];
  const seq = (m.round && m.round.seq) || [];
  if (seq.length) {
    L.push('');
    L.push('【本轮完整喊价过程】');
    for (const s of seq) {
      if (s.kind === 'bid') L.push(`  ${s.at}. ${me(s.who)}喊 ${s.count} 个 ${s.face}${seqTag(s, R)}`);
      else if (s.kind === 'open') L.push(`  ${s.at}. ${me(s.who)}${s.slash ? '劈' : '开盅'}`);
    }
  }
  if (result && result.dice) {
    L.push('');
    L.push('【双方真实手牌（全部亮牌）】');
    L.push(`  你：[${result.dice[who].join(' ')}]`);
    L.push(`  对手：[${result.dice[opp].join(' ')}]`);
  }
  if (result && result.forfeit) {
    L.push('');
    L.push(`结算：${me(result.loser)} 未能给出合法行动判负 → ${payClause(result, me, R)}。本轮${result.winner === who ? '你赢' : '你输'}。`);
  } else if (result && result.bid) {
    L.push('');
    if (R.zhaiMode === 'face1') {
      // 经典套：逐字复现旧结算行（上一轮刚补过第一人称胜负标注）
      const wildNote = result.bid.face !== 1 && result.wild ? `（其中 ${result.wild} 个来自万能1）` : '';
      L.push(`结算：${me(result.bid.by)}喊 ${result.bid.count}个${result.bid.face}，${me(result.opener)}开盅，全场${result.bid.face}实际有 ${result.actual} 个${wildNote}（${result.truth ? '够' : '不够'}）→ ${me(result.winner)} +1 点血 / ${me(result.loser)} −1 点血。本轮${result.winner === who ? '你赢' : '你输'}。`);
    } else {
      const k = result.stake || R.stake;
      const wildNote = !result.zhai && result.bid.face !== 1 && result.wild ? `（其中 ${result.wild} 个来自万能1）` : '';
      const pay = payClause(result, me, R) + '。';
      L.push(`结算：${me(result.bid.by)}喊 ${result.bid.count}个${result.bid.face}${seqTag(result.bid, R)}，${me(result.opener)}${result.slash ? '劈' : '开盅'}，全场${result.bid.face}实际有 ${result.actual} 个${wildNote}（${result.truth ? '够' : '不够'}）→ ${pay}本轮${result.winner === who ? '你赢' : '你输'}。`);
    }
  }
  L.push('');
  L.push(armOf(opts.variant).summaryInstruction);
  return L.join('\n');
}

function memoryMarker(roundNo) {
  return `第 ${roundNo} 轮结束。请写一段复盘反思供后续回合参考：`;
}

/* ---------- 自由文本解析 / 规则校验 / 退化检测：统一收敛到 dice-rules.js ---------- */
const RUL = NODE ? require('./dice-rules.js') : root.DiceRules;
const { parseAction, checkLegal, isPromptEcho, extractJudgment } = RUL;

// 各臂写进 system / 复盘提示的固定文本，供 runlog.promptHash 按臂取指纹。
// 经典套返回固定数组，保证同一版本文本的 prompt_hash 稳定；规则集变化时由 promptTexts 生成新数组。
// 指纹用：现在只有一个臂，文本按规则集生成（规则文本变了指纹就变）。
function promptTexts(rules, variant) {
  const R = rulesOf(rules), arm = armOf(variant);
  return [
    rulesTextFor(R),
    arm.frame,
    arm.guide,
    (R.zhaiMode === 'half' || R.slash) ? arm.format : arm.formatClassic,
    arm.summaryInstruction,
  ];
}

const API = { buildSystem, buildUser, buildTurn, buildSummaryPrompt, memoryMarker,
  legalMenu, momentum, seqTag, resultTail, rulesTextFor, promptTexts, buildReflectPrompt, buildPlainReflectPrompt,
  extractJudgment, parseAction, checkLegal, isPromptEcho, ACTION_LINE_RE: RUL.ACTION_LINE_RE,
  RULES_TPL,
  FRAME_PLAIN, HOWTO_PLAIN, FORMAT_PLAIN, FORMAT_PLAIN_CLASSIC, SUMMARY_INSTRUCTION_PLAIN, CUE_PLAIN,
  ARMS, ARM_DEFAULT, armOf, armLabel, customArmId, isCustomArm, cleanGuide, GUIDE_MAX };
if (NODE) module.exports = API;
else root.DiceContext = API;
})(typeof self !== 'undefined' ? self : globalThis);
