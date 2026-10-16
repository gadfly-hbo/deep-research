# P2-6 复审 findings(独立子代理 agent-98,2026-10-16;第 3 轮)

## Verdict:FAIL — 1 项阻断(B1 修复不完整),其余核实通过

VERIFY 重跑:npm test && npm run typecheck exit 0,68 文件 421 全绿,墙钟 ~8.3s,无失配。

## 阻断

**B1R. reopened 跨扫描重复入列 → 递归仍可双轮调查并清除新主张(B1 同类残余)**
- 证据:src/core/gatherDomain.ts:286 问开始扫描与 :571 循环末扫描各自 push,scanTopupReopen 单次扫描内不重复但跨扫描不查重。触发序:gap 目标 X(unanswered+quota-starved)在前一问的扫描被标 open 入列 → 轮到 X 时搜索配额已被前问耗尽,:287-292 把 status==="open" 的 X 重标回 unanswered+quota-starved → 随后第二次加注到达(同 run 双加注是设计内用法),循环末 :571 扫描再标 open 再次入列;:575 needReopen 只按状态过滤不去重 → [X, X] → 同一调用内 X 被调查两遍;第二遍 :296-301 清掉第一遍主张/证据,且两遍共用同一 taskId(:495 r${round}:${q.id},违反 R1-1 子 taskId 唯一假设)。
- 归属:implementation。blocking。
- 测试判别:「gap targets ∩ starved」用例判别成立但仅单次加注,盖不住双加注重复入列路径。
- Recheck:needReopen 按 q.id 去重(或入列时跳过已入列者),补「双加注+中途配额耗尽」回归测试断言每问只调查一次。

## 非阻断
1. RETRO 冒烟覆盖含「加注 409 负例」但驱动日志无此证据(409 由 budgetRoutes 单测覆盖)——证据归类失实;recheck:改列测试覆盖或补冒烟。
2. handoff 验证状态计数过时(420 vs 421)。
3. budget 端点 running 检查仍在锁外(极窄窗口,变异对象无害);recheck:状态检查移入锁内或注释披露。
4. gather(gatherCtx, 2, lateReopened) 轮次硬编码(存量提示)。

## 已核实成立
N2 勘误吻合;F1 字面量还原+全仓漂移仅此一处;F3 四评估窗在位;F5 锁内+无死锁面;F6 三态对齐+hooks 前置;F2 冒烟三证据逐条对档成立(run 4e8fb9d8/d8b1913e);F4 收官交付;锁定行为未回退;T4 零断言纪律成立。N1/N3/N4/N5 维持原判。

总 recheck:reopened 按 id 去重+「双加注+中途耗尽」回归测试后全绿即转 PASS。
