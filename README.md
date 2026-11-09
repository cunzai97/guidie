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

全新前端：左右双选手卡直观对战、中央喊价台、流式实时推演、底部四个明细页（流水 / 决策明细 / 轮末复盘 / 统计）。决策明细与轮末复盘也按甲方 / 乙方**左右分栏**。

- **模型预设**：增删改 / 复制 / 测试连接 / 拉取模型列表 / 导入导出。配置写 `presets.json`（服务可用时）并同步 `localStorage`，服务没起也能用
- **每模型思考强度**：`off / low / medium / high / xhigh`。本地 llama-server 走 `chat_template_kwargs.thinking_budget`（1024 / 4096 / 12288 / 24576），远端走 `reasoning_effort`。两个字段都发，端点不认的会忽略。**默认是「中度」**（`settings.defaultEffort`），新建模型也继承中度；复盘请求固定 `off` 以省时。开战前还可直接在布阵区每个席位旁用「思考」下拉临时覆盖本局强度（跟随模型 / 关闭 / 轻度 / 中度 / 深度 / 极限），开战后锁定，不改模型存档
- **输出预算**：每个模型单独设，默认 8192
- **统计按模型左右对照**：底部「统计」页不是两个模型的数据合并，而是**每行一个指标、甲乙两列并排**。指标按「做这个动作的那一方」归属：决策手数 / 调用 / token / 耗时 / 截断 / 歧义 → 行动方；开盅次数 / 开盅正确 / 劈 → 开盅方；转斋 / 破斋 → 喊价方；判负 → 判负方。有明确优劣的指标（重写次数、耗时、截断、判负、开盅正确率、积分）会给胜出一方标金色。合并统计看不出"谁更快、谁更准"，所以拆开
- **亮色 / 暗色**：顶栏一键切，主题持久化
- **8k 预算与截断续写**：`finish=length` 且末行没有完整行动行时，保留未完思考、提示"接着原思路想完、立即决断"再给一次机会，不让"想深想就输"
- **并行复盘**：轮末与整局复盘都 `Promise.all` 同时问双方，等两份都回来再一起写回上下文——任何一方都不会读到对方这一轮的复盘
- **上下文三段生命周期**：① 局内全量（本局所有复盘、所有逐手判断、所有亮牌事实）；② 轮末 / 整局复盘继承同一份全量；③ 到下一局只保留整局复盘摘要，丢弃逐手具体分析
- **判负口径**：三次无合法动作默认判负（与 harness 一致），可关「严格」回退到最小合法加价接手
- **落盘**：`calls.jsonl` 记 `run_id / seat / round / phase / model / ruleset_hash / effort / think_budget`，可与真值按主键对齐

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

**player 规格**：`threshold[:阈值]`（默认 0.5）/ `random` / `always-open` / `never-open` / `llm:<端口>:<模型名>` / `wb:<模型名>`（本地网关）

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

### 浏览器竞技场：内容级全量 + 三段生命周期

代理只透传 `messages`，不维护会话；每一手仍新建 `[system, user]` 两条消息（没有 assistant 历史），所以**不是对话级复用 / KV cache 复用**，前缀能稳定命中的只有 system 那一段。但**信息层面**已按三段生命周期全量打通：

| 阶段 | 模型能看到什么 | 边界 |
| --- | --- | --- |
| ① 局内（本局每一手） | 上一局的整局复盘摘要 + 本局所有轮末复盘 + 所有逐手判断与落子 + 所有亮牌结算事实 + 当前局面 | 不做静默截断。超预算时只折叠**最早**几轮的逐手判断并明确标注 |
| ② 轮末 / 整局复盘 | 继承同一份全量上下文，再加收束事实与复盘指令 | 轮末复盘跳过本轮结算行，避免重复 |
| ③ 下一局 | 只保留上一局的整局复盘摘要 | 上一局的逐手分析全部丢弃 |

### 无头评测口径

- `--context chat`（默认）= **对话级真复用**：`messages` 持久、`buildTurn` 增量追加、system 只发一次、重试脚手架不入史
- `--context memory` = 摘要链：`summarize()` 用 `[system, ...backbone, ...working, summaryPrompt]`，跨局按 deal/game reset
- `--context snapshot` = 不复用（对比臂）

> ⚠️ 页面观察到的跨局继承效果**不能外推到 CLI**：CLI 默认 `chat` 模式全程不调用 `buildSummaryPrompt`，想对齐页面口径要显式 `--context memory`。

---

## 归因指纹

**规则集或提示词一变，指纹必变。跨指纹的 run 不能混进同一组 A/B 统计。**

| 规则集 | `ruleset_hash` | `classic` 臂 `prompt_hash` | `probe` 臂 `prompt_hash` |
| --- | --- | --- | --- |
| `classic` | `177d9fc1` | `01707c0ad70a` | `9d0396ea3639` |
| `flex` | `b680b754` | `be8b49467564` | `5956cfdba120` |

内置 `classic` 的 `prompt_hash` 逐字未动，历史数据完全可比。`firstZhai` / `breakMustExceed` / `openLoserLoses` 只在 `half` 套里才有意义，不参与经典套哈希——所以给规则加参数不会让经典套的指纹漂移。`flex` 在 2026-11-09 连做两处语义修正：破斋必须严格大于斋前一手（堵压价死循环）、计分改为开盅只赢家 +1 / 劈才 ±1；`ruleset_hash` 由 `dc7a1605` → `4211d6fb` → `b680b754`：**修复前的 flex run 与修复后不可比**。

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
  bots.js             基线 bot：阈值 / 随机 / 常开 / 常不开
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
- 基线 bot 是**校准参照**而非不可战胜的标准——阈值 bot 输给 never-open 是游戏有博弈深度的证据，不是 bug

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
