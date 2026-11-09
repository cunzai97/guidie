#!/usr/bin/env bash
# 鬼骰 · 一键启动：依赖检查 → 起服务（静态页 + 同源代理 + 预设 API）→ 就绪检查
# 用法:
#   bash start.sh             默认端口 8899，启动后打印地址
#   bash start.sh --open      启动后自动打开浏览器
#   PORT=9000 bash start.sh   换端口
#   PYTHON=python3.11 bash start.sh   指定解释器（某些环境默认 python3 是受限运行时）
set -e
D=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$D"
PORT=${PORT:-8899}
PY=${PYTHON:-python3}
OPEN=0
for a in "$@"; do [ "$a" = "--open" ] && OPEN=1; done

# ---- 依赖检查 ----
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "找不到 $PY。请安装 Python 3.8+，或用 PYTHON=... 指定解释器。"; exit 1
fi
if ! "$PY" -c 'import http.server, urllib.request, json' >/dev/null 2>&1; then
  echo "$PY 无法导入标准库（可能是受限运行时）。试试 PYTHON=/usr/bin/python3 bash start.sh"; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "提示：未检测到 node。观战不受影响；无头评测（src/pk.js）与规则回归（tests/test-rules.js）需要 Node 18+。"
fi

mkdir -p runs

# ---- 端口占用：只重启本项目的服务；别的程序占着就让用户换端口，不误杀 ----
PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$PID" ]; then
  if tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q 'serve-dice.py'; then
    echo "重启已在跑的竞技场服务（pid=$PID）…"
    kill "$PID"; sleep 1
  else
    echo "端口 $PORT 被其它进程占用（pid=$PID）。请换端口：PORT=9000 bash start.sh"; exit 1
  fi
fi

# ---- 起服务并等就绪 ----
nohup "$PY" serve-dice.py "$PORT" > runs/serve.log 2>&1 &
URL="http://127.0.0.1:$PORT/web/arena.html"
for i in $(seq 1 30); do
  sleep 0.5
  if curl -s -o /dev/null -m 2 "$URL" && curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/api/presets"; then
    echo "竞技场就绪: $URL"
    echo "  配置模型: 页面右上角「模型设置」（预设写入 presets.json，不入库）"
    echo "  日志: runs/serve.log · 模型调用流水: runs/calls.jsonl"
    echo "  规则自检: node tests/test-rules.js"
    echo "  无头评测: node src/pk.js --p0 threshold --p1 random --deals 6 --out runs/bot.jsonl"
    if [ "$OPEN" = 1 ] && command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL" >/dev/null 2>&1 || true
    fi
    exit 0
  fi
done
echo "起不来，看 runs/serve.log"; exit 1