#!/usr/bin/env bash
# 实时对战平台 —— 真人 / 模型 / 内置人机任意两席混打，同一份规则与血量口径。
#
# 用法：
#   bash live.sh                                  # 默认 http://127.0.0.1:8898/web/play.html
#   PORT=9000 bash live.sh                        # 换端口
#   DICE_LOCAL_PORTS=8790,8791 bash live.sh       # 放行自家模型网关（只有本机需要）
#
# 挂到公网：HOST=0.0.0.0 且务必套 nginx/HTTPS；
#   DICE_ALLOW_HOSTS=api.example.com  只允许白名单端点出网
#   DICE_LOCAL_PORTS 留空             默认拒绝一切本机/内网/云元数据地址（SSRF 防线）
#   DICE_WB_KEY=...                   平台预设走 WorkBuddy 网关时注入的密钥（不写进 presets.json）
set -euo pipefail
cd "$(dirname "$0")"
: "${PORT:=8898}"
: "${HOST:=127.0.0.1}"
: "${DICE_DATA_DIR:=data}"
export PORT HOST DICE_DATA_DIR
mkdir -p "$DICE_DATA_DIR"
echo "浏览器打开 http://${HOST}:${PORT}/web/play.html"
echo "数据目录 ${DICE_DATA_DIR}/（账号密文盒 + 战绩 + 调用流水，已在 .gitignore 里）"
exec node src/room-server.js
