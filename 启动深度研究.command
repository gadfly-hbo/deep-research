#!/bin/bash
# 一键启动深度研究工作台(双端通用:macmini / MacBook)
# 流程:起本机服务(密钥自动从本机凭据注入)→ 打开浏览器。
# 双机同步:研究数据随仓库走 git——变动端 git-commit-push 到 GitHub,另一端手动触发 git-pull-sync 拉取(拉取前先停本服务)。
set -e
cd "$(dirname "$0")"

echo "== 深度研究工作台 =="
if [ ! -d node_modules ]; then
  echo "[首次运行] 安装依赖…"
  npm install --no-audit --no-fund
fi
# 代码更新后自动重建:记录上次构建对应的代码提交(只看影响构建的路径,数据同步提交不触发);
# 标记文件放 ui-dist/(已 gitignore),机器各自维护
BUILD_HEAD="$(git log -1 --format=%H -- src ui package.json package-lock.json vite.config.ts tsconfig.json ui/tsconfig.json 2>/dev/null || echo none)"
if [ ! -f ui-dist/index.html ] || [ "$(cat ui-dist/.build-head 2>/dev/null)" != "$BUILD_HEAD" ]; then
  echo "[构建] 代码有更新,重建工作台界面…"
  npm run build
  echo "$BUILD_HEAD" > ui-dist/.build-head
fi

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
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
