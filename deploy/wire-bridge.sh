#!/usr/bin/env bash
# 把「家里的模型」通过 llm-relay 的桥接到云上的实时对战平台。
# 只做三件事：取钥匙 → 问模型 id → 写云端 presets.json 并重启平台进程。全程不打印钥匙。
#
# 用法： bash deploy/wire-bridge.sh                # 用 dice-live 这把钥匙
#         RELAY_KEY=dice-live DEST=py-server DIR=dice-live bash deploy/wire-bridge.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${DEST:-py-server}; DIR=${DIR:-dice-live}; KEYNAME=${RELAY_KEY:-dice-live}
RELAY_DIR=${RELAY_DIR:-"$HOME/work/llm-relay"}
REMOTE_PORT=${REMOTE_PORT:-18444}          # 云机 loopback 入口（llm-relay 的 ssh -R 落点）

[ -d "$RELAY_DIR" ] || { echo "找不到 $RELAY_DIR"; exit 1; }
KEY=$(grep -A1 "^name=${KEYNAME}$" "$RELAY_DIR/out/friend-keys.txt" | tail -1 | cut -d= -f2-)
[ -n "$KEY" ] || { echo "钥匙 ${KEYNAME} 不在 out/friend-keys.txt 里，先跑：cd $RELAY_DIR && ./relayctl.sh genkey ${KEYNAME}"; exit 1; }

# 模型 id 以 /v1/models 为准：web-llama 换/卸载 profile 时 id 会变
MODEL=$(printf '%s' "$KEY" | ssh "$DEST" "read -r K; curl -s -m 25 http://127.0.0.1:${REMOTE_PORT}/v1/models -H \"Authorization: Bearer \$K\"" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["data"][0]["id"])')
[ -n "$MODEL" ] || { echo "经隧道问 /v1/models 失败：桥可能没起（$RELAY_DIR/relayctl.sh status）"; exit 1; }
echo "桥通了，家里现在挂着：${MODEL}"

TMP=$(mktemp -t dice-presets.XXXXXX); chmod 600 "$TMP"
python3 - "$KEY" "$MODEL" "$REMOTE_PORT" > "$TMP" <<'PY'
import json, sys
key, model, port = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
  "presets": [{
    "id": "home-llm", "alias": "家里模型 · 走隧道", "base": "http://127.0.0.1:%s/v1" % port,
    "model": model, "apiKey": key, "effort": "medium", "maxTokens": 4096,
  }],
  "settings": {"rules": "flex"}, "seat": {"A": "home-llm", "B": ""},
}, ensure_ascii=False, indent=2))
PY
ssh "$DEST" "cat > ~/$DIR/presets.json && chmod 600 ~/$DIR/presets.json" < "$TMP"
rm -f "$TMP"
echo "已写 ~/$DIR/presets.json（钥匙只落在这台云机的文件里，权限 600）"

# 重启平台进程（没上 systemd 时：杀掉旧的、带 DICE_LOCAL_PORTS 重起）
ssh "$DEST" "pkill -f 'room-server.js' 2>/dev/null; sleep 1; cd ~/$DIR && HOST=127.0.0.1 PORT=18898 DICE_DATA_DIR=\$HOME/$DIR/data DICE_LOCAL_PORTS=${REMOTE_PORT} setsid nohup node src/room-server.js > serve.log 2>&1 </dev/null & sleep 2; tail -3 ~/$DIR/serve.log"
cat <<EOS

已接好。要点：
  · 云机 loopback ${REMOTE_PORT} ← ssh -R 隧道 ← 你家 18999 网关 ← web-llama 1235
  · 平台只放行这一个端口：DICE_LOCAL_PORTS=${REMOTE_PORT}（上了 systemd 的话写在 unit 里）
  · relay 的硬限制：max_tokens ≤ 4096（不写自动 1024）、全局并发 2、每人约 1 req/s
  · web-llama 换 profile 后模型 id 会变，重跑这条脚本即可刷新
  · 桥断了（家里关机 / ssh 掉线）时，云上选「家里模型」那一座会报错，改用「内置人机」照样能打
EOS
