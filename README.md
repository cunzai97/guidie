# 鬼骰 · 大话骰 AI 对弈评测框架

> 两个模型同桌打大话骰。一条链路用来**观战**（浏览器竞技场），一条链路用来**量化**（无头评测）。
>
> 这个项目的重点不是"做个游戏"，而是**让模型博弈能力的评估变得可归因**：同一副牌、同一份规则、同一个提示词，结论能复现、能追责、能分组比较。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![llm-evaluation](https://img.shields.io/badge/llm-evaluation-blue.svg)](https://github.com/topics/llm-evaluation)
[![game-theory](https://img.shields.io/badge/game--theory-blue.svg)](https://github.com/topics/game-theory)
[![prompt-engineering](https://img.shields.io/badge/prompt--engineering-blue.svg)](https://github.com/topics/prompt-engineering)
[![javascript](https://img.shields.io/badge/javascript-yellow.svg)](https://github.com/topics/javascript)

---

## 这是什么

大话骰的规则引擎 + 一套让 LLM 自由博弈的评测框架：

- **规则可配置**：内置两套规则，也能自己造一套（改斋的触发方式、破斋倍数、点数自由度、积分倍率……），规则文本自动生成
- **同源双链路**：浏览器竞技场与无头评测共用同一份引擎、同一份解析器、同一份提示词，不存在"页面一套、评测另一套"
- **过程指标**：不只看胜负，还看开盅正确率、受骗率、诈唬率、判负率、平均重写次数——这些是分辨率更高的信号
- **指纹归因**：每次 run 都记 `prompt_hash` / `ruleset_hash` / `code_hash`，改了提示词或规则导致指纹变化时，前后两批数据**不能混进同一组对比**

---

## 快速开始

```bash
git clone https://github.com/<你的用户名>/d1-mindgame.git
cd d1-mindgame

# 1) 一键起竞技场（静态页 + 同源代理，默认 8899）
bash start.sh
# 浏览器打开 http://127.0.0.1:8899/web/arena.html
# 可选：bash start.sh --open 自动打开浏览器；PORT=9000 bash start.sh 换端口

# 2) 配置模型
#    右上角「模型设置」→ 填 Base URL / 模型 ID / API Key → 保存
#    或者直接编辑 presets.example.json，复制成 presets.json 后改

# 3) 规则自检（零 token，秒级）
node tests/test-rules.js
```

### 需要什么

- **Node.js 18+**（用到内置 `fetch`）
- **Python 3.8+**（只用标准库）
- 没有任何 npm / pip 依赖
- 一个 **OpenAI 兼容端点**（llama-server、Ollama、vLLM、OpenRouter……都行）

### 接自己的端点

浏览器端有三种方式，任选其一：

| 方式 | 做法 |
| --- | --- |
| URL 参数 | 打开 `http://127.0.0.1:8899/web/arena.html?gw=http://192.168.1.10:8080/v1` |
| 页面设置 | 「模型设置」里直接改每个预设的 Base URL |
| 环境变量 | `DICE_WB_BASE=http://你的网关:8791 DICE_WB_KEY=sk-xxx bash start.sh` |

> **为什么需要同源代理？** 大多数推理服务不返回 `access-control-allow-origin`，浏览器直连会被 CORS 拦成 `Failed to fetch`。`serve-dice.py` 提供的 `/oa/*` 路径由页面用 `X-Base` 头指定目标端点，浏览器只跟同源说话，绕开 CORS，同时支持 SSE 流式透传。

---

## 玩法

两人各 5 颗骰子，全场 10 颗。轮流喊价「n 个 m」，意思是"全场 10 颗里点数 m 至少有 n 个"。喊价必须严格大于上一手（加个数，或个数不变换更大的点数，点数序 `2<3<4<5<6<1`）。

轮到你时可以喊价，也可以**开盅**——质疑当前最高价那一手，全场亮牌结算：够数则喊价方赢，不够则开盅方赢。

- **1 是万能牌**（非斋状态时，双方手里的 1 都算数）
- **斋**：经典规则里喊到点数 1 就进斋，1 不再万能且锁死点数
- **劈**（新规）：和开盅一样亮牌结算，但双向扣分——赢家 +1、输家 −1

积分制：开盅只给赢家 +1（输家不扣），劈才双向结算 ±1；率先到目标分者赢下整局。

---

## 规则集

规则不是写死在代码里的一段文本，而是一份可切换、可自定义的配置。内置两套：

| id | 名称 | 语义 |
| --- | --- | --- |
| `classic` | 经典 · 喊 1 为斋 | 喊点数 1 即斋、锁死点数、1 不再万能；无转斋 / 破斋 / 劈。**逐字保留历史规则，指纹稳定，历史数据完全可比。** |
| `flex` | 鬼骰新规 | 取半向上取整转斋、点数全自由、翻倍破斋、开盅赢家 +1（输家不扣）、劈双向 ±1、首喊可直接喊斋。 |

`flex` 的完整语义：

- **转斋**：不抬价而改喊「斋」，个数 = `ceil(当前个数 / 2)`，点数 1~6 任意（**不限制必须喊 1**）；这一手起 1 不再万能
- **首喊也可以直接喊斋**：开局第一手就能喊斋（没有上一手，不用取半）
- **斋内抬价同普通规则**：唯一区别是 1 始终不算万能；**翻倍个数这一手固定算破斋**
- **破斋**：个数 = 当前个数 × 2，**且这一手必须严格大于斋前一手**（转斋前的最高价：个数更多，或同个数但点数更大），破斋后 1 恢复万能。只翻倍不超斋前是非法的——否则「转斋→破斋」能把价越喊越低、无限循环（2026-11-09 实战抓到的漏洞，已修；首喊直接斋没有斋前一手，不受此限）
- **劈**：与开盅完全一样（质疑同一手、同样亮牌），区别是双向结算：赢家 +1、输家 −1——开盅不扣输家分，劈是唯一让对手掉分的手段
- **计分**：开盅赢家 +1、输家不扣分（非零和）；劈双向 ±1。率先达到 +目标分者赢下整局

**自定义规则**：设置抽屉「规则集」里可以「另存副本」，逐项改 16 个参数，右侧实时预览模型将看到的规则文本。自定义套存在 `settings.ruleSets`，CLI 用 `--rules <id>` 也能读。

### 单一真源

```
dice-rulesets.js   规则配置 + 生成给模型看的规则文本  ← 唯一来源
      │
      ├─→ dice-engine.js    legalActions() = 权威合法动作集合
      ├─→ dice-rules.js     checkLegal()  把错误翻译成人话
      └─→ context.js        buildSystem / buildUser / legalMenu / 结算行
```

任何一处硬编码规则描述都会造成"模型看到的规则"与"引擎实际判定"不一致——这个项目早期就踩过这类坑（见下方「一个真实的规则误读」）。

---

## 浏览器竞技场

全新前端：左右双选手卡直观对战、中央喊价台、流式实时推演、底部五个明细页（流水 / 决策明细 / 轮末复盘 / 统计 / 模型排名）。决策明细与轮末复盘也按甲方 / 乙方**左右分栏**。

- **模型预设**：增删改 / 复制 / 测试连接 / 拉取模型列表 / 导入导出。配置写 `presets.json`（服务可用时）并同步 `localStorage`，服务没起也能用
- **每模型思考强度**：`off / low / medium / high / xhigh`。本地 llama-server 走 `chat_template_kwargs.thinking_budget`（1024 / 4096 / 12288 / 24576），远端走 `reasoning_effort`。两个字段都发，端点不认的会忽略。**默认是「中度」**（`settings.defaultEffort`），新建模型也继承中度；复盘请求固定 `off` 以省时。开战前还可直接在布阵区每个席位旁用「思考」下拉临时覆盖本局强度（跟随模型 / 关闭 / 轻度 / 中度 / 深度 / 极限），开战后锁定，不改模型存档
- **输出预算**：每个模型单独设，默认 8192
- **统计按模型左右对照**：底部「统计」页不是两个模型的数据合并，而是**每行一个指标、甲乙两列并排**。指标按「做这个动作的那一方」归属：决策手数 / 调用 / token / 耗时 / 截断 / 歧义 → 行动方；开盅次数 / 开盅正确 / 劈 → 开盅方；转斋 / 破斋 → 喊价方；判负 → 判负方。有明确优劣的指标（重写次数、耗时、截断、判负、开盅正确率、积分）会给胜出一方标金色。合并统计看不出"谁更快、谁更准"，所以拆开
- **亮色 / 暗色**：顶栏一键切，主题持久化
- **8k 预算与截断续写**：`finish=length` 且末行没有完整行动行时，保留未完思考、提示"接着原思路想完、立即决断"再给一次机会，不让"想深想就输"
- **并行复盘**：轮末复盘 `Promise.all` 同时问双方，等两份都回来再一起写回上下文——任何一方都不会读到对方这一轮的复盘
- **上下文生命周期**：① 局内全量（本局所有轮末复盘、所有逐手判断、所有亮牌事实）；② 轮末复盘继承同一份全量，写下的总结带到本局后续回合；③ 整局结束即全部清空，**不带任何东西到下一局**，每局从空白开始
- **判负口径**：三次无合法动作默认判负（与 harness 一致），可关「严格」回退到最小合法加价接手
- **落盘**：`calls.jsonl` 记 `run_id / seat / round / phase / model / ruleset_hash / effort / think_budget`，可与真值按主键对齐；整局结束另写一条 `matches.jsonl` 进排名账本（见下）

---

## 模型排名

底部「模型排名」页：历史对局浏览 + **按对手分计得失的 Elo 天梯**。每局结束（先到目标分或轮数封顶）自动 POST 一条记录到 `/api/matches`，追加进 `runs/matches.jsonl`；中途重新布阵的半局不记。

**算法**（`web/ranking.js`，纯函数，浏览器与 `tests/test-ranking.js` 同源）：

```
E_A = 1 / (1 + 10^((R_B − R_A) / 400))
R_A += K × (S_A − E_A)        K = 32，初始 1500，胜 1 / 平 0.5 / 负 0
```

- **虐菜刷不动分**：赢低 200 分的对手只涨约 3 分，赢高 200 分的涨约 24 分；输给弱手重扣约 29 分。分数反映「赢了谁」，不是「赢了多少场」
- **按指纹分组**：每个 `(ruleset_hash × prompt_hash)` 组独立一张榜，跨指纹的胜负不混排（规则 / 提示词一改就是新榜）。`prompt_hash` 用纯 JS SHA-1 现算，与 `runlog.promptHash` 逐字节一致
- **身份 = 端点 + 模型 ID**：改别名 / 重建预设不分家；同模型自战不涨不跌
- **强度子榜**：选某档思考强度时只收「双方都用了该档」的对局，混档局只在「全部」里出现
- **定级中**：少于 5 场标 provisional；按时间顺序逐局更新，所以同胜负不同顺序分数不同（路径依赖是 Elo 的本性）
- 不按净胜分加权：目标 3 / 5 / 10 / 15 分的局不可比，只取胜负平

**账本一行**（`matches.jsonl`）：`t / run_id / gameNo / source / seats{A,B}(id,alias,model,base,effort,maxTokens) / ruleset_hash / prompt_hash / variant / rules / target / rounds / points / winner / draw / capped / stats{A,B}`。GET `/api/matches` 返回 `{"matches":[...]}`。无头 CLI 的历史 run 不进这张榜（旧指纹 + 复式换座 schema 不同）。

---

## 无头评测

浏览器适合看棋，量化模型能力用无头 runner。**判分全确定性、零 LLM judge。**

```bash
# 基线自检（零 token）：阈值 bot 应胜随机 / always-open
node src/pk.js --p0 threshold --p1 random --deals 30 --out runs/bot-baseline.jsonl

# 模型 vs 数学基线
node src/pk.js --p0 llm:8080:my-model --p1 threshold --deals 6 --out runs/llm.jsonl

# 模型 PK
node src/pk.js --p0 llm:8080:model-a --p1 llm:8081:model-b --deals 10 --rules flex

# 分析
node src/analyze.js runs/llm.jsonl
```

**player 规格**：`threshold[:阈值]`（默认 0.5）/ `random` / `always-open` / `never-open` / `oracle`（纯数学参照，见下）/ `reader`（贝叶斯读喊价，见下）/ `llm:<端口>:<模型名>` / `wb:<模型名>`（本地网关）

**开关**：`--deals N --seed S --target 分 --max-rounds N --thinking on|off --effort off|low|medium|high|xhigh --rules classic|flex|<自定义id> --max-tokens N --temperature T --coach（仅 classic 生效） --context chat|memory|snapshot --prompt classic|probe --out 文件 [--append]`

### 三个设计要点

**复式赛**：每个 seed 打两局、第二局交换座位，同一副骰子对消骰运与先手优势（也暴露镜像协方差）。

**第一人称上下文**：给模型的每一行都是"你 / 对手"，明确身份、自己骰子 + 计数、比分、喊价归属、合法动作菜单。引擎的 `roundLine` 是上帝视角（甲/乙），**绝不喂模型**。

**归因**：解析 → 规则校验 → 最多重写 3 次；仍非法判负（forfeit），harness 不替模型走棋；连接彻底失败则该局"未评"。`finish_reason=length` 且末行无完整行动行时视为"想完但还没决断"：保留未完思考，提示「接着它想完、立即决断」再给一次机会（绝不说"请简短"，那会直接压掉推理）。

### 提示词两臂

| 臂 | 做法 |
| --- | --- |
| `classic` | 原版 system（含兵书与三槽输出格式） |
| `probe` | 轻量引导臂：保留「知己知彼，百战不殆」但**不解释、不展开**；删掉全部可执行结论与数字（概率表、诈唬占比…），只留一个张力陈述 + 一组自问清单 + 一条元认知触发 |

`probe` 明确忽略 `--coach`（那是历史遗留的强引导臂，与它直接冲突）。

### 纯数学 oracle 参照

`oracle` 是零训练、零拟合参数、确定性的**两层 expectimax**：精确二项/多项分布算概率，枚举对手 252 种手牌型；假设对手按「P<0.5 开盅、否则抬最真价」的数学打法，算到对手反抬后我方的最佳回应。它是「数学对数学」的**地板参照**——LLM 打赢它才算展现出超越算概率的博弈能力；但它不是 GTO 天花板，对手实际打法偏离模型假设时强度会打折。

校准（classic，100 deal 复式 = 200 局，target 10，seed 12345）：

| 对手 | oracle 胜率（计分局） | 配对 95% CI |
| --- | --- | --- |
| threshold(0.5) | 145 胜 32 负 23 平（81.9%） | [0.74, 0.828] |
| threshold(0.5)（flex） | 154 胜 42 负 4 平（78.6%） | [0.723, 0.833] |
| random / always-open / never-open | 全胜 | [1, 1] |

对 threshold 的过程指标：开盅正确率 0.369 vs 0.197，受骗率 0.023 vs 0.062，诈唬被抓 510 vs 1127。

**首个 LLM 实测（2026-11-10，flex，`wb:minimax-m3.1-flash`，effort off / 2048 / chat / classic 臂，4 deal 复式 target 5）**：oracle **5-3** 胜（MiniMax 胜率 37.5%，配对 CI [0.125, 0.5]，小样本不能排除均势）。过程指标方向一致：开盅正确率 MiniMax 0.162 vs oracle 0.370，诈唬被抓 20 vs 6；零判负零截断零连接错误（输的是决策质量，不是规则理解）。MiniMax 的 3 胜全部来自**信息性喊价剥削**：oracle 的对手模型把喊价当无信息随机事件，「P<0.5 必劈」被真货价值喊价双倍收割（那 3 局 oracle 开盅 18 次只对 2 次）；但它自己的开盅纪律差，系列赛仍输。结论：纯数学地板能被「知己知彼」式打法剥削——这是设计内的能力信号；要把地板升成绝对标尺，需给对手模型加贝叶斯读牌（喊价即信息）乃至 CFR。

### 读牌 reader（贝叶斯对手模型）

`reader` 修掉 oracle 的可剥削点：不再把对手喊价当无信息随机事件，而是在 252 种对手手牌型上维护贝叶斯后验。生成模型——P(开盅|h)=logistic(γ·(0.5−P(当前价|h)))、P(喊 b|h)=(1−P开)·softmax(β·P(b|h))，再加 ε 均匀混合防模型失配；每看到一手喊价按似然更新权重，轮内累积、每轮重置（骰子每轮重摇）。开盅/劈 EV 用后验真值概率，抬价 EV 对后验做 expectimax，叶子用对手反价再更新一次后验。β/γ/ε 是固定行为假设，零训练、零对局拟合、确定性。期望枚举按「同面取最小个数」剪枝（策略等价类，|合法价| 54→12），信念更新仍用全支撑。

校准（target 10，30 deal 复式 = 60 局，零 token）：对 oracle **classic 98.3%（CI 95.8–100）/ flex 60-0 零封**（开盅正确率 0.477 vs 0.153）；对 threshold flex **60-0**（0.723 vs 0.152）。同一局面下 v2 会劈的价值喊价，reader 不劈——唯一变量就是读牌。

MiniMax 实测（2026-11-10，flex、target 10、2 deal 复式 = 4 局）：**reader 4-0 完封**（10:-6 / 10:0 / 10:0 / 10:2，两座位各两局）。开盅正确率 **0.875**（16 开 14 对，其中劈 11 次）vs MiniMax **0.167**（36 开 6 对）；0 判负 0 截断 2 重写。对照：同一模型 target 5 对 v2 oracle 是 3-5 输——补上「读喊价」后一局都拿不下。成本 137 调用 / 33.6 credits。

本地模型实测（同参，`llm:1235:avalon-iq3ks-256k`，flex target 10，2 deal）：**reader 4-0**（10:0 / 10:1 / 10:4 / 10:-7），开盅正确率 **0.769** vs avalon **0.289**；155 调用 2 次 length 截断、12 次重写、**2 次判负**（第 4/5 轮的格式失败丢轮，非策略亏损，量化时需剥离）。avalon 的逐手推理里 78/123 次察觉到「套路被看穿」，但手牌级泄露（喊价即情报）只闪现 1 次（第 4 局喊自己没有的 4 污染对手信念），未固化成策略；chat 臂无轮末复盘，测的是临场能否想到。

**probBidTrue 修复（2026-11-10）**：引擎的二项尾概率此前从 c=1 起步而非 C(5,need)，整条概率被系统性低估（need=1 时 0.17 vs 真值 0.87）。只有 bot 在用这个函数；提示词里的概率表是独立写死的正确值，**prompt_hash 不变，历史 LLM 对局数据仍可比**；但所有 threshold 基线旧数据作废。修复后 threshold 对 never-open 50 deal 全胜——旧记录里「阈值输给 never-open 的非传递性」主要是这个 bug 的伪影，不是博弈深度证据。

### 落盘约定

- `--out` **默认覆盖写**（早期是追加，同一文件重跑会把两次实验混在一起；要续写显式加 `--append`）。落盘建议放 `runs/`（已 gitignore，页面代理的 `calls.jsonl` 与服务日志也在那里）
- 每次运行生成 `run_id`，首行 `kind=run-start` 写全量配置 + `prompt_hash` + `code_hash`，末行 `kind=summary` 标 `status=complete`；异常退出补 `run-aborted`
- 所有事件共用主键 `{run_id, deal, swap, game, round, step, seat, phase, ask}`，`call` 与 `game.events` 的真值可按主键直接对齐
- `analyze.js` 默认只统计 `complete` 的 run（`--all` 强制纳入中断实验）

### 过程指标

胜负之外的高分辨率信号（引擎持真值，零成本）：开牌正确率（ToM 直接度量）、受骗率、诈唬率 / 被抓、forfeit、平均重写次数。

还有一组**预算健康度**指标：`truncRate`（静默截断率）、`ambiguousRate`（解析多候选率）、`avgPromptTokens` / `avgCompletionTokens` / `cacheRate` / `avgCallMs`。

> 截断率高时胜负主要由输出预算决定，**不要据此比较模型能力**。

---

## 上下文复用口径

两条链路的"复用"不是一回事，比较结果前先对齐口径。

### 浏览器竞技场：内容级全量，局间清空

代理只透传 `messages`，不维护会话；每一手仍新建 `[system, user]` 两条消息（没有 assistant 历史），所以**不是对话级复用 / KV cache 复用**，前缀能稳定命中的只有 system 那一段。但**信息层面**已按局内全量打通：

| 阶段 | 模型能看到什么 | 边界 |
| --- | --- | --- |
| ① 局内（本局每一手） | 本局所有轮末复盘 + 所有逐手判断与落子 + 所有亮牌结算事实 + 当前局面 | 不做静默截断。超预算时只折叠**最早**几轮的逐手判断并明确标注 |
| ② 轮末复盘 | 继承同一份全量上下文，再加收束事实与复盘指令 | 跳过本轮结算行，避免重复 |
| ③ 下一局 | 空白开始 | 上一局的复盘与逐手分析全部清空，不做任何跨局继承 |

### 无头评测口径

- `--context chat`（默认）= **对话级真复用**：`messages` 持久、`buildTurn` 增量追加、system 只发一次、重试脚手架不入史
- `--context memory` = 摘要链：`summarize()` 用 `[system, ...backbone, ...working, summaryPrompt]`，跨局按 deal/game reset
- `--context snapshot` = 不复用（对比臂）

> ⚠️ 页面的复盘口径**不能外推到 CLI 默认模式**：CLI 默认 `chat` 模式全程不调用 `buildSummaryPrompt`，想对齐页面口径要显式 `--context memory`（摘要链同样只在局内，跨局 reset）。

---

## 归因指纹

**规则集或提示词一变，指纹必变。跨指纹的 run 不能混进同一组 A/B 统计。**

| 规则集 | `ruleset_hash` | `classic` 臂 `prompt_hash` | `probe` 臂 `prompt_hash` |
| --- | --- | --- | --- |
| `classic` | `177d9fc1` | `04acb400bcba` | `e8338cfb73f1` |
| `flex` | `b680b754` | `17207d104e1b` | `f10b6e2cdfb3` |

`firstZhai` / `breakMustExceed` / `openLoserLoses` 只在 `half` 套里才有意义，不参与经典套哈希——所以给规则加参数不会让经典套的指纹漂移。`flex` 在 2026-11-09 连做两处语义修正：破斋必须严格大于斋前一手（堵压价死循环）、计分改为开盅只赢家 +1 / 劈才 ±1；`ruleset_hash` 由 `dc7a1605` → `4211d6fb` → `b680b754`：**修复前的 flex run 与修复后不可比**。2026-11-10 移除跨局整局复盘继承（只保留轮末复盘带到下一轮），轮末复盘指令的生命周期描述随之改为「整局结束即清空」，并删掉整局复盘指令文本：**四个臂的 `prompt_hash` 全部变化**（classic 臂 `01707c0ad70a` → `04acb400bcba`、probe 臂 `9d0396ea3639` → `e8338cfb73f1`；flex 对应 `be8b49467564` → `17207d104e1b`、`5956cfdba120` → `f10b6e2cdfb3`），此前的 run 与此后不可比。

---

## 一个真实的规则误读

这个项目的规则文本被反复打磨过，起点是一次实测。

某局第 5 轮，甲方模型手里 2 张 3、没有 1，对手喊「7 个 3」。正确解是**直接开盅**（全场 3 最多 7 个，需要对手 5 颗全是 3 或 1，概率约 0.41%）。

模型却写：「升到 8 个 3 后全场必然不足，就应把对手逼入只能开盅认输的位置」，然后喊了 8 个 3，对手当场开盅拿分。

复盘发现：它把「开盅质疑的是**开盅前最近的一手**」错记成「永远质疑对手之前喊的 7 个 3」，还误以为「我方没有 1 就不存在万能牌补足」（**对手的 1 同样算**）。

引擎逻辑、规则条款、上下文供给全部核对无误——**是规则应用算反，不是规则没给**。于是规则文本做了立场中立的改写：明确「只要你抬出一手新价，最新一手就换成你喊的」「双方手里的 1 都算万能牌」。

代价是两臂 `prompt_hash` 同时变化，所以规则澄清前后的 run 必须分组统计。**这是纯规则归属澄清，不含任何"该开还是该喊"的策略结论。**

---

## 项目结构

```
start.sh              一键启动：依赖检查 → 起服务 → 就绪检查（--open 打开浏览器）
serve-dice.py         静态服务 + 同源代理 + 预设 API
presets.example.json  配置模板（复制成 presets.json 后改；后者含本机信息，不入库）

web/                  浏览器竞技场
  arena.html/css/js   对弈台前端（加载 ../src/ 的共享模块）

src/                  共享引擎与无头评测
  dice-rulesets.js    规则集配置 + 生成给模型看的规则文本（单一真源）
  dice-engine.js      规则引擎：合法动作集合、状态推进、结算（UMD，浏览器/Node 共用）
  dice-rules.js       行动解析与合法性措辞（UMD）
  context.js          提示词与上下文构建（UMD，页面与 Node 共用）
  bots.js             基线 bot：阈值 / 随机 / 常开 / 常不开 + 纯数学 oracle（两层 expectimax）+ 读牌 reader（贝叶斯后验）
  llm.js              模型玩家：多臂上下文、截断续写、思考强度
  runner.js           复式赛 + 过程指标 + 配对 bootstrap
  pk.js               CLI 入口
  runlog.js           运行账本与指纹
  analyze.js          落盘分析：博弈质量分桶 + 判断×真值对齐

tests/                回归与离线冒烟（零 token、不触网）
  test-rules.js       规则属性测试（枚举对拍 + 随机对局）
  smoke-chat.js       持久对话模式冒烟（桩 fetch）
  smoke-memory.js     摘要链模式冒烟（桩 fetch）
  test-echo-prune.js  回声不入库 / 不级联回归
  test-oracle.js      概率对拍 7776 枚举 + oracle 性质/冒烟回归
  test-reader.js      读牌后验方向/剥削点修复/确定性/冒烟
  test-ranking.js     Elo 排名：分组/对手强度/身份合并/路径依赖

runs/               实验产物（gitignore）：--out 落盘、calls.jsonl、serve.log
docs/
  llm-judge-plan.md   LLM 裁判设计规划（仅规划，未实现）
```

`src/dice-engine.js` / `dice-rules.js` / `context.js` / `dice-rulesets.js` 都是 **UMD**：浏览器挂到 `window.DiceEngine` 等全局，Node 里 `require()` 同一份实现。**页面与无头评测因此不可能跑出两套行为。**

---

## 已知边界

- **无头评测默认 `chat` 上下文全程不调用轮末复盘**——想用复盘要显式 `--context memory`
- **页面只采集 `completion_tokens`**，没有 `prompt_tokens` / `cached_tokens`，KV cache 是否命中在页面侧不可测（CLI 侧有 `cacheRate`）
- **`--out` 默认覆盖写**，同一文件重跑会覆盖旧数据（这是刻意的，见「落盘约定」）
- **"可复现"目前只保证骰子**：模型侧 seed 未固定，`temperature` 默认 0.7
- 基线 bot 是**校准参照**而非不可战胜的标准；oracle 也只是「数学对数学」地板，不是 GTO 天花板——打赢 oracle 是博弈能力的必要非充分证据
- **2026-11-10 前的 threshold 基线数据作废**（probBidTrue 二项系数 bug，见「纯数学 oracle 参照」）；LLM 历史数据不受影响

---

## 开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。最重要的一条纪律：**改动会改指纹**，请在 PR 描述里写明新旧 `prompt_hash` / `ruleset_hash`。

```bash
node tests/test-rules.js    # 规则回归，应输出 ALL PASS
for f in src/*.js web/*.js tests/*.js; do node --check "$f"; done
```

---

## 规划中

- **LLM 裁判**——让裁判由 LLM 担任、规则不再由代码枚举死。设计见 [`docs/llm-judge-plan.md`](docs/llm-judge-plan.md)（**仅规划文档，尚未实现**）
- 规则集字段级「交由裁判裁量」的标记

---

## License

[MIT](LICENSE)
