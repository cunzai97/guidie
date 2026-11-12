# 实时对战 · 上手说明

一句话：这是给**真人上桌**玩的页面（`http://127.0.0.1:8898/web/play.html`）。
跑批评测和模型排名还是原来那套竞技场（`http://127.0.0.1:8899/web/arena.html`），
两个页面共存、共用同一份规则与引擎，不是谁替换谁。

---

## 一、让朋友能打开这个网页

服务默认只听 `127.0.0.1`，**只有你这台机器能打开**。要给朋友玩，看你要哪一种：

### 1. 同一局域网（最简单，朋友在你家 WiFi / 同内网）

```bash
HOST=0.0.0.0 PORT=8898 bash live.sh
```

把 `http://192.168.8.119:8898/web/play.html` 发给他（`hostname -I` 看你当前内网 IP）。
手机也能直接开，页面是手机优先的。

注意：这等于把牌桌开到整个内网。桌可以设口令（建桌时「桌口令」），
没设口令的人拿到房号就能进来看。

### 2. 走云服务器：两种模式，差别很大

你的云机：`py-server` = `101.34.71.12`（Ubuntu，node v20，nginx 1.24，已在跑 80/443）。

#### 模式 A：权威搬到云上（朋友随时能进，你本机可以关机）

```bash
bash deploy/deploy-live.sh          # 只推代码：src/ web/ tests/ live.sh，不推 Key、不推 data/、不推 presets.json
```

然后这三步要你在云上自己执行（要 root）：

```bash
# 1) 常驻服务（只听 127.0.0.1:18898，公网只能通过 nginx 进来）
sudo cp deploy/dice-live.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dice-live
journalctl -u dice-live -n 20

# 2) nginx 入口（SSE 必须 proxy_buffering off，否则喊价会整批憋着不弹）
sudo cp deploy/nginx-dice-live.conf /etc/nginx/sites-available/dice-live
sudo ln -s /etc/nginx/sites-available/dice-live /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 3) 腾讯云控制台 → 安全组：放行入方向 TCP 8443
```

朋友访问：**`https://101.34.71.12:8443/web/play.html`**

云上这一台得注意三件事：
- `presets.json` 不会推上去（里面有你的 Key），云上那份是空的 → 朋友只能用**内置人机**或**自带公网 Key**；
  你家的 `127.0.0.1:8790/8791` 网关在云上到不了，选了会被明确拒绝并告诉他换一座
- 出网默认拒绝本机端口、内网网段、云元数据地址；要允许某些公网端点用 `DICE_ALLOW_HOSTS` 白名单
- 公网就收紧限流：`DICE_RATE_CREATE` / `DICE_RATE_SECRET` / `DICE_RATE_PRESET`，每桌再配 token 预算

#### 模式 B：云上只当门面，权威仍在你本机（你停了就断）

```bash
ssh -N -R 18898:127.0.0.1:8898 py-server      # 把本机牌桌透到云机的 127.0.0.1:18898
```

nginx 那份配置不用改（它反代的就是 `127.0.0.1:18898`），安全组同样放行 8443。
这条路的性质你已经知道了：**权威进程在你家里**，你本机一停、或这条 ssh 一断，
云上那半截立刻没人发牌——朋友能打开页面也进不了桌。临时约几把可以用，长期玩选模式 A。

---

## 二、玩家侧怎么玩（发这个给朋友就够）

1. 打开页面，填**昵称**
2. 选座位：
   - **真人** —— 你本人手打，每手有思考时限，超时按桌规自动接手或判负
   - **大模型** —— 用你自己的 API Key（存你账号里，服务器加密保存），可另填「必胜秘诀」
   - **平台预设** —— 房主提供的模型，Key 在服务器侧，不消耗你的额度
   - **内置人机** —— 不用 Key，秒回，适合练手（oracle 纯数学、reader 读牌、deep 双向读牌）
3. 「开桌」→ 把邀请链接（带房号）发给朋友；他点进来自动坐另一座
4. 轮到你时：选**个数** + **点数** → 「走这一步」；或者「开盅」/「劈」
5. 斋局（斋 = 1 不算万能）与翻倍破斋的规则按桌选的规则集走，页面上会显示当前能不能破斋
6. 打累了点「认输」—— 整局立刻判负收口，不会拖着你等下一轮
7. 不想打可以「回房间」，中途关页面没事：重新点邀请链接进来，用同一座位令牌坐回原位

**观战**：不填座位、直接输房号进来就是观战。看得到喊价、开盅亮牌和结算，
看不到任何人的骰子底牌和别人的私有提示——这是硬口径。

---

## 三、房主要知道的几件事

- **座位令牌**：建桌时给你那一座的令牌只出现在你自己的链接/本地存储里，房间信息接口里查不到
- **复式**：同一副骰子打两把、两把换座位，净胜血按人累计——比的就是「同一手牌谁处理得好」
- **token 预算**：可以给每桌上限（默认无上限，平台预设桌有默认值），超了直接叫停，不会把谁的额度打空
- **战绩**：每桌结束落一行 `data/matches-live.jsonl`，`ruleset_hash` / `prompt_hash` 一并记录，
  和跑批同一套指纹，能直接进排名页
- **Key 去哪了**：账号里的 Key 是 AES 密文（`data/secret.key` + `data/users.json`），
  临时填的 Key 只进内存保险柜，桌散就销毁；事件流、房间信息、战绩里都只有掩码和调用数字
