# 独立深度研究工作台(第一期)

用证据看清复杂问题,让研究真正可用。可独立运行的专业研究工作台:浏览器界面 + 本机服务,单用户、独立启动、不依赖 JuanerAI。第一期交付品牌研究与行业研究两个模块,共享同一套通用研究核心。

**原则:执行完成 ≠ 证据充分。** 资料不足或预算到达上限时,系统产出"有限交付"并披露限制,不编造完整答案。

## 快速开始

```bash
npm install
npm test            # 单元/集成测试(vitest,适配器为录制夹具,无需密钥)
npm run build       # tsc + vite 构建 SPA 到 ui-dist/
```

**一键启动**:双击仓库根的 `启动深度研究.command`(自动同步数据 → 起本机服务 → 打开浏览器;Ctrl+C 退出时自动回推数据)。首次运行会自动安装依赖并构建。

或手动:`npm run research -- serve`,打开 http://127.0.0.1:4173 → 新建项目(品牌/行业)→ 生成并确认研究计划 → 运行 → 证据抽屉核查 → 发布版本 → 导出成果包(zip:report.md / report.html / evidence/ / manifest.json)。

## 配置(live 运行需要)

**研究数据双机共享**:数据目录默认为仓库内 `research-data/`(env `DEEP_RESEARCH_DATA_DIR` 可覆盖),随 git 同步——run 结束后服务端自动 commit+pull+push;也可手动 `npm run research -- data-sync`(冲突时保留本机并提示人工处理)。历史数据已从 `~/.deep-research/` 迁入(旧目录保留为备份)。`<datadir>/config.json`(0600 权限):

```json
{
  "model": [
    { "provider": "minimax-cn", "modelId": "MiniMax-M2.7" },
    { "provider": "xiaomi-token-plan-cn", "modelId": "mimo-v2.5-pro", "api": "openai-completions", "baseUrl": "https://token-plan-cn.xiaomimimo.com/v1" }
  ],
  "search": [ { "type": "minimax-mcp" }, { "type": "xiaomi-websearch" } ]
}
```

- **模型主备链路**(用户决策:MiniMax 主用,Xiaomi MIMO 备用):按数组顺序尝试,配额/限流/缺密钥类错误自动切下一个;其余错误直接抛出。只接这两家,不接其他。
- **搜索主备链路**(MiniMax MCP 主,Xiaomi MIMO 服务端 web_search 备,配额/限流自动切换):
  - `minimax-mcp`:MiniMax MCP `web_search`(`minimax-coding-plan-mcp`,stdio NDJSON),与 flow-center 商圈研究工作流同款;
  - `xiaomi-websearch`:MIMO token plan 服务端联网检索(`tools:[{"type":"web_search"}]`,结果在 `message.annotations` 的 `url_citation`;实测 2026-09-21 可用);
  - 也支持通用 HTTP 搜索端点(填 `endpoint/urlField/titleField/snippetField`)。
- **密钥只走环境变量,不进配置文件/日志/报告**。本机注入脚本:`scripts/with-minimax-env.sh <cmd>`(从 `~/.pi/agent/auth.json` 取 MiniMax、从 `~/.zcode/v2/config.json` 取 Xiaomi,静默 export)。live 命令示例:`scripts/with-minimax-env.sh npm run research -- serve`。
- 实测注意:Xiaomi MIMO 端点不遵循 system 通道,阶段指令已并入 user 消息;runAgentLoop 会把供应商 429 吞进消息(stopReason=error),适配器检出后主动抛出以触发备用切换。
- 成本口径:token plan(订阅制)供应商的边际成本为 0,`usage.costEstimate` 如实记 0,成本上限对这类供应商不生效;预算仍由搜索/抓取/墙钟上限约束。按 token 计费的供应商走 pi-ai 内置费率。
- 模型接入经 pi SDK(`@earendil-works/pi-ai` + `pi-agent-core`)进程内完成,不用 CLI 子进程。

## CLI

```bash
npm run research -- spike --questions q.json [--record f.json]   # 证据链 spike(live,可录制夹具)
npm run research -- spike --questions q.json --replay f.json     # 夹具回放(无需密钥)
npm run research -- run --request req.json [--plan p.json] [--replay f.json]
npm run research -- project create --request input.json [--datadir d]
npm run research -- project run --project <dir> --request req.json [--replay f.json]
npm run research -- project publish --project <dir> --run <runId>
npm run research -- project open --project <dir>
```

## 架构(模块化单体)

```
ui/          工作台 SPA(React + Vite,Prism 设计规范)
src/server/  本机 HTTP 服务(仅 127.0.0.1;密钥不入 API;快照仅纯文本)
src/app/     项目生命周期:创建/运行/发布(不可变版本 + 差异摘要)/导出/模板复用
src/core/    通用研究核心:plan→gather→analyze→draft→review→publish 状态机
             (检查点 / 取消 / 恢复 / 预算上限 / 评审回环 / 发布门禁)
src/modules/ 研究模块配置:品牌、行业(问题框架 / 来源策略 / 报告模板 / 专项质量检查)
src/quality/ 引用核查器、口径检查器、模块质量检查(纯函数门禁)
src/adapters/ 工具适配层:模型(pi SDK)、搜索、抓取、解析;录制/replay 夹具
src/stores/  本地项目存储:project.json + audit.jsonl(append-only)+ runs/ + reports/v<n>/
```

三契约:`ResearchRequest` / `ResearchRun` / `ResearchResultBundle`(zod 校验),为后续 JuanerAI 集成预留,一期不建专属接缝。

## 横向质量与运行控制

- 引用与证据:每个关键主张绑定快照级引句,发布前逐条核查(引句必须在原文快照中逐字命中)。
- 口径与逻辑:数值主张必须带口径(对象/时间/单位);同对象同期不同单位/不同数值 → 冲突披露。
- 发布门禁:高风险(引用核查失败/口径冲突未解释/缺反例检查)阻断发布,修复复核后重过;引句命中率 < 80% → 有限交付。
- 运行可靠性:阶段检查点持久化;取消保留已完成阶段;崩溃/中断自最后完成阶段恢复;失败落 `failed` 记录,不冒充完成。
- 资源预算:并行 ≤4,搜索/抓取/成本/墙钟上限(默认值见 `DEFAULT_BUDGET`,可按请求覆盖),到顶即有限交付。
- 数据与工具权限:服务仅绑 127.0.0.1;密钥 0600 本地配置;来源内容不可信——快照仅以净化纯文本呈现,导出 HTML 全文转义。

## 测试

缝合点:`runResearch(request, adapters, store)` 唯一执行入口;引用核查器/口径检查器/模块质量检查纯函数;适配器边界(录制 replay)。测试不依赖网络与密钥。

## 验收

见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)(5 条一期成功标准逐条核查记录)。B1(品牌)/ I1(行业)真实任务 live 验收跑待模型与搜索密钥提供后执行,证据链 spike 命令与回放夹具已就绪。
