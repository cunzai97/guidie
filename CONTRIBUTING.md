# Contributing

感谢参与。这个项目的价值在于**结论可归因**，所以任何改动都必须维持「同一份代码 + 同一份提示词 + 同一套规则 → 可复现的结论」这条底线。

## 开发环境

- Node.js **18+**（需要内置 `fetch`）
- Python **3.8+**（只用到标准库，起静态服务用）
- 无第三方 npm / pip 依赖

```bash
git clone <your-fork>
cd d1-mindgame
node tests/test-rules.js  # 规则回归，应输出 ALL PASS
bash start.sh             # 一键起竞技场，默认 8899
```

## 改动前必读

### 1. 规则是单一真源

`src/dice-rulesets.js` 是规则的唯一来源。引擎合法性（`src/dice-engine.js`）、行动解析（`src/dice-rules.js`）、给模型看的规则文本（`src/context.js` 的 `rulesTextFor`）都必须从它派生。

**不要**在任何其它文件里硬编码规则描述。改了规则文本，三处会一起变；只改一处就会产生「模型看到的规则」与「引擎实际判定」不一致的诡异 bug。

### 2. 改动会改指纹

`prompt_hash`（提示词指纹）与 `ruleset_hash`（规则集指纹）写在每次 run 的清单里。改了 `src/context.js` 的提示词或 `src/dice-rulesets.js` 的规则，**指纹必变**。

指纹变了意味着**旧 run 与新 run 不能混进同一组 A/B 统计**。提交 PR 时请在描述里写明：

- 旧指纹 → 新指纹
- 哪些 run 属于改动前、哪些属于改动后

这是本项目最重要的一条统计纪律：跨指纹比较结论，比没有结论更糟。

### 3. 经典套必须逐字稳定

内置 `classic` 规则套是历史对照组，它的 `rulesText()` 返回 `null`（走 `src/context.js` 里逐字未动的 `RULES_TPL`），`ruleset_hash` 也刻意不因新增参数而漂移。

**如果你要加规则参数**：

- 加进 `src/dice-rulesets.js` 的 `normalize()`
- 只在 `zhaiMode === 'half'` 套里才算自由度（像 `firstZhai` 那样），否则 classic 的指纹会变
- 在 `hash()` 的拼接串里同步
- 补 `tests/test-rules.js` 的用例

### 4. 引擎持真值

引擎（`src/dice-engine.js`）持有唯一真值：点数统计、积分、胜负。**LLM 不参与事实判定**。模型说自己有几个点，一律不信。

推论：任何「让 LLM 决定分数」的想法都要先想清楚它会不会让评测自证。

## 提交前检查

```bash
# 语法
for f in src/*.js web/*.js tests/*.js; do node --check "$f"; done
python3 -c "import ast; ast.parse(open('serve-dice.py',encoding='utf-8').read())"

# 规则回归
node tests/test-rules.js

# 无头冒烟（不需要真模型也能跑的部分）
node src/pk.js --p0 threshold --p1 random --deals 10 --out runs/bot-check.jsonl
```

新增判定逻辑时，请同步补 `tests/test-rules.js` 的对拍用例：枚举 (局面, 动作) 全集，比对「解析层的判定」与「引擎的权威集合」必须零差异。

## 提交信息

用中文或英文都可以，说清**为什么**改而不只是改了什么。特别地：

- 改了提示词 → 写明新旧 `prompt_hash`
- 改了规则 → 写明新旧 `ruleset_hash`
- 改了判定 → 写明补了哪些回归用例

## 不要提交的东西

`.gitignore` 已经覆盖实验产物。特别注意：

- `presets.json` —— 含本机 Base URL 与 API Key，**永远不要提交**
- `runs/` —— 实验数据（`*.jsonl`）、调用流水（`calls.jsonl`）、服务日志

要分享配置，用页面里的「导出 / 导入」功能。

## 讨论 LLM 裁判

「让 LLM 当裁判」的设计在 [`docs/llm-judge-plan.md`](docs/llm-judge-plan.md)。那是**规划文档，不是实现**。讨论请从那份文档的「开放问题」一节入手，不要直接改代码——那个改动会动到判定链的核心，风险不低。
