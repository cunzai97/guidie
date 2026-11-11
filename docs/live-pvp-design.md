# 鬼骰 · 实时对战平台设计（feat/live-pvp）

> 目标：把现在「本机浏览器里的模型对弈实验台」扩成一个**可以拉朋友上桌**的实时对战平台。
> 三条能力线：① 好友真人实时对战（含观战）② 自定义「秘诀」提示词的 AI 座位（AI 擂台 / 陪练）③ 人 vs 模型。
> 原则：实验台的评测口径（规则、提示词臂、战绩指纹、复式同种子）**不能被 fork 坏**，平台必须是同一套 `src/` 的另一个前端。

---

## 1. 现状盘点（读码结论）

| 件 | 位置 | 现状 | 对平台的可用性 |
|---|---|---|---|
| 规则引擎 | `src/dice-engine.js` + `src/dice-rulesets.js` + `src/dice-rules.js` | UMD，浏览器与 Node 共用同一份；`newMatch/startRound/canBid/applyBid/normalizeAction/resolveOpen/legalActions`；`mulberry32` 种子化掷骰 | ★★★ 直接搬到服务端当权威 |
| 无头跑批 | `src/runner.js` | `runMatch(players, rng, opts)`，座位接口是 `pl.decide(m, who, memos, stepMeta)`，可选 `reset()/summarize()/reflect()` | ★★★ 服务端对局循环 = 它 + 事件钩子 |
| 事件流 | `src/runner.js:52` | `ev` 只 push 进函数内局部 `events[]`，**没有对外回调** | 需 3 行改造：`opts.onEvent` |
| LLM 座位 | `src/llm.js`（Node，非流式）/ `web/arena.js`（浏览器 fetch + 同源代理） | 两套实现，口径基本一致但不共享代码 | Node 侧直接复用；浏览器侧留给实验台 |
| Bot 座位 | `src/bots.js`（`BOTS` 注册表 + `makeBot(spec, rng)`） | oracle / reader / deep 等，纯计算零 token | ★★★ 当免费陪练与冒烟对手 |
| 提示词 | `src/context.js` | `ARMS` 单表注册秘诀臂（当前只有 `plain`）；`buildSystem()` + `buildTurn()` 增量、**第一人称视角**（只给自己骰子） | ★★★ `buildTurn` 就是天然的「视角投影」 |
| 上下文预算 | `src/ctxlog.js` | append-only 消息流 + 80% 压缩 | 服务端可直接用 |
| 战绩账本 | `runs/matches.jsonl` + `web/ranking.js` | 每局一条，含 `ruleset_hash` / `prompt_hash` 指纹 | ★★★ 云上排名直接长在这上面 |
| 断点续战 | `runs/arena-state.json`（`/api/arena/state`） | 浏览器每落一手 POST 一份快照，刷新即恢复 | 思路复用，实现换成服务端房间快照 |
| HTTP 服务 | `serve-dice.py`（`ThreadingHTTPServer`） | 静态页 + `/a /b /wb /oa` 同源代理（含 SSE 透传）+ presets/matches/state API；`presets.json`、`runs/` 禁止静态直出 | 本机实验台继续用它；平台另起 Node 进程 |

**最关键的一条**：对局的权威循环现在跑在浏览器里（`web/arena.js` 的 `stepOnce / runStep / loop`）。好友对战必须把权威搬到服务端——但 `runner.js` 已经是服务端口径的循环，且座位是接口不是实现。所以这不是重写，是**换一个宿主**。

---

## 2. 核心判断

1. **权威搬到 Node，浏览器只画视图。** 服务端 `runMatch` + `onEvent` 推流；客户端只提交行动。谁也不能开 devtools 偷看对方骰子。
2. **座位是同一个接口 `decide()`。** `human`（挂起等 HTTP 行动）/ `llm`（`makeLLMPlayer`）/ `bot`（`makeBot`）三个实现混排 → 人vs人、人vs模型、模型vs模型、人+模型组队，一套代码。
3. **秘诀自定义走 `ARMS`，不搞第二套提示词管线。** 新增 `custom` 臂 + 座位级 `guide` 覆盖，指纹进 `prompt_hash`，云上跑的每一桌都能复现。
4. **公平性用复式，不靠嘴。** 引擎已有种子化掷骰、`runPK` 已有同种子换座位；平台把「同一副骰子打两把、换座位、比净胜血」做成房间选项。骰运争议从此有数可说。
5. **实验台与平台同源不同进程。** 本机 `serve-dice.py` 继续当实验室（能连 `127.0.0.1:8790/8791` 的私有网关）；云上 Node 进程只暴露房间 API，绝不带本机端点。

