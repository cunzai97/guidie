#!/usr/bin/env bash
# 把实时对战平台推到云服务器上（只传代码，不传你的 Key / 数据 / 跑批产物）。
# 用法：  bash deploy/deploy-live.sh            # 默认推到 ssh 配置里的 py-server:~/dice-live
#         HOST=other-server bash deploy/deploy-live.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${DEST:-py-server}
DIR=${DIR:-dice-live}

rsync -av --delete \
  --exclude 'data/' --exclude 'runs/' --exclude 'node_modules/' --exclude 'presets.json' \
  --exclude 'presets.json.bak*' --exclude '.git/' --exclude '*.log' --exclude '*.jsonl' \
  --exclude 'web/arena.js' --exclude 'web/arena.html' --exclude 'web/arena.css' \
  src web tests live.sh README.md "$DEST:~/$DIR/"

# 云上没 presets.json 时，平台预设列表就是空的 —— 朋友只能用内置人机 / 自己带 Key，
# 你本机 8790/8791 那种网关地址在云上根本到不了，别把它传上去。
ssh "$DEST" "test -f ~/$DIR/presets.json || printf '{\"presets\":[],\"settings\":{},\"seat\":{}}\n' > ~/$DIR/presets.json"

cat <<EOS

代码已推到 ${DEST}:~/${DIR}。剩下三步要你自己在云上执行（要 root）：

  1) 起服务
     sudo cp deploy/dice-live.service /etc/systemd/system/
     sudo systemctl daemon-reload && sudo systemctl enable --now dice-live
     journalctl -u dice-live -n 20

  2) 挂 nginx（SSE 必须 proxy_buffering off）
     sudo cp deploy/nginx-dice-live.conf /etc/nginx/sites-available/dice-live
     sudo ln -s /etc/nginx/sites-available/dice-live /etc/nginx/sites-enabled/
     sudo nginx -t && sudo systemctl reload nginx

  3) 腾讯云控制台 → 安全组：放行 TCP 8443（入方向）

然后朋友打开：  https://101.34.71.12:8443/web/play.html
EOS
