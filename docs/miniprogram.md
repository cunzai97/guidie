# 微信小程序 · 怎么做、怎么上线

一句话：**服务端一行没重写，小程序是给同一桌牌换了个壳。**
权威对局、规则、血量、结算仍在 `src/rooms.js`；小程序只多了两条通道——长轮询拿事件、微信登录换 openid。

目录：`miniprogram/`（小程序包）+ `src/room-server.js`（同一台服务器）。

---

## 一、为什么不是「web-view 套壳」

官方文档写得很清楚：`web-view` **个人类型的小程序暂不支持**，个人主体后台连「业务域名」的配置入口都没有。
所以对你（个人主体）来说，唯一可行的路是原生小程序：WXML/WXSS 重写界面，逻辑复用。

复用的是这四个文件（`miniprogram/vendor/`，由 `scripts/sync-vendor.js` 从 `src/` 复制）：

| 文件 | 复用什么 |
|---|---|
| `dice-engine.js` | 合法动作集、点数比较、斋/破斋/劈的判定 |
| `dice-rulesets.js` | 规则集参数、规则文本 |
| `dice-rules.js` | 行动文本解析 |
| `view.js` | 座位视角投影（哪些能给人看） |

**界面上一颗按钮能不能点，仍然由服务端的 `view.legal` 决定**，小程序不自作主张。

---

## 二、本地跑通（不需要备案域名，20 分钟）

### 1. 起服务，让手机能连

```bash
# 电脑上（和手机连同一个 WiFi）
HOST=0.0.0.0 PORT=8898 bash live.sh
hostname -I          # 记下内网地址，比如 192.168.8.119
```

### 2. 改小程序里的地址

`miniprogram/config.js` → `ENV.dev` 改成 `http://192.168.8.119:8898`。
（也可以不改：进小程序「我的 → 服务器」直接填，存本机、立即生效。）

> 不能写 `127.0.0.1` —— 手机上那个 127 是手机自己。

### 3. 用微信开发者工具打开

- 导入目录选 `miniprogram/`（不是仓库根目录）
- AppID：没有就选「测试号」，或先选「无 AppID」（`project.config.json` 里已写 `touristappid`）
- 详情 → 本地设置 → 勾上 **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**

此时模拟器里就能开桌、跟内置人机打完一把。

### 4. 真机

- 点「预览」，手机扫码打开
- 打开后右上角菜单 → **开发调试 → 打开调试**（这个开关不打开，真机会因为域名不合法直接请求失败）
- 基础库 2.4.0 起允许访问**局域网 IP**，但**不允许本机 IP**，所以必须是电脑的内网地址

**注意**：这一套只有你和被加为「体验成员」的人能跑。
**朋友不是体验成员，打不开你的开发版** —— 想给朋友玩，看第三节。

---

## 三、不备案怎么玩（只是玩玩看这节）

先把两件事分开，很多攻略把它们混在一起，才显得「必须备案」：

| 两件事 | 谁要求 | 体验版要不要 |
|---|---|---|
| **小程序本身备案** | 微信（2023-09-04 起，未备案不能上架） | **不要**。官方社区口径：未备案不影响开发版/体验版 |
| **服务器域名备案** | 微信校验 `request` 合法域名时要求 HTTPS + ICP 备案 | 看走哪条路，下面三条里有两条不需要 |

所以「只是玩玩」确实有不备案的走法，代价各不相同。

### 路线 A：体验版 + 打开调试（0 成本，今天就能玩）

> 适合：就想让几个朋友陪你打几把，不介意每人第一次多点两下。

原理：开发版/体验版允许打开**调试模式**，此时微信不校验 `request` 合法域名，
于是可以直接请求 `http://公网IP:8898` —— 没有域名，自然也没有备案。

1. **注册个人小程序**（mp.weixin.qq.com，身份证 + 人脸，免费），拿到 AppID。
   **不用提交备案**，也不用配服务器域名。
2. 服务器上把服务跑起来，对外可访问：

   ```bash
   HOST=0.0.0.0 PORT=8898 bash live.sh
   # 云服务器安全组放行 8898；或者前面挂 nginx 反代到 80
   ```

3. 本地改 `miniprogram/config.js` 的 `ENV.dev` 为 `http://你的公网IP:8898`
   （或者发版后在「我的 → 服务器」里填，更省事）。
4. 开发者工具「上传」→ 小程序后台「版本管理」→ 把开发版设为**体验版**。
5. 后台「成员管理 → 体验成员」把朋友的微信号加进来（有名额上限，个人主体通常十几人）。
6. 朋友打开体验版 → 右上角 **···** → **开发调试** → **打开调试** → 重进小程序。

