# Red-Team:P2-1 v2(全部模型调用经 pi-agent-runtime,runText 形态)

**Verdict:Go(带 6 条强制修正,均为小时级文本/参数勘误,不触动机制)。** v1 五条 kill-assumption 修复方向经 dist 代码逐行复核全部成立;v2 新机制(子 taskId、uncapped+modelTimeoutMs、审计落盘、usage 映射)机制层全部站得住。

## 一、v1 修复核验(全部成立)

- **KA1 runText 成立**,精确前提:三个解析器是全函数(失败返回 []/{}/原文),validate 槽位**省略不用**,解析在 adapter 内对 result.value 跑;若写成会抛的 zod validate,8 个调用点从"降级"变"run 失败"——唯一翻车方式。**RunResult→契约三分映射表(必须钉入 PRD)**:succeeded→解析 value;failed+INVALID_OUTPUT→`{output:{}}` 走编排器兜底(schema 拒→fallback+limitation,与现状 parse 失败逐帧一致,含 32k 截断场景);其余 failed(MODEL_FAILED/DEADLINE/STATE/AUDIT)与 blocked→抛错。截断(stop'length')在 pi-adapter.js:213 → INVALID_OUTPUT,不切备用、不带文本——归"降级"桶后两版等价。
- **KA2 子 taskId 成立**:物理上不可触发 TASK_BUSY/CONFIGURATION_CHANGED;"签名锁定"句改诚实表述("limits 由单一 builder 生成,进程内逐字节一致");taskId 简化为 `dr:${callKey}`(callKey 已内嵌 keyBase);resume 重放同 callKey 安全(lease 在 run 结束 finally 自动 release,index.js:398-401)。已知低危:memory store Map 只增不减,server 长跑按调用数线性累积(每条数百 B),P2-2 持久化时解决,批次说明记一笔。
- **KA3 uncapped 成立,但 limits 恰好五键**(policy.js:7-11):cumulative:'unlimited' + maxOutputTokens(32_768,备用自动 min 到 16_384)+ modelTimeoutMs + toolTimeoutMs(30_000,名义)+ controlTimeoutMs(30_000,覆盖 authorize/audit/账本 IO)。缺一多一 INVALID_REQUEST 全灭。**测试(c)改写**:永不 resolve 的 transport 触发 setImmediate 兜底判 DEADLINE 不切备用;合成 transport 必须监听 signal 并在 abort 时 reject(与 fetch 行为一致)→ expired → modelRecovery → 备用成功。
- **KA4 真值表成立**(pi-ai 内建数据实测互证;mimo v2.6-flash 确无内建,必须全显式)。
- **KA5 用户已确认**;补披露:现状 pi-ai maxRetries:1 = 每候选至多 2 次(主备共 4 次);新接法 native retry 关 + extraAttempts:1 = 共 2 次,单次瞬时抖动直接换模型。符合标准 P4 接法,列入批次说明。

## 二、新 Top Kill-Assumptions

1. **>1MiB 快照抽取**:validateRequest 硬上限(validation.js:70-72)→ INVALID_REQUEST → 整 run 死;现状 extract 塞整份 bodyText,年报 PDF 中文全文 1-3MiB 现实,今天 MiniMax 1M ctx 吃得下。**修正**:adapter 拼 prompt 时按 ~1MiB 预算留头截断(丢尾部保 run,最接近现状);存量数据本周量一次分布。
2. **审计落盘选址**:research-data 在 git 同步区,追加型 jsonl 双机 rebase 必撞、同步停摆(dataSync 冲突即中止)。**修正**:research-data/.gitignore 加 `model-audit.jsonl`(本机留档,P2-2 定跨机口径)。
3. **映射表缺席**即实现者自由发挥 → 全 stage 硬失败(修正=一节的三分表钉入 PRD;测试(e)改写为"截断/INVALID_OUTPUT → 降级输出 → fallback+limitation 落 run")。

## 三、其余强制修正

1. **authorize 措辞**:成功路径强制 authorize({kind:'publish'})(index.js:381)——"publish 拒绝"=每次调用 blocked 全灭。正确:model 与 publish 均放行(结果仅进程内返回,无外发);本批无 tool/external。
2. **冒烟"断主 key"不可行**(401 非 ProviderFailure 不切备用,两版一致):改主候选 endpoint→`http://127.0.0.1:9` → ECONNREFUSED → network 类秒级切备用;或本地挂起服务 + DR_MODEL_TIMEOUT_MS=3000(顺带钉超时路径)。
3. **modelFailover.ts 不能整删**:searchFailover.ts:2 仍用 isTransientProviderError → 函数迁 searchFailover.ts,modelFailover.test 3 个 isTransient 用例随迁,仅删 2 个熔断用例。测试账:344 − 2(熔断用例)+ liveDraft 3 用例改路径 + 新增合成 transport 测试 ≥6。
4. **probe 脚本漏网**:6 个 scripts/probe-*.mts import piAiModel,删后运行即坏(typecheck/rg 都抓不到)——一并改经 piRuntime 或声明废弃删除。

## 四、开放问题裁决

1. validate 省略;三分映射表(见一);coerceDraftOutput 等价性不变。
2. 并发 append 无需串行化(SDK 单 run 内已串行,appendFile O_APPEND 单行<4KB 本地盘不交错;durability 注记:无 fsync 断电可丢尾,本批可接受);选址按 Top-2 修正。
3. DR_MODEL_TIMEOUT_MS 沿用:`modelTimeoutMs = Number(env ?? 300_000)`;tool/controlTimeoutMs 固定 30_000。

## 五、What's Well-Reasoned

vendor/lockfile 固定链(tgz 哈希=目录名、dist 逐字节一致、0.4.3 措辞、兄弟模式、SDK 0.86.1/engines)全部核实;接点 1 违规恰两处;recording/replay 零 pi 依赖;contracts usage 形状不动、costEstimate 恒 0 schema 合法;空 system 怪癖由 adapter 拼 prompt 自然保留;测试(a)(b)(d)(f) 可执行。

## 六、无法评估

mimo v2.6-flash 真实 contextWindow/输出上限(保守声明只可能偏紧);存量 >1MiB 快照分布(待量)。
