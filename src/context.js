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
- 每轮结算采用双向积分：赢家 +1 分、输家 −1 分（零和，双方积分同时变动）。率先达到 +{TARGET} 分者赢下整个对局。
- 每轮由上一轮输的人先喊；第一轮由系统指定。`;

// 竞争 framing（不是策略提示）：让模型知道这是零和对抗、对手也想赢。
const FRAME = `你正在和另一个对手进行一场大话骰对决。你是其中一方，另一方是你的对手。
你们各自都想让自己赢、让对方输：每赢一轮你 +1 分、对手 −1 分，你要率先拿到目标积分，同时阻止对手拿分。
对手和你一样会观察、会推断、会诈唬——不要把对手当成固定的出题机器，你的每一次喊价也在向对手泄露情报。
你的目标只有一个：赢下这场对局。这场对话会持续记录完整的局史和你自己的每一次判断，局势变化都会如实告诉你——落子前先回看对手的习惯有没有变、你之前的读牌哪些被证实、哪些被推翻，据此实时调整，而不是每回合从零开始。由你自主决定怎么打。`;

// 可选的策略 coaching 臂（默认关闭，且只在 classic 臂生效）。
const COACH = `桌上经验（仅供参考，不是必须照做）：
- 喊价同时是情报和压力：真话假话掺着来，别让对手轻易读穿你手里有没有货。
- 对手敢喊 n 个 m，要么它手里 m 多（加万能 1），要么在诈；用你自己手里的 m 去估它偏哪边。
- 开盅前先想"对手为什么在这个位置喊这个数"，再决定开不开。`;

// 基础"兵书"参考（默认就在系统提示里）：陈述这个游戏的道理与示例，但不告诉它该怎么用。
const PLAY_REFERENCE = `博弈参考（这是一部大话骰的"兵书"，摆在你手边供查阅，不规定你怎么打——读不读、用哪条、什么时候用、怎么组合，全由你临场自己判断，没有哪一条是必须照做的）：

【一轮怎么运转 · 举例】
比如一轮可能这样推进：你首喊「2 个 3」，对手加数到「3 个 3」，你换更大点数喊「3 个 4」，对手转斋喊「3 个 1」（此后只能加 1 的个数），你觉得全场凑不够 3 个 1 就「开盅」——亮牌数不够则喊价者输、够则开盅者输。这只是一个示例，实际怎么喊由你定。

【核心：知己知彼（这是胜负的重心）】
- 这游戏表面在比概率，真正的胜负多半在"谁更了解对手、谁更不让对手了解自己"。算得准只是入门，读得懂人才能赢。
- 知彼：对手的每次喊价、加价幅度、开盅时机，都带着它的习惯和性格——偏不偏激、爱不爱诈、在什么位置会怂、会不会被你调动。谁更能从这些行为读出对手在想什么、下一步可能怎么走，谁就占先。
- 知己：你要清楚自己手里有什么，更要清楚自己"正在向对手暴露什么"、有没有形成可被利用的规律、当前比分下该稳还是该搏。
- 信息是拿来"藏"和"骗"的，不只是拿来算的。暴露得越少、误导得越准，对手就越难把你逼到墙角。

【概率账（基础事实：这是所有人都能算的"地板"，不是优势）】
- 单挑时对手那 5 颗你看不见。未斋时，任一非 1 点数 m，对手每颗有 1/3 概率能算作 m（掷出 m 或万能 1），平均补 5/3≈1.7 个；转斋后每颗只有 1/6 是 1，平均补 5/6≈0.8 个。
- 全场某点数的大致期望 ≈ 你手里（含万能 1）该点数的个数 + 对手的期望贡献。喊价越接近/低于它越安全，越高于它越危险。
- 现成的数（对手 5 颗、未斋、非 1 点）：能补 ≥1 个约 87%，≥2 个约 54%，≥3 个约 21%，≥4 个约 4.5%；换到 1（斋）：≥1 约 60%，≥2 约 20%，≥3 约 3.5%。
- 这些数的用处是让你对"这手有多虚"心里有底；但你能算，对手也能算——只靠它，你只是棋盘上一个可被预测的对手。