---

## 3. 架构

```
朋友手机 / PC 浏览器
   web/play.html  （手机优先：我的骰子 · 当前最高价 · 合法行动按钮 · 结算亮牌 · 观战）
        │  POST /room/<code>/action      （提交行动）
        │  GET  /room/<code>/stream      （SSE：view / bid / settle / 心跳）
        ▼
云：src/room-server.js  （Node 18+，零依赖，bind 127.0.0.1，nginx 反代 + HTTPS）
   ├─ src/rooms.js      房间生命周期：房间码、昵称+口令、座位入座、TTL、重连补帧
   ├─ src/room-match.js runMatch 宿主：座位装配、onEvent → SSE、快照落盘
   ├─ src/view.js       viewFor(m, who)：只投影该座位可见的信息 + legalActions
   ├─ src/human.js      makeHumanPlayer()：decide() 挂起等行动，超时/断线 → 自动接手或判负
   ├─ src/llm.js        LLM 座位（复用）＋ 服务器 Key 保管 / BYOK
   ├─ src/bots.js       Bot 座位（复用）：零成本陪练、冒烟对手
   └─ data/*.jsonl      战绩账本（沿用 matches 记录格式）+ 房间快照
```

### 传输选型：SSE + POST（v1），WebSocket 留后路

- 回合制棋类，延迟不敏感，一条 SSE 长连 + 行动 POST 就够；Node 标准库直接写，**不引 npm 依赖**（与项目零依赖风格一致，也不用你批准装包）。
- 断线重连用 `Last-Event-ID`：服务端每事件带自增 id，重连补发缺失事件，再补一份权威 `view` 兜底。
- 若以后要做「同时几十桌 + 打字聊天」，再加 `ws`；接口层（事件模型 + 行动协议）不变，换传输不影响。

### 座位抽象

```js
// 现有（runner.js）：
player = { name, decide(m, who, memos, meta) -> action, reset?, summarize?, reflect? }

// 新增人类座位：
makeHumanPlayer({ nick, seat, io, timeoutMs, autoPilot })
//   decide(): 推 view → await 行动 Promise（带倒计时）
//   超时：autoPilot ? 取 legalActions 最小合法加价 : 判负（与 strict 口径一致，可配）
//   断线：宽限 N 秒重连，仍不上线 → 转 autoPilot 并广播
```

`llm` 与 `bot` 已满足该接口，混排即得：人vs人 / 人vs模型 / 模型vs模型 / 人+AI 接力（同一座位换人）。

### 视角投影（防偷牌）

`src/view.js::viewFor(m, who)` 输出结构化视图：自己的 5 颗 + 各家点数计数、双方血量、公开喊价序列、当前最高价与斋状态、`legalActions` 列表、剩余思考时限。**绝不包含对方骰子**；结算亮牌后由服务端在 `settle` 事件里补上该轮真值（与实验台 `god` 视角无关，`god` 只存在于实验室）。
文本视图直接复用 `context.js::buildTurn`，保证「人看到的」和「模型看到的」事实同源——这也让「人 vs 模型」是公平对照，不是两套描述。

### 自定义秘诀（你要的那条）

- `context.js` 的 `ARMS` 加一项 `custom`：`guide` 由座位配置提供，`frame/format` 仍用平台硬编码（规则与输出格式不给玩家改，避免把 harness 搞坏）。
- 座位配置加 `guideText`（上限 2000 字，纯文本，不带 URL/图片），进 `buildSystem` 的 `arm.guide` 位置；`prompt_hash` 自动把它算进指纹 → 战绩可复现、可比。
- 玩法化：**AI 擂台**。玩家调一个「秘诀 AI」（`custom` + 模型 + effort），开成公开房间挂墙上，好友排队挑战；每场记战绩，秘诀排名长在 `matches.jsonl` 上。这比「自己调了给自己看」有意思得多，也正好复用现有排名页。
- 注入面：玩家文本只进**该座位自己的** system，绝不进对手视图、绝不进观战视图（可选「公开我的秘诀」开关，默认关，公开则仅在**整局结束后**广播）。

### 身份、房间与观战