- **出网防线**：玩家自带的 Base URL 要过策略——本机端口、内网网段、云元数据地址默认全拒。
  你自己要用本机 8790/8791 这类网关，起服务时显式放行：`DICE_LOCAL_PORTS=8790,8791`

---

## 四、起停与自检

```bash
bash live.sh                       # 起（默认 127.0.0.1:8898）
HOST=0.0.0.0 bash live.sh          # 让局域网朋友能进
```

**一条命令跑全部回归**（零 token，自己起临时服务、跑完自动关）：

```bash
bash scripts/check-live.sh                                  # 全自动
BASE=http://127.0.0.1:8898 bash scripts/check-live.sh       # 对着你正在跑的那台验
```

它分六组，每组只为一件事，别当成「多跑几个脚本」：

| 组 | 验什么 | 用例 |
|---|---|---|
| 1 规则口径 | 实时对战与跑批共用同一份引擎，漂了就全错 | `test-rules.js` |
| 2 内置人机 | 免费陪练必须合法且真会读牌 | `test-bots-legal / test-oracle / test-reader / test-deep` |
| 3 服务端 | 座位与隐私、复式换座、与实验室逐手一致；**开盅的「谁喊 / 谁开」「够→开的人输」、结算后必再问到人** | `test-live-pvp.js`、`test-live-settle.js` |
| 4 传输通道 | 浏览器 SSE 与小程序长轮询共用同一份事件流、可见性过滤、断线补帧 | `smoke-live-http / test-mini-poll / test-mini-transport / smoke-mini-channel / test-miniprogram*` |
| 5 真浏览器 | 无头 Chrome 真点：新席位全流程；**提交开盅的 POST 回调不得抹掉服务端已推来的下一手按钮**（把响应延迟 250ms 做成必然时序）；手机视口另验布局四条（见下）| `ui-check.js`、`ui-round-cycle.js` |
| 6 上下文与排名 | 回声不入历史、复盘接线、指纹与 Elo 口径 | `test-echo-prune / test-reflect / test-ranking / smoke-chat / smoke-memory` |

其中 `test-live-settle.js` 与 `ui-round-cycle.js` 是为这轮修掉的三个 bug 专门补的：
开盅记录把「喊价的人」印成「开盅的人」、「够：喊的人输」把判负方向写反、
以及开盅之后出价按钮消失（只能干等到超时被自动接手）。两条在未修的代码上都能稳定跑失败，
所以改 `web/play.js` 的开盅渲染或提交回调后，第 5 组两个视口必须重跑。

### 手机模式（≤820px）

不是第二个前端：同一份 `web/play.html` + `play.js`，靠 CSS 断点和一处 DOM 安置分支换布局。
拆两份前端会把「同一口径」的测试拆成两份，不值得。断点数 `820` 在 `play.css` 的媒体查询和
`play.js` 的 `MQ_COMPACT` 里各写一次，**改必须同时改**，否则 JS 搬了 DOM 而样式没跟上。

四条硬规则，都在 `web/play.css` 末尾那段「手机模式」里：

1. **出价区吸底**。桌面上 `placeAction()` 把出价按钮搬进我方卡片；手机上反过来，把它留在
   `.actionbar` 里 `position:sticky; bottom:0`，并封顶 `max-height:46vh`（实测 390×844 下
   出价区 335px，占四成屏，再多就在层内滚，不能把牌桌整张顶掉）。
2. **单列顺序 我方 → 牌桌 → 对手**。窄屏下 `.table-center` 不再 `order:-1`；我坐乙方时由
   `.arena.me-b` 换算，观战保持原序。
3. **拇指与眼睛的下限**：可点元素 ≥44px 高、可见文字 ≥12px。原来一批说明文字是 10~11.5px，
   出价芯片 31px 高，手机上按不准也看不清。
4. **顶栏必须能换行**：`.top` 与嵌套的 `.topright` 都要 `flex-wrap:wrap`。只给外层换行不够 ——
   状态牌里一塞房号和长昵称，内层不换行就把「账号」整个挤出屏幕（实测内容 465px > 390px）。

按不动的档位要把原因写在按钮旁边（`.why`），不能只靠 `title`：微信内置浏览器没有 hover。
首喊 + 未斋时那三个档位全是灰的，之前就是撞在这上面。

验证与防漂：

```bash
WIN=390,844 node tests/ui-round-cycle.js    # [D] 段：溢出/裁切、字号、触控、吸底、换序
WIN=1400,1100 node tests/ui-round-cycle.js  # 桌面档：出价区仍在我方卡片里
BREAK="document.querySelector('.topright').style.flexWrap='nowrap'" WIN=390,844 node tests/ui-round-cycle.js
```

两个坑值得记着：

- 视口必须用 `Emulation.setDeviceMetricsOverride` 显式设。只传 `--window-size` 时 headless 里
  页面 `innerWidth` 其实只有 500，「桌面档」会一直在偷偷测手机档。所以测试里先断言
  「实测 innerWidth == 设定宽度」。
- 溢出判定要用 `documentElement.clientWidth`，别用 `innerWidth`：内容超宽时移动端布局视口会
  跟着胀，`innerWidth` 反而看不出问题。顶栏被裁掉就是这么漏掉的。
- `BREAK='<js>'` 用来故意打破一条适配规则，确认探针真的会报警 —— 探针不报警就是空跑。

停：`Ctrl-C`，或找到进程 `ss -ltnp 'sport = :8898'` 看 PID 再 `kill`。
数据都在 `DICE_DATA_DIR`（默认 `data/`，已 gitignore）；删掉就等于清空账号和战绩。