【纯数学的陷阱（信息泄露）】
- 如果每次都按"我有哪个点数就喊哪个"，等于把自己的牌型一条条报给对手；对手一旦看穿，就能顺水推舟把你抬到极限，逼你在自己都不敢确定的高位开盅，或直接按死。
- 一个只按概率出牌的对手最容易被统计、被反向剥削。所以概率之上，还得有"故意不按概率"的那一层。
- 偏离概率不是乱来，要服务于一个目的：让对手误判你、或诱导它犯错。

【诈唬与混合策略】
- 真话和假话掺着喊，让对手无法从你的叫牌稳定推断真假；均衡状态下，关键喊价里的"诈唬牌"大约占两三成。
- 诈唬要让"看起来有支撑"（例如你确实有 1 或该点数的一部分），对手更难判断；纯硬喊的诈唬反而好读。
- 同样手型，时而真喊时而诈，是降低可预测性的一种做法。

【首喊、节奏与转斋（常见做法）】
- 首喊限制个数 2~6、点数 2~6，不能首喊 1。开法可以稳健（从真有支撑的点数起步），也可以喊自己缺的点数去试探对手反应。
- 个数可以一次跳加好几个（抬价更猛、承诺更重），也可以只把点数换大（不加数量地抬门槛）；转斋（喊 1）会把 1 从万能变硬点、并锁死后续只能加 1 的个数，是一步改变全局的棋。
- 比分领先时偏保守、落后时承担更多风险，是常见的取舍。

【读对手（知彼的具体读法）】
- 对手喊某点数，往往暗示它手里有（或故意装作有）该点数加万能 1；它频繁在某一面精准加码，可能真有货；突然大幅跳叫，常是虚张或抢节奏。
- 对手开盅的时机最能暴露它：爱在别人刚抬价就开、还是只在极高位才开；它开对/开错后的反应，也在告诉你它的判断方式。
- 留意"被抬到极限"的信号：如果对手一路顺着你的强点加码，未必是它也有，可能是它在利用你暴露的牌把你顶死。
- 这些都只是线索、不是证据；对手也可能故意做给你看。多轮行为比一手更能说明问题。

【情报与心理】
- 你喊出的每个数字，都是递给对手的一张牌：可能被相信，也可能被利用。
- 领先求稳、落后搏命是常理，但对手也会预判你会这么做，于是"反其道"有时更好。
- 这游戏比的不只是概率，还有谁更会读对方、谁更不被对方读懂。`;

// 非经典套的兵书：只把写死「喊 1 转斋」的两处换成与规则集一致的中性描述，
// 其余逐字沿用（避免规则文本互相打架，又不改动经典臂）。
const PLAY_REFERENCE_FLEX = PLAY_REFERENCE
  .replace('对手转斋喊「3 个 1」（此后只能加 1 的个数），你觉得全场凑不够 3 个 1 就「开盅」',
           '对手转斋喊「2 个 4 斋」（此后 1 不再算万能、个数减半），你觉得全场凑不够就「开盅」或「劈」')
  .replace('转斋（喊 1）会把 1 从万能变硬点、并锁死后续只能加 1 的个数，是一步改变全局的棋。',
           '转斋把 1 从万能变硬点、并把个数取半，是一步能在绝境里搏一下的棋；对手也能用翻倍个数破斋把 1 变回万能。');

const FORMAT = `输出格式（硬要求）：
- 先写你的判断（两三句到一小段，别冗长）：对手这一手的意图、局势正往哪边走（比分与对手行动的变化）、你这手打算怎么打及理由。可以给出你对各种可能性的估计和依据，不必列正式算式。
- 然后另起一行，只写一个行动：喊价写「喊 X 个 Y」（例如：喊 3 个 5），开盅写「开盅」。
- 不要复述骰子、不要输出与行动无关的话。`;

/* ---------- probe 臂：轻量引导，不给答案 ---------- */
const FRAME_PROBE = `你正在和另一个对手进行一场大话骰对决。你是其中一方，另一方是你的对手。
你们各自都想让自己赢、让对方输：每赢一轮你 +1 分、对手 −1 分，你要率先拿到目标积分，同时阻止对手拿分。
对手看不见你的骰子，只能看见你的喊价；但它会记住你这局前面怎么打，并据此调整自己的判断。你也一样，只能看见它的喊价。
所以你喊出的每一手，既是施压，也是在给它递信息。
你的目标只有一个：赢下这场对局。由你自主决定怎么打。`;

// 用户指定的决胜秘诀：保留原句、不解释、不展开成做法。
const MAXIM = '知己知彼，百战不殆。';

const GUIDE_PROBE = `【决胜秘诀】
桌上只留一句老话：${MAXIM}
至于这八个字在这局里指什么、怎么做到，由你自己去想。