- 无账号：`房间码`（6 位）+ 昵称 + 可选口令；`cookie` 里放一个随机 device token，用于排名归属与「我的历史」。
- 房间模式：`pvp`（两人座）/ `pve`（一人座 + 一个 AI 座，AI 可选模型或 bot）/ `arena-host`（AI 当擂主，排队挑战）/ `sim`（两模型互搏，玩家只观战——把实验台搬到云上给人看）。
- 观战：链接即观战，默认**延迟到结算才亮牌**（服务端控制，客户端拿不到早的真值）；`sim` 桌默认可公开观战，方便你分享模型 PK。
- 房间 TTL：无人 30 分钟回收；对局中掉线宽限 120s；快照落盘，进程重启可恢复进行中的桌。

### 模型 Key 与成本（云上必须想清楚的一条）

现在 `presets.json` 里全是 `127.0.0.1:8790/8791`——**云上根本连不到**。三种供法，按场景分：

1. **纯好友对战（pvp）**：零模型、零成本，只要 Node + nginx。这是 v1 的主体验。
2. **平台供模型（pve / 擂台）**：服务器侧 `data/server-presets.json`（0600，永不进 git、永不下发到浏览器），你选哪几个模型上桌、每桌 token 上限、每房用量护栏。
3. **BYOK（自带 Key）**：玩家在房间页填 Base URL/Key，只存内存、只活在这一桌、进程重启即失；UI 明确提示「Key 只在本桌使用」。

另外：`serve-dice.py` 的 `wb_key()` 会去读 `~/work/wb-api/hub/accounts/settings.json` —— 这个自动捞 Key 的行为在云上必须关掉（新增 `PUBLIC=1` / `--public`：禁用自动读 Key、禁用 `/api/presets` 写、`/api/*` 加限流）。

### 与实验台的一致性（不能fork坏的评测口径）

- 同一 `src/` 单一真源；平台不复制规则文本、不自己拼提示词。
- `runner.js` 只加一处向后兼容钩子：`opts.onEvent = opts.onEvent || (() => {})`，`ev` 在 push 本地数组的同时调它。跑批行为不变。
- **Parity 验收**（必须做，不然「平台口径」和「实验台口径」会悄悄漂移）：同一 `deal seed` + 同一 bot 座位（`reader` vs `oracle`，零 token），平台服务端跑出的逐手 `seq`/血量/结算与 `node src/pk.js --deals 1 --seed X` 完全一致，断言到每一手动作。

---

## 4. 新增文件清单（v1 范围）

| 文件 | 职责 | 预估 |
|---|---|---|
| `src/view.js` | `viewFor(m, who)`、`publicView(m)`（观战）、`viewHash` | ~120 行 |
| `src/human.js` | `makeHumanPlayer()`：Promise 挂起、倒计时、断线宽限、autoPilot | ~150 行 |
| `src/rooms.js` | 房间表、入座/换座、事件缓冲与 `Last-Event-ID` 补帧、TTL、快照读写 | ~220 行 |
| `src/room-match.js` | `runMatch` 宿主：座位装配（human/llm/bot 混排）、`onEvent` → SSE、战绩落盘 | ~150 行 |
| `src/room-server.js` | 零依赖 HTTP：`/room` 建/入、`/room/<c>/action`、`/room/<c>/stream`(SSE)、静态 `web/play.html`、限流 | ~320 行 |
| `src/server-keys.js` | 服务器侧模型 Key 保管 + BYOK 会话 + 每房 token 护栏（`PUBLIC` 模式开关） | ~100 行 |
| `web/play.html` + `web/play.js` | 手机优先对战/观战 UI；骰子、喊价阶梯、合法行动按钮、倒计时、结算亮牌、秘诀输入 | ~700 行 |
| `src/context.js`（改） | `ARMS.custom` + 座位级 `guideText` 注入 + 指纹不变 | ~30 行 |
| `src/runner.js`（改） | `opts.onEvent` 钩子 | ~4 行 |
| `serve-dice.py`（改） | `--public`：禁自动读 Key、禁 presets 写、限流、只读 API 白名单 | ~40 行 |
| `tests/test-view.js` | 视图不泄漏对方骰子（含结算时序）、`legalActions` 与引擎一致 | ~80 行 |
| `tests/test-human-seat.js` | 人类座位在 `runMatch` 里跑通：正常行动 / 超时 autoPilot / 断线判负 | ~90 行 |
| `tests/test-room.js` | 两个虚拟客户端打完整一局 + 断线重连补帧 + 房间 TTL | ~140 行 |
| `tests/test-parity.js` | 平台服务端 vs `pk.js` 同种子逐手一致（零 token） | ~70 行 |
| `scripts/deploy/` | systemd unit + nginx 站点片段 + `README-deploy.md` | ~80 行 |