之后他就能正常开桌、喊价、开盅了，**打开调试是一次性的**。

要注意的三点：

- 你的服务器得一直开着，人不在就掉线；
- 每人第一次都要手动开调试，微信会同时弹出 vConsole 面板；
- 体验成员名额有限，人多了加不进去。

### 路线 B：云托管内网通道（免域名、免备案，朋友什么都不用设置）

> 适合：想让朋友点分享卡片就进桌，不想教任何人「打开调试」。

微信云托管有个 `wx.cloud.callContainer`：小程序直接调**云环境里的容器**，
请求走微信内网，不经过公网域名。所以：

- 不用买域名，不用备案；
- 不用在小程序后台配 `request` 合法域名；
- 代码已经在 `miniprogram/utils/api.js` 里实现了，把 `config.js` 改成：

  ```js
  const TRANSPORT = 'cloud'
  const CLOUD = { env: 'prod-3gxxxxx', service: 'guidie' }
  ```

部署只需要三步：

```bash
# 1. 构建（Dockerfile 已备好，监听 80，健康检查 /api/ping）
docker build -t guidie .

# 2. 微信云托管控制台 → 新建服务 → 上传代码包 / 关联 Git 仓库
#    端口填 80；「实例副本数」最小设 1

# 3. 云环境 ID 与服务名填回 config.js 的 CLOUD，上传体验版
```

必须知道的两个限制（官方硬约束，不是这套代码的问题）：

| 限制 | 影响 | 这里怎么处理 |
|---|---|---|
| `callContainer` 客户端超时 **≤ 15s** | 长轮询不能挂 25s | 已按传输自动收紧：cloud 模式挂 10s、超时 14s（`realtime.js` 里动态取） |
| 容器内存在**缩容到 0** 时清空 | 正在打的房间会消失 | 把「最小副本」设为 1（持续计费）；或接受「开局前冷启动几十秒」 |

另外容器**不支持持久化存储**：`data/` 里的账号密文盒与战绩在重启后会被还原。
只是玩玩无所谓；要留战绩就把 `DICE_DATA_DIR` 指到挂载盘。

还有一条容易忽略的：云托管的 HTTP 网关不适合长连接，`callContainer` 也拿不到流式响应。
所以**云托管这套只服务小程序**（小程序走长轮询，本来就短请求）；
浏览器版 `web/play.html` 的 SSE 要么还用你自己的服务器，要么在云托管上也退回轮询——
真要两边都跑，就把云托管当作小程序的专用后端，浏览器版继续用独立部署。

### 路线 C：借一个已备案的域名

微信只校验「域名是否备案 + 是否 HTTPS」，**不要求备案主体和小程序主体一致**。
所以朋友（或你自己已有的）任何已备案主域名，开个二级域名 `dice.xxx.com` 解析到你的服务器、
挂个免费证书，配进 `request` 合法域名，就能走完全正规的 `wx.request`，
朋友也不用开调试。

> 注意：二级域名继承主域名的备案，但**不同主体**的子域名不能随便挂；用之前确认备案主体允许。

### 三条路对照

| | 备案 | 花钱 | 朋友要做什么 | 你的机器要开着 | 稳定性 |
|---|---|---|---|---|---|
| A 体验版 + 调试 | 不要 | 0 | 加体验成员 + 首次开调试 | 是 | 一般（每人手动） |
| B 云托管内网 | 不要 | 云托管按量（最小副本 1 才稳） | 点卡片进 | 否 | 好 |
| C 借备案域名 | 借 | 0～域名费 | 点卡片进 | 是 | 好 |
| 正式上线 | 要（域名 + 小程序） | 域名几十/年 | 点卡片进 | 否 | 最好 |

**如果连小程序都不想做**：现在的浏览器版直接发链接也能在微信里打开
（`http://IP:8898/web/play.html`），只是不能「点卡片进桌」，要复制链接。

---

## 四、正式上线（这一步的门槛是资质，不是代码）

### 1. 你需要准备

| 事项 | 说明 | 大致耗时 |
|---|---|---|
| 小程序 AppID | 个人主体可注册；「服务类目」选工具/娱乐类 | 1 天（审核） |
| 域名 + ICP 备案 | 个人可备案；域名要实名，服务器通常要求同一云厂商 | 1～3 周，看省份 |
| HTTPS 证书 | 免费证书够用（Let's Encrypt / 云厂商免费证书） | 半天 |
| 云服务器 | 1 核 1G 能跑；Node 18+ | 已有 |

### 2. 服务器上跑起来

```bash
# /srv/guidie 放代码
cd /srv/guidie
DICE_DATA_DIR=/srv/guidie/data HOST=127.0.0.1 PORT=8898 node src/room-server.js
```