关于怎么打，下面只提醒两件事，不给任何固定打法。

一、这局里有个躲不开的拉扯：喊得越贴近自己手里的牌，这一手越稳，但你的牌型也越容易被对手看出来；反过来，故意偏离手里的牌能让对手判断失准，风险却落在你自己身上。两头没有通用的最优解，什么时候偏、偏多少，得看这局的对手是什么样的人。

二、落子前你可以问自己几个问题，问哪些、怎么答都由你定：
  - 我这一手在向对手传递什么？如果照上一手的逻辑继续，它能不能预判我？
  - 对手为什么在这个位置喊这个价，而不是另一个？它为什么现在开，或为什么一直不开？
  - 我这套打法是不是已经连着用了几轮、被它摸清了？
  - 我上一轮关于它的判断，是被证实了还是被推翻了？

上面没有比例、阈值，也没有「该怎么做」的规矩。这个对手的习惯、以及你该不该改变打法，都要靠你自己从这局的喊价和亮牌里找出来。连续几轮用同一套判断却没检查过它是否还成立，通常不是好兆头。`;

const FORMAT_PROBE = `输出格式（硬要求）：
- 先按你自己的方式把这一手想清楚，想多长都行；不必按任何固定条目来，也不必把算式写给我看。
- 最后另起一行，只写一个行动，用「行动：喊 X 个 Y」或「行动：开盅」。这一行必须是最后一行。`;

// 非经典套：把可用的行动词汇补全（转斋 / 破斋 / 劈），仍是硬格式、不喂策略。
const FORMAT_FLEX = `输出格式（硬要求）：
- 先写你的判断（两三句到一小段，别冗长）：对手这一手的意图、局势正往哪边走（比分与对手行动的变化）、你这手打算怎么打及理由。可以给出你对各种可能性的估计和依据，不必列正式算式。
- 然后另起一行，只写一个行动：普通喊价写「喊 X 个 Y」；转斋写「喊 X 个 Y 斋」；破斋写「喊 X 个 Y 破斋」；开盅写「开盅」；劈写「劈」。
- 不要复述骰子、不要输出与行动无关的话。`;
const FORMAT_FLEX_PROBE = `输出格式（硬要求）：
- 先按你自己的方式把这一手想清楚，想多长都行；不必按任何固定条目来，也不必把算式写给我看。
- 最后另起一行，只写一个行动：「行动：喊 X 个 Y」／「行动：喊 X 个 Y 斋」／「行动：喊 X 个 Y 破斋」／「行动：开盅」／「行动：劈」。这一行必须是最后一行。`;

const SUMMARY_INSTRUCTION_PROBE = `本轮的全部信息已在上面摊开。写一段带到后续回合的复盘吧；写什么、按什么顺序写、要不要改打法，都由你自己决定，这里不设必须回答的条目，也不检查你写了哪几条。

只把那句老话再留给你：${MAXIM}
如果想找点落点，也可以顺手想想：这一轮你对对手的读牌，哪些还站得住、哪些该翻了；这套打法是不是已经被它摸清。想不想、想多深都随你。

篇幅不必长，400 字以内够用。这段总结会留在本局后续每一回合的上下文里供你回看；本局每一手的判断与落子也一直摊在上下文里，直到整局结束。整局结束时才把这一切收成一段摘要带到下一局，所以你认为重要的东西要自己写进这段总结里。`;

const MATCH_SUMMARY_INSTRUCTION_PROBE = `这一整局打完了。上面摊开的是本局从头到尾的全部记录：每一轮你写下的复盘、每一手的判断与落子、每次亮牌后的事实，还有上一局留给你的那段摘要。

