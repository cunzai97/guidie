#!/usr/bin/env bash
# 大话骰竞技场：静态页 + 同源代理（/oa/ 由页面 X-Base 指定任意端点）+ 模型预设 API
set -e
PORT=${PORT:-8899}
# 项目根目录：默认取脚本所在目录，也可用 D=... 覆盖
D=${D:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
PID=$(ss -ltnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && { kill "$PID"; sleep 1; }
cd "$D"
# PYTHON 可覆盖解释器：某些环境里默认 python3 指向受限运行时，导入标准库会失败
PY=${PYTHON:-python3}
nohup "$PY" serve-dice.py "$PORT" > /tmp/dice-serve.log 2>&1 &
for i in $(seq 1 20); do
  sleep 0.5
  curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/arena.html" && { echo "竞技场: http://127.0.0.1:$PORT/arena.html"; exit 0; }
done
echo "起不来，看 /tmp/dice-serve.log"; exit 1
