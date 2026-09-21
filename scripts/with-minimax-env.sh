#!/bin/sh
# 注入本机模型密钥到环境(不打印、不落仓)。来源:
#   MiniMax: ~/.pi/agent/auth.json [minimax-cn]
#   Xiaomi MIMO tokenplan: ~/.zcode/v2/config.json (baseURL 含 xiaomimimo 的 provider)
MM=$(python3 -c "import json,os;a=json.load(open(os.path.expanduser('~/.pi/agent/auth.json')));print(a.get('minimax-cn',{}).get('key',''))" 2>/dev/null)
[ -n "$MM" ] && export MINIMAX_API_KEY="$MM" && export MINIMAX_CN_API_KEY="$MM"
XM=$(python3 - <<'PY' 2>/dev/null
import json,os
cfg=json.load(open(os.path.expanduser('~/.zcode/v2/config.json')))
for p in (cfg.get('provider') or {}).values():
    opts=p.get('options') or {}
    if 'xiaomimimo' in str(opts.get('baseURL','')):
        print(opts.get('apiKey','')); break
PY
)
[ -n "$XM" ] && export XIAOMI_TOKEN_PLAN_CN_API_KEY="$XM"
exec "$@"