写一段带到下一局的复盘吧；写什么、按什么顺序写、要不要改打法，都由你自己决定，这里不设必须回答的条目，也不检查你写了哪几条。

只把那句老话再留给你：${MAXIM}
如果想找点落点，也可以顺手想想：这一局你对对手的读牌，哪些最后站住了、哪些该翻了；这套打法是不是已经被它摸清。想不想、想多深都随你。

篇幅不必长，400 字以内够用。下一局开始时，本局这些逐手的记录就不再单独保留了，只会把你这一段带过去；所以你认为重要的东西要自己写进来。`;

const MATCH_SUMMARY_INSTRUCTION = `这一整局打完了。上面摊开的是本局从头到尾的全部记录：每一轮你写下的复盘、每一手的判断与落子、每次亮牌后的事实，还有上一局留给你的那段摘要。请你自己写一段带到下一局的复盘总结：要总结什么、怎么反思、觉得哪些对后面有用，都由你自己决定，我不预设方向。篇幅不必长，400 字以内够用。下一局开始时，本局这些逐手的记录就不再单独保留了，只会把你这一段带过去，所以你认为重要的东西要自己写进来。`;

const CUE_PROBE = '现在轮到你：给出这一手的决断。';

function buildSystem(target, opts = {}) {
  const R = rulesOf(opts);
  const flex = R.zhaiMode === 'half' || R.slash;
  const rules = rulesTextFor(R).replace('{TARGET}', String(target));
  if (opts.variant === 'probe') {
    let s = FRAME_PROBE + '\n\n' + rules + '\n\n' + GUIDE_PROBE;
    s += '\n\n' + (flex ? FORMAT_FLEX_PROBE : FORMAT_PROBE);
    return s;
  }
  let s = FRAME + '\n\n' + rules;
  s += '\n\n' + (flex ? PLAY_REFERENCE_FLEX : PLAY_REFERENCE);
  if (opts.coach) s += '\n\n' + COACH;
  s += '\n\n' + (flex ? FORMAT_FLEX : FORMAT);
  return s;
}

// 喊价序列的标记：经典套只有「喊 1 = 斋」；新套按每一手记录的状态标注。
function seqTag(s, R) {
  if (R.zhaiMode === 'face1') return s.face === 1 ? '（斋）' : '';
  if (s.mode === 'toZhai') return '（转斋）';
  if (s.mode === 'breakZhai') return '（破斋）';
  return s.zhai ? '（斋）' : '';
}
// 结算行的积分与动作：经典套逐字复现旧文本；新套按这一轮实际的 stake / 劈渲染。
function resultTail(h, me, R) {
  if (R.zhaiMode === 'face1') return `${me(h.bid.by)}喊 ${h.bid.count}个${h.bid.face}，${me(h.opener)}开盅，全场${h.bid.face}实际有 ${h.actual} 个（${h.truth ? '够' : '不够'}）→ ${me(h.winner)} +1 / ${me(h.loser)} −1。`;
  const act = h.slash ? '劈' : '开盅', k = h.stake || R.stake;
  const z = h.bid && h.bid.zhai ? '（斋）' : '';
  const tail = h.loserPays === false ? `${me(h.winner)} +${k}，输家不扣分。` : `${me(h.winner)} +${k} / ${me(h.loser)} −${k}。`;
  return `${me(h.bid.by)}喊 ${h.bid.count}个${h.bid.face}${z}，${me(h.opener)}${act}，全场实际有 ${h.actual} 个（${h.truth ? '够' : '不够'}）→ ${tail}`;
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
  const openPay = R.openLoserLoses ? `赢家 +${R.stake} / 输家 −${R.stake}` : `赢家 +${R.stake}、输家不扣分`;
  lines.push(R.slash
    ? `  ① 开盅或劈（质疑开盅前最近的一手，也就是当前这个最高价：对手刚喊的 ${b.count} 个 ${b.face}${seqTag(b, R)}）。开盅${openPay}；劈赢家 +${R.slashStake} / 输家 −${R.slashStake}（只有劈会扣输家的分）`
    : `  ① 开盅（质疑开盅前最近的一手，也就是当前这个最高价：对手刚喊的 ${b.count} 个 ${b.face}${seqTag(b, R)}）。开盅${openPay}`);
  const raises = [];
  const zc = E.zhaiCount(round), bc = E.breakCount(round);
  if (!round.zhai && zc != null) raises.push(`转斋：喊 ${zc} 个 ${R.faceFree ? '1~6 任选点数' : '1'}、写「斋」——个数取上一手的一半向上取整；这一手起 1 不再万能`);
  if (round.zhai && bc != null) {
    const bf = E.breakFaces(round);
    if (bf && bf.length) {
      const pre = round.preZhai;
      const facesTxt = bf.length === 6 ? '任意点数' : bf.slice().sort((x, y) => E.ord(x) - E.ord(y)).join('/') + ' 任选';
      raises.push(`破斋：喊 ${bc} 个 ${facesTxt}、写「破斋」——个数翻倍`
        + (pre && bc === pre.count ? `，且点数必须大于斋前那一手的 ${pre.face}（破斋不能比斋前低）` : '')
        + `；这一手起 1 恢复万能`);
    } else if (bf && round.preZhai) {
      raises.push(`本轮破不了斋：翻倍到 ${bc} 个也超不过斋前那一手（${round.preZhai.count} 个 ${round.preZhai.face}）`);
    }
  }
  if (b.count < 10) raises.push('把个数加到 ' + (b.count + 1) + '~10 任选（可以一次跳加好几个），此时点数 1~6 任选'
    + (round.zhai ? '、仍留在斋状态' : '')
    + (round.zhai && bc != null ? '；但 ' + bc + ' 个这一手固定算破斋' : ''));
  if (!(round.zhai && R.lockFace)) {
    const higher = E.FACE_ORDER.filter(f => E.ord(f) > E.ord(b.face));
    if (higher.length) raises.push('个数保持 ' + b.count + ' 不变、只把点数换成更大的：' + higher.join('/') + ' 任选');
  }
  if (round.zhai) raises.push('当前是斋状态：1 不算万能，只数真实点数；普通抬价写不写「斋」都可以（写了也按普通抬价处理）');
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
  const diff = m.points[who] - m.points[opp];
  const tag = diff > 0 ? `你领先 ${diff} 分` : diff < 0 ? `你落后 ${-diff} 分` : '双方持平';
  const fmtPt = x => (x > 0 ? '+' + x : String(x));
  L.push(`积分：你 ${fmtPt(m.points[who])} 分，对手 ${fmtPt(m.points[opp])} 分，先到 +${m.roundTarget} 分者赢（${tag}）。`);

  const mom = momentum(m, who, histLimit === Infinity ? Infinity : undefined);
  if (mom) { L.push(''); L.push(mom); }

  const past = tail(m.history, histLimit, 10);
  if (past.length) {
    L.push('');
    L.push('前几轮的真实结果（亮牌后的事实，可用来读对手习惯）：');
    for (const h of past) {
      if (h.forfeit) { L.push(`  第${h.no}轮：${me(h.loser)} 未能给出合法行动，判负 → ${me(h.winner)} +1 / ${me(h.loser)} −1。`); continue; }
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
      const outcome = h ? (h.winner === who ? '该轮你 +1' : '该轮你 −1') : '该轮进行中';
      const j = (e.judgment || '').slice(0, 160);
      L.push(`  第${e.round}轮你判断：${j}${j.length >= 160 ? '…' : ''} → 你${e.action || ''} → ${outcome}。`);
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
  L.push(opts.variant === 'probe' ? CUE_PROBE : '现在轮到你：先结合局势走势和你之前的判断写分析（对手意图、局势往哪边走、你这手该怎么打及理由），再另起一行给出你的行动。');
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
          if (h.forfeit) { L.push(`  第${h.no}轮：${me(h.loser)} 未能给出合法行动，判负 → ${me(h.winner)} +1 / ${me(h.loser)} −1。`); continue; }
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
    const diff = m.points[who] - m.points[opp];
    const tag = diff > 0 ? `你领先 ${diff} 分` : diff < 0 ? `你落后 ${-diff} 分` : '双方持平';
    L.push(`积分：你 ${fmtPt(m.points[who])} 分，对手 ${fmtPt(m.points[opp])} 分，先到 +${m.roundTarget} 分者赢（${tag}）。`);
    L.push(m.firstBidder === who || (m.lastLoser === who) ? '本轮由你先喊。' : '本轮对手先喊。');
  } else {
    L.push(`【第 ${m.roundNo} 轮 · 又轮到你】`);
    L.push('你的骰子仍是：' + r.dice[who].join(' '));
    L.push(`积分：你 ${fmtPt(m.points[who])} / 对手 ${fmtPt(m.points[opp])}。`);
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
  L.push(opts.variant === 'probe' ? CUE_PROBE : (opts.noHistory
    ? '轮到你：结合你的记忆笔记和当前局面，先写分析（对手意图、局势往哪边走、你这手怎么打及理由），再另起一行给出行动。'
    : '轮到你：结合对话里的局势变化和你自己之前的判断，先写分析（对手意图、局势往哪边走、你这手怎么打及理由），再另起一行给出行动。'));

  const next = { roundNo: m.roundNo, histLen: m.history.length, seqAt: r.seq.length ? r.seq[r.seq.length - 1].at : 0 };
  return { text: L.join('\n'), next };
}

const SUMMARY_INSTRUCTION = `本轮的全部信息已在上面摊开。请你自己写一段复盘总结，带到后续回合：要总结什么、怎么反思、觉得哪些对后面有用，都由你自己决定，我不预设方向。这段总结会留在本局后续每一回合的上下文里供你回看；本局每一手的判断与落子也一直摊在上下文里，直到整局结束。整局结束时才把这一切收成一段摘要带到下一局，所以你认为重要的东西要自己写进这段总结里。`;

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
    const fk = result.stake || 1;
    L.push(`结算：${me(result.loser)} 未能给出合法行动判负 → ${me(result.winner)} +${fk}`
      + (result.loserPays === false ? '，输家不扣分' : ` / ${me(result.loser)} −${fk}`)
      + `。本轮${result.winner === who ? '你赢' : '你输'}。`);
  } else if (result && result.bid) {
    L.push('');
    if (R.zhaiMode === 'face1') {
      // 经典套：逐字复现旧结算行（上一轮刚补过第一人称胜负标注）
      const wildNote = result.bid.face !== 1 && result.wild ? `（其中 ${result.wild} 个来自万能1）` : '';
      L.push(`结算：${me(result.bid.by)}喊 ${result.bid.count}个${result.bid.face}，${me(result.opener)}开盅，全场${result.bid.face}实际有 ${result.actual} 个${wildNote}（${result.truth ? '够' : '不够'}）→ ${me(result.winner)} +1 / ${me(result.loser)} −1。本轮${result.winner === who ? '你赢' : '你输'}。`);
    } else {
      const k = result.stake || R.stake;
      const wildNote = !result.zhai && result.bid.face !== 1 && result.wild ? `（其中 ${result.wild} 个来自万能1）` : '';
      const pay = result.loserPays === false ? `${me(result.winner)} +${k}，输家不扣分。` : `${me(result.winner)} +${k} / ${me(result.loser)} −${k}。`;
      L.push(`结算：${me(result.bid.by)}喊 ${result.bid.count}个${result.bid.face}${seqTag(result.bid, R)}，${me(result.opener)}${result.slash ? '劈' : '开盅'}，全场${result.bid.face}实际有 ${result.actual} 个${wildNote}（${result.truth ? '够' : '不够'}）→ ${pay}本轮${result.winner === who ? '你赢' : '你输'}。`);
    }
  }
  L.push('');
  L.push(opts.variant === 'probe' ? SUMMARY_INSTRUCTION_PROBE : SUMMARY_INSTRUCTION);
  return L.join('\n');
}

function buildMatchSummaryPrompt(m, who, opts = {}) {
  const opp = E.other(who);
  const me = x => (x === who ? '你' : '对手');
  const fmt = x => (x > 0 ? '+' + x : String(x));
  const L = ['整局结束。'];
  const rounds = (m.history || []).length;
  L.push(`本局共 ${rounds} 轮，最终积分：你 ${fmt(m.points[who])}，${me(opp)} ${fmt(m.points[opp])}（先到 +${m.roundTarget} 分者胜）。`);
  if (m.winner) L.push(m.winner === who ? '这一局是你赢下了。' : '这一局是对手赢下了。');
  else L.push('这一局按积分判为平局。');
  L.push('');
  L.push(opts.variant === 'probe' ? MATCH_SUMMARY_INSTRUCTION_PROBE : MATCH_SUMMARY_INSTRUCTION);
  return L.join('\n');
}

function memoryMarker(roundNo) {
  return `第 ${roundNo} 轮结束。请写一段复盘反思供后续回合参考：`;
}

/* ---------- 自由文本解析 / 规则校验 / 退化检测：统一收敛到 dice-rules.js ---------- */
const RUL = NODE ? require('./dice-rules.js') : root.DiceRules;
const { parseAction, checkLegal, isPromptEcho, extractJudgment } = RUL;

// 各臂写进 system / 复盘提示的固定文本，供 runlog.promptHash 按臂取指纹。
// 经典套的数组逐字保持旧版（历史 run 的指纹仍可对照）；规则集变化时由 promptTexts 生成新数组。
const PROMPT_TEXTS = {
  classic: [RULES_TPL, FRAME, COACH, PLAY_REFERENCE, FORMAT, SUMMARY_INSTRUCTION, MATCH_SUMMARY_INSTRUCTION],
  probe: [RULES_TPL, FRAME_PROBE, GUIDE_PROBE, FORMAT_PROBE, SUMMARY_INSTRUCTION_PROBE, MATCH_SUMMARY_INSTRUCTION_PROBE],
};

// 指纹用：按 (臂, 规则集) 取完整文本数组。经典套返回原数组，保证 prompt_hash 不变。
function promptTexts(variant, rules) {
  const R = rulesOf(rules);
  const base = PROMPT_TEXTS[variant] || PROMPT_TEXTS.classic;
  // 只有内置 classic 才复用逐字旧文本；自定义套（哪怕同为 face1）也必须按自己的参数取指纹。
  if (R.builtin && R.id === 'classic') return base;
  const isProbe = variant === 'probe';
  return [
    rulesTextFor(R),
    isProbe ? FRAME_PROBE : FRAME,
    isProbe ? GUIDE_PROBE : (variant === 'classic' ? COACH + '\n\0\n' + PLAY_REFERENCE_FLEX : PLAY_REFERENCE_FLEX),
    isProbe ? FORMAT_FLEX_PROBE : FORMAT_FLEX,
    isProbe ? SUMMARY_INSTRUCTION_PROBE : SUMMARY_INSTRUCTION,
    isProbe ? MATCH_SUMMARY_INSTRUCTION_PROBE : MATCH_SUMMARY_INSTRUCTION,
  ];
}

const API = { buildSystem, buildUser, buildTurn, buildSummaryPrompt, buildMatchSummaryPrompt, memoryMarker,
  legalMenu, momentum, seqTag, resultTail, rulesTextFor, promptTexts,
  extractJudgment, parseAction, checkLegal, isPromptEcho, ACTION_LINE_RE: RUL.ACTION_LINE_RE,
  PROMPT_TEXTS, RULES_TPL, FRAME, COACH, PLAY_REFERENCE, PLAY_REFERENCE_FLEX, FORMAT,
  FORMAT_FLEX, FORMAT_FLEX_PROBE, SUMMARY_INSTRUCTION, MATCH_SUMMARY_INSTRUCTION,
  FRAME_PROBE, GUIDE_PROBE, FORMAT_PROBE, SUMMARY_INSTRUCTION_PROBE,
  MATCH_SUMMARY_INSTRUCTION_PROBE, CUE_PROBE, MAXIM };
if (NODE) module.exports = API;
else root.DiceContext = API;
})(typeof self !== 'undefined' ? self : globalThis);
