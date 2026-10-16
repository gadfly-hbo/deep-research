#!/bin/sh
# 注入本机模型密钥到环境(不打印、不落仓)。来源统一为 ~/.pi/agent/auth.json:
#   MiniMax: [minimax-cn]
#   Xiaomi MIMO tokenplan: [xiaomi-token-plan-cn]
#   (2026-10-16:ZCode 已卸载,原 ~/.zcode/v2/config.json 密钥源随之移除,
#    该源在本机自始不存在,回退分支恒定命中 ~/.pi/agent/auth.json)
MM=$(python3 -c "import json,os;a=json.load(open(os.path.expanduser('~/.pi/agent/auth.json')));print(a.get('minimax-cn',{}).get('key',''))" 2>/dev/null)
[ -n "$MM" ] && export MINIMAX_API_KEY="$MM" && export MINIMAX_CN_API_KEY="$MM"
XM=$(python3 -c "import json,os;a=json.load(open(os.path.expanduser('~/.pi/agent/auth.json')));print(a.get('xiaomi-token-plan-cn',{}).get('key',''))" 2>/dev/null)
[ -n "$XM" ] && export XIAOMI_TOKEN_PLAN_CN_API_KEY="$XM"
exec "$@"
