# Red-Team:P2-6 动态预算+steer+编排器退役(程序收官)

**Verdict:Go 附 4 项 PRD 必改。** 无承载性证伪;一个产品语义缺口(KA1)必须定案。

## KA1(最高)capped 与 unanswered 均不可逆——加注可能"买到 limited"
- state.capped 全仓 11 处赋 true 零复位(runResearch.ts:482,524,529,571,580,620,750,1143,1186,1221,1254);capped=true 跳过 polish(:1217)与 review 回环(:1248);配额尽问题标 unanswered 后 continue 无重访(:481-484)。
- **裁决必选**:(a) 加注时复位 capped(余量时)+重开配额饿死问题(:483 记成因)——复杂但用户"放开"哲学一致;(b) 接受"加注只救后续问题,run 仍 limited"写进 UI。不选=必踩坑。

## KA2 Budget 可变=同对象原地变异(禁引用替换)
- executor 配额闸/任务卡余量/limitation 文案直读编排器闭包 budget 常量非 tracker(:528/:461/:1098)——换 tracker 引用后判断分裂。
- CONFIGURATION_CHANGED 风险=0:budget 从不进 runtime limits/configuration;uncapped 白名单连 wallTimeMs 键都不存在(fileBudgetStore.ts:24-26);budget 只进 prompt(R1-1)。
- 竞态窗(error-as-value 后加注到达)可接受:当前问收尾下一问受益。仅 running 可加注。

## KA3 问内 refine 注入=filtered take(禁 drain)
- drain() 全量 splice(runRegistry.ts:85-89)——executor 内 skip/add 契约无处安放(executor 只能返回值);注入通道唯一=工具返回值 note(prompt 轮次注入不可能,:667);同一条 refine 既即时注入又留 directionNotes 是期望语义;降级面:模型正在收束不调 web_search→refine 落空退化为下一问(现状)。
- R1-1 不变式不受影响(taskId/工具定义不动)。

## KA4 拆分"纯移动"纪律
- 25 个闭包绑定;state/directionNotes/activeGatherTargets/fetchedByQ/currentQuestion/run.usage 必须传引用非复制;directionNotes 声明(:860)先于 gather(:469)前向引用靠调用时序。
- **硬约束:拆分 commit 零断言改动(除 import 路径);任何测试需改=不是纯移动,拆 commit 逐条解释。**先 gather 域(测试最厚),后质量回环/门域。GatherContext 单对象传引用不建类层次。

## KA5 收官偏差台账
- 至少四条已批准偏离未汇总:①P2-3 checkpoint→durable gate ②P2-4 steer 字面延后 ③本批 steer 语义化(第三次) ④跨机会话/compaction 不做。收官含逐批对表+偏差台账+指标基线(411 tests/66 files;runResearch 1378→<400)。

## 裁决
1. 同对象原地变异;竞态可接受;仅 running 可加注。
2. filtered take+工具返回值 note 注入;共存分层(问间隙全量 drain 不变)。
3. **steer 第三次偏离:批准**(证据链完整:三轮校准连续+dist 实证+架构重写前提;条件:用户确认留痕+偏差台账+UI 不自称 steer)。
4. gather 域先行;GatherContext 单对象。
5. F6 补直接断言(3 行,gatherAgent.test C4 模式)。

## 无法评估
加注真实需求强度(无使用数据);UI 契约缺口(加注按钮未列工件——应补);<400 行可达性(未做依赖图度量)。
