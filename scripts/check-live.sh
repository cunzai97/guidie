#!/usr/bin/env bash
# 实时对战（PVP）回归总表 —— 每组只为一件事，跑完给结论，不堆无意义的重复测试。
#
#   bash scripts/check-live.sh              # 全自动：自己起临时服务（限流放宽），跑完关掉
#   BASE=http://127.0.0.1:8898 bash scripts/check-live.sh    # 对着你正在跑的那台验（不新建服务）
#
# 全部零 token：模型座位一律不真调端点（要验真模型链路用 tests/bridge-check.js，会花钱）。
set -u
cd "$(dirname "$0")/.."
PASS=0; FAIL=0; FAILED=()
OWN=0
group() { printf '\n\033[1m— %s\033[0m\n' "$1"; }
run() { # run <名字> <命令...>
  local name="$1"; shift
  local out; out="$("$@" 2>&1)"; local rc=$?
  if [ $rc -eq 0 ]; then PASS=$((PASS+1)); printf '  ✓ %s\n' "$name"
  else FAIL=$((FAIL+1)); FAILED+=("$name"); printf '  ✗ %s\n' "$name"
    printf '%s\n' "$out" | grep -E "✗|FAIL|Error|error" | head -6 | sed 's/^/      /'
  fi
}
if [ -z "${BASE:-}" ]; then
  OWN=1
  PORT=${PORT:-$((18800 + RANDOM % 150))}
  DIR=$(mktemp -d /tmp/dice-checklive-XXXXXX)
  DICE_BOT_DELAY_MS=${DICE_BOT_DELAY_MS:-260} DICE_RATE_CREATE=400 DICE_RATE_SIGNUP=400 DICE_RATE_LOGIN=400 \
    PORT=$PORT HOST=127.0.0.1 DICE_DATA_DIR=$DIR node src/room-server.js >$DIR/serve.log 2>&1 &
  SRV=$!
  export BASE=http://127.0.0.1:$PORT
  for i in $(seq 1 100); do curl -sf $BASE/api/ping >/dev/null 2>&1 && break; sleep 0.15; done
  echo "临时服务：$BASE（限流放宽、人机思考 $((${DICE_BOT_DELAY_MS:-260}))ms，退出时自动关）"
  trap 'kill $SRV 2>/dev/null; rm -rf $DIR' EXIT
fi

group "组 1 · 规则口径（实时对战与跑批共用同一份引擎，漂了就全错）"
run "规则引擎与规则集"            node tests/test-rules.js

group "组 2 · 内置人机（免费陪练与冒烟对手，必须合法且真会打）"
run "人机落子全部合法"             node tests/test-bots-legal.js
run "oracle 期望最大化"            node tests/test-oracle.js
run "reader 贝叶斯读牌"            node tests/test-reader.js
run "deep 双向读牌 + 终盘"         node tests/test-deep.js

group "组 3 · 实时对战服务端（座位、隐私、复式、与实验室逐手一致）"
run "座位/视角隐私/复式/parity"    node tests/test-live-pvp.js
run "开盅归属·判负方向·结算后必再问到人"   node tests/test-live-settle.js

group "组 4 · 传输通道（浏览器 SSE 与小程序长轮询共用同一份事件流）"
run "HTTP + SSE 全链"              node tests/smoke-live-http.js
run "小程序长轮询通道"             node tests/test-mini-poll.js
run "小程序传输层与报错文案"       node tests/test-mini-transport.js
run "小程序通道端到端冒烟"         node tests/smoke-mini-channel.js
run "小程序视图与页面"             node tests/test-miniprogram-view.js
run "小程序工程自检"               node tests/test-miniprogram.js

group "组 5 · 真浏览器前端（无头 Chrome 真点，不看后端不看代码）"
run "玩家页全流程（新席位模型）"   env BASE=$BASE node tests/ui-check.js
run "轮次与开盅 · 桌面 1400×1100"  env WIN=1400,1100 RACE_MS=250 ROUNDS=5 node tests/ui-round-cycle.js
run "轮次与开盅 · 手机 390×844"    env WIN=390,844 RACE_MS=250 ROUNDS=5 node tests/ui-round-cycle.js

group "组 6 · 上下文与排名（评测口径的地基，不能悄悄漂）"
run "回声退化不入历史"             node tests/test-echo-prune.js
run "复盘/反思接线"                node tests/test-reflect.js
run "排名指纹与 Elo 口径"          node tests/test-ranking.js
run "对话模式与记忆链（桩模型）"   node tests/smoke-chat.js
run "摘要链记忆（桩模型）"         node tests/smoke-memory.js

printf '\n\033[1m总结：%d 组用例通过，%d 项失败\033[0m\n' "$PASS" "$FAIL"
[ $FAIL -eq 0 ] || { printf '失败项：%s\n' "${FAILED[@]}"; exit 1; }
