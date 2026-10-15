# P2-1 REVIEW 报告

> 评审模式:**降级内联**(REVIEW 子代理 403 配额中断,主代理按 code-review 方法内联执行;红队 v2 与 GRILL R1 均为全新子代理产物,对抗性损失仅限本评审层,DONE 披露)。
> 固定点 aa56bd9;4 commits(58074fc/cb39975/7682f38/775253c);diff 22 文件全部在预期清单内,零 core/app/server/ui/recording/replay 触碰。

## VERIFY(评审中重跑,与记录一致)

`npm test && npm run typecheck` = **57 文件 349 测试全绿 + typecheck exit 0**(基线 342 = 344−2 熔断用例,+7 合成 transport 测试)。

## 接点 1(本批核心合规目标)

- `rg -l "@earendil-works" src/ scripts/ ui/` → **零命中** ✓。
- `pi-agent-runtime` 的 import 恰两处:`src/adapters/piRuntime.ts`(产品唯一接点)与 `piRuntime.test.ts`(测试 import 共享包类型——标准禁的是 Pi 包 pi-ai/pi-agent-core,共享包本身可 import,合规)。
- 传递依赖 pi 两包 0.86.1 由 vendored tgz + lockfile 固定;干净克隆 `npm ci` 成功(T5 实测)。

## Spec 轴:红队 6 强制修正逐条 ✓

1. limits 恰五键(piRuntime.ts `buildLimits`:unlimited/32768/env 超时/30k/30k)✓
2. authorize model+publish 放行(注释含红队依据)✓
3. 三分映射:`runTextRaw` succeeded→文本;INVALID_OUTPUT→null→extract `[]`/stage `{}`(draft/polish `text===null→{}`);其余 failed/blocked→throw ✓;validate 槽位省略 ✓
4. `research-data/.gitignore` 含 model-audit.jsonl;T6 实证落盘(version 1.0/taskId `dr:` 前缀/gitignore 生效)✓
5. 冒烟按新设计:ECONNREFUSED 切换链真实跑通(dead/unreachable→network 类→15.5s mimo 10 问)✓
6. modelFailover 拆分:isTransientProviderError+3 用例迁 searchFailover;熔断器+2 用例删 ✓;6 probes 改 import、M2.7→M3 ✓;backfill 改 runFreeText ✓

## Spec 轴:GRILL R1-1~R1-9 逐条 ✓

modelText 落点(STAGE_PROMPTS/三解析器/buildXxxPrompt,零传输依赖)/三分映射规则(真值表/自定义/拒绝)/channelCache 进程级单例(R1-3 披露:候选链固化需重启)/DR_DEBUG 双行制(T6 双链实证:ok 行带 provider 关联、failed 行带 failureCategory)/1MiB 字节护栏(clampExtractPrompt,避开代理对中切;存量最大 553KB 零触发)/runFreeText/npm ci 验收/审计无界接受(PRD 记录)。

## 行为等价走查

- live.ts 保留段(httpSearch/livePage/liveParser/cleanPageTitle/dig/HttpSearchConfig)**115/115 行逐字一致**(脚本核验);164 行 pi 专属代码由 piRuntime 按三分映射替代。
- 差异面 = PRD D4 五条披露(costEstimate 恒 0/单次抖动换模型/熔断退役/文案类别化/截断→降级披露)+ R1-3(候选链固化需重启,与现状语义一致),无未披露差异。
- prompt 拼装:buildExtractPrompt/buildStagePrompt 与原内联模板逐字同构(modelText.ts,含 xiaomi 不用 system 的怪癖保留——runText 只传 prompt 不传 system)。

## 测试作为证据

piRuntime.test.ts 7 条均为行为断言,非恒真:(c) 同时断言备用产物内容与 <5s(真实切换而非仅不超时);(b) maxInFlight>1(并发真实发生);(e) 截断双路径(draft `{}` 与 extract `[]`);(d) 经惰性首调触发(工厂不 eager throw 的语义如实测出)。

## Findings(non-blocking,记录不行动)

1. [implementation,judgement] `channelCache` 以 configs+auditPath 为键,长跑 server 下 configs 变体会留多实例——实际 configs 进程内固定(1-2 项),无害;P2-2 账本重构时一并清理。recheck:无 configs 变体场景即合规。
2. [implementation,judgement] 审计 appendFile 无 fsync(断电可丢尾)——PRD D2 既定接受,P2-2 定保留/轮转时一并处理。recheck:P2-2 落地即闭。
3. [test,judgement] probe-multiround 的 cost 累计恒 0 已加注释;probe 脚本无测试覆盖(tsx 手跑工具,历史如此)。recheck:无需。

## 裁决:PASS

零 blocking;接点 1 达成;红队/GRILL 全部修正落地并被测试与真实双链冒烟钉住。
