# 鬼骰 · 服务端容器（微信云托管 / 任意 Docker 主机都能用）
#
# 云托管要点：
#   - 必须监听 80 端口（平台把公网/内网流量转到 80）
#   - 不支持持久化存储：data/ 里的账号与战绩在重启/扩缩容后会被还原
#     真要留战绩，把 DICE_DATA_DIR 指到挂载盘，或后续接对象存储
#   - 最小副本设 1：对局房间在内存里，缩容到 0 会清空正在打的桌
FROM node:20-alpine

WORKDIR /app

# 零运行时依赖，只拷代码，镜像很小
COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80 \
    DICE_DATA_DIR=/app/data

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/ping >/dev/null 2>&1 || exit 1

CMD ["node", "src/room-server.js"]
