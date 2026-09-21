#!/bin/bash
# 一键启动深度研究工作台(双端通用:macmini / MacBook)
# 流程:同步研究数据 → 起本机服务(密钥自动从本机凭据注入)→ 打开浏览器;退出时回推数据。
set -e
cd "$(dirname "$0")"

echo "== 深度研究工作台 =="
if [ ! -d node_modules ]; then
  echo "[首次运行] 安装依赖…"
  npm install --no-audit --no-fund
fi
if [ ! -f ui-dist/index.html ]; then
  echo "[首次运行] 构建工作台界面…"
  npm run build
fi

echo "[同步] 拉取双端研究数据…"
npm run research --silent -- data-sync || echo "[同步] 跳过(无变更或无网络)"

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  echo ""
  echo "[同步] 回推本机研究数据…"
  npm run research --silent -- data-sync || echo "[同步] 回推跳过"
}
trap cleanup EXIT

echo "[启动] 本机服务 http://127.0.0.1:4173 (Ctrl+C 退出)"
scripts/with-minimax-env.sh npm run research -- serve --port 4173 &
SERVER_PID=$!

for i in $(seq 1 40); do
  if curl -s -o /dev/null http://127.0.0.1:4173/api/projects; then break; fi
  sleep 1
done
open http://127.0.0.1:4173

wait "$SERVER_PID"