systemd（开机自启、挂了自动拉起）：

```ini
[Unit]
Description=guidie live server
After=network.target

[Service]
WorkingDirectory=/srv/guidie
ExecStart=/usr/bin/node src/room-server.js
Environment=HOST=127.0.0.1
Environment=PORT=8898
Environment=DICE_DATA_DIR=/srv/guidie/data
Environment=DICE_ALLOW_HOSTS=api.openai.com,api.deepseek.com
Restart=always

[Install]
WantedBy=multi-user.target
```

### 3. nginx 反代（HTTPS）

```nginx
server {
    listen 443 ssl http2;
    server_name dice.example.com;

    ssl_certificate     /etc/letsencrypt/live/dice.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dice.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8898;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;      # 长轮询必须关，否则事件会被 buffer 住
        proxy_read_timeout 120s;  # 要比 25s 的挂起时间长
    }
}
```

### 4. 小程序后台配域名

「开发管理 → 开发设置 → 服务器域名」：

- **request 合法域名**：`https://dice.example.com`
- 规则：只支持 https；**不能填 IP**；**不能用父域名**；不填端口就**不能带端口**（填了 `:443` 也会失败）；每月最多改 50 次

### 5. 微信登录（可选，但建议）

```bash
DICE_WX_APPID=wx******** DICE_WX_SECRET=********  # 放在服务器环境变量里，别写进仓库
```

配了之后小程序启动会 `wx.login` → 服务端换 openid → 建账号。
好处：模型配置和战绩跟着微信走，换手机还在。
没配也能玩：匿名 + 座位令牌，模型 Key 只存在这台手机（明文，界面里有如实提示）。

### 6. 联调顺序（别一上来就发布）

1. 手机浏览器先打开 `https://dice.example.com/web/play.html`，确认反代通、证书对
2. 开发者工具把 `config.js` 的 `ENV` 改成 `'prod'`（或用「我的 → 服务器」填 https 地址）
3. 关掉「不校验合法域名」，重新编译 —— 这一步能过，真机就没问题
4. 传体验版 → 自己打一局 → 加两三个朋友当体验成员试
5. 提交审核（个人主体一般选「工具」类，审核会看功能是否完整、有没有诱导分享）

---

## 五、小程序端做对了什么

- **分享即入座**：`onShareAppMessage` 把房号写进 `path`，朋友点卡片 → `onLoad` 发现没有座位令牌 → 自动 join → 坐下或观战。不用输房号、不用扫码。
- **断线可续**：轮询有 `cursor`，页面 `onHide` 停、`onShow` 续，重连不丢事件、不重复渲染。
- **隐私口径没变**：对手骰子、别人的 Key、别人的秘诀永远不下发到手机；开盅后才从 `open` 事件里拿到真值。
- **动作由服务端授权**：个数/点数/斋/破斋/劈 的候选全部来自 `view.legal`，界面只是把允许的选项画出来。

## 六、自检

```bash
node tests/test-miniprogram.js        # 静态：页面四件套、事件绑定、require、vendor 漂移、HTML 标签
node tests/test-miniprogram-view.js   # 渲染：骰子/文案/选择器/亮牌/结算，48 项
node tests/smoke-mini-channel.js      # 通道：把 realtime.js 搬进 Node 打完整一把
node tests/test-mini-poll.js          # 协议：长轮询、可见性、令牌、在线心跳
node tests/test-mini-transport.js     # 传输：直连 / 云托管内网两条路的请求形状与报错口径
node scripts/sync-vendor.js --check   # 小程序里的引擎副本是否落后
```

改了 `src/` 的规则或引擎后，**一定要**跑一次 `node scripts/sync-vendor.js`，否则小程序按老规则画按钮、服务端按新规则判——这类问题在真机上只表现为「按钮点了没反应」。

## 七、常见故障

| 现象 | 原因 |
|---|---|
| 一直「连不上服务器」 | 电脑没起服务 / 地址写成 127.0.0.1 / 没勾「不校验合法域名」 |
| 模拟器好、真机不行 | 真机没开「开发调试」；或用了 `localhost` |
| 请求偶尔失败、重连频繁 | 长轮询 25s + 客户端超时 32s；反代 `proxy_read_timeout` 太短 |
| 点了「走这一步」没反应 | `view.legal` 里没有这个组合（界面的兜底逻辑会纠正，但服务端仍会拒），看返回的 `error` |
| 朋友点分享卡片进不来 | 他打开的是**体验版/开发版**但没有体验权限；正式发布后不存在这个问题 |
| 首页显示「服务器没配 AppID」 | 正常，`DICE_WX_APPID/SECRET` 没设，走匿名；不影响对战 |