`arena.html` / `arena.js` 不动（实验台继续是本机权威循环）。等 v1 稳了，再评估 M6 把实验台也换成「房间 API 的另一个前端」，那时全项目只剩一条对局管线。

---

## 5. 里程碑与验收

- **M0（本次分支）**：设计文档 + 分支。验收：文档落库，`node tests/test-rules.js` 全绿。
- **M1 人类座位**：`view.js` + `human.js` + `runner.onEvent`。验收：`node tests/test-human-seat.js`（human vs `oracle`，脚本模拟行动，零 token）通过；泄漏测试通过。
- **M2 房间服务**：`rooms.js` + `room-match.js` + `room-server.js`。验收：`tests/test-room.js` 两虚拟客户端打完整一局；`Last-Event-ID` 断线重连补帧后状态一致；`tests/test-parity.js` 与 `pk.js` 逐手一致。
- **M3 玩家 UI**：`web/play.html`。验收：两台真机（手机+PC）打满一局，中途各断线一次能续上；观战链接看到的结算与对局内一致。
- **M4 自定义秘诀 + AI 擂台**：`custom` 臂 + 秘诀输入 + 擂台房 + 排名。验收：同一秘诀同一 seed 复现同一逐手序列；擂台战绩进账本且带 `prompt_hash`；关「公开秘诀」时观战看不到文本。
- **M5 人机（云上模型）**：`server-keys.js` + BYOK + 用量护栏。验收：pve 一桌真人 vs 模型跑通；无 Key 时明确降级为「只跟 bot 打」；每房 token 超限自动停并告知。
- **M6 部署与运维**：nginx/HTTPS/systemd、数据目录、备份回传本机做分析。验收：外网 HTTPS 建桌打满一局；`/api/presets` 与 `presets.json` 从公网拿不到；重启进程后进行中的桌可恢复。

---

## 6. 安全与运维清单（云上必做）

- Node 进程 `bind 127.0.0.1`，只经 nginx 出网；HTTPS 必须（SSE 在 HTTP/1.1 下浏览器同域只有 6 条连，别被 http/2 或 `proxy_buffering` 卡死：nginx `proxy_buffering off; proxy_read_timeout 3600s;`）。
- 密钥：`data/server-presets.json` 0600，不进 git；`/api/*` 永不下发 Key；`--public` 禁 `wb_key()` 自动读本机 settings。
- 输入校验：昵称长度、口令、房间码；行动一律走 `normalizeAction` + `legalActionSet` 校验，非法直接 400，不猜玩家意图。
- 限流：每 IP 建桌频率、每房行动频率、每房 token 预算；SSE 连接数上限。
- 日志脱敏：`calls.jsonl` 风格的调用流水在云上默认只存哈希与摘要，不存完整 system/user 文本（含玩家秘诀）。
- 静态目录：只暴露 `web/` 与 `src/`（引擎需要），`presets.json`/`data/`/`docs/` 一律禁直出——沿用 `serve-dice.py` 的 `_static_blocked` 思路。
- 时钟：超时判定用服务端单调时钟，不信任客户端；倒计时只用于显示。

---

## 7. 待你定的 4 件事

1. **v1 先做纯人到人（零成本、零模型）还是直接带人机？** 我倾向 M1→M3 先打通真人对战，人机(M5) 放后面——云上模型 Key 与成本那摊事会拖慢联调。
2. **擂台模式（玩家调秘诀 AI 守擂，好友挑战）要不要进 v1？** 我倾向进：它正好把「自定义秘诀」这条变成可玩的产品，而不只是一个文本框。
3. **云上模型从哪来？** 把 Qoder hub 部署到云服务器（它自带 Dockerfile/compose），还是云服务器上只放公网 API + BYOK？这决定 M5 的工作量。
4. **战绩要不要跨房持久排名？** 现在 `matches.jsonl` 已有指纹字段，加昵称/device token 就能出云上排行榜（复用 `web/ranking.js`）；不做的话就只留每桌结算。

---

## 8. 本分支已做 / 未做

- 已做：本文档、分支 `feat/live-pvp`。
- 未做：任何代码改动。`runner.js` 的 `onEvent`、`ARMS.custom`、`serve-dice.py --public` 都还只是计划。
- 注：切分支时工作区带着 main 上的未提交改动（`serve-dice.py`、`src/context.js`、`src/ctxlog.js`、`src/llm.js`、`src/pk.js`、`tests/test-arena-bots.js`、`web/arena.html`、`web/arena.js`），它们仍在本分支工作区未提交，不要误当成本次设计改动。
