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
**朋友不是体验成员，打不开你的开发版** —— 想给朋友玩，必须走到第三节。

---

## 三、上线（这一步的门槛是资质，不是代码）

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

## 四、小程序端做对了什么

- **分享即入座**：`onShareAppMessage` 把房号写进 `path`，朋友点卡片 → `onLoad` 发现没有座位令牌 → 自动 join → 坐下或观战。不用输房号、不用扫码。
- **断线可续**：轮询有 `cursor`，页面 `onHide` 停、`onShow` 续，重连不丢事件、不重复渲染。
- **隐私口径没变**：对手骰子、别人的 Key、别人的秘诀永远不下发到手机；开盅后才从 `open` 事件里拿到真值。
- **动作由服务端授权**：个数/点数/斋/破斋/劈 的候选全部来自 `view.legal`，界面只是把允许的选项画出来。

## 五、自检

```bash
node tests/test-miniprogram.js        # 静态：页面四件套、事件绑定、require、vendor 漂移、HTML 标签
node tests/test-miniprogram-view.js   # 渲染：骰子/文案/选择器/亮牌/结算，48 项
node tests/smoke-mini-channel.js      # 通道：把 realtime.js 搬进 Node 打完整一把
node tests/test-mini-poll.js          # 协议：长轮询、可见性、令牌、在线心跳
node scripts/sync-vendor.js --check   # 小程序里的引擎副本是否落后
```

改了 `src/` 的规则或引擎后，**一定要**跑一次 `node scripts/sync-vendor.js`，否则小程序按老规则画按钮、服务端按新规则判——这类问题在真机上只表现为「按钮点了没反应」。

## 六、常见故障

| 现象 | 原因 |
|---|---|
| 一直「连不上服务器」 | 电脑没起服务 / 地址写成 127.0.0.1 / 没勾「不校验合法域名」 |
| 模拟器好、真机不行 | 真机没开「开发调试」；或用了 `localhost` |
| 请求偶尔失败、重连频繁 | 长轮询 25s + 客户端超时 32s；反代 `proxy_read_timeout` 太短 |
| 点了「走这一步」没反应 | `view.legal` 里没有这个组合（界面的兜底逻辑会纠正，但服务端仍会拒），看返回的 `error` |
| 朋友点分享卡片进不来 | 他打开的是**体验版/开发版**但没有体验权限；正式发布后不存在这个问题 |
| 首页显示「服务器没配 AppID」 | 正常，`DICE_WX_APPID/SECRET` 没设，走匿名；不影响对战 |
