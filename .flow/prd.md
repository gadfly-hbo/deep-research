# PRD:P0-2 快照存储与轮询负载

> 主规格源:`.flow/proposal.md`(2026-10-14 重构审查 P0-2);红队前置条件:`.flow/red-team.md`(KA1–KA4)。
> 无 issue tracker(`docs/agents/issue-tracker.md` 不存在),PRD 落盘本文件。

## Problem Statement

本机单用户工作台的两个叠加性能债(证据见 proposal.md,红队复核全部属实):

1. **写放大**:`FsProjectStore.saveSnapshot` 每次整文件读→追加→重写 `snapshots.json`,快照含整页 bodyText,一次 run 60+ 次抓取 = O(n²) 字节写入。
2. **读放大**:`GET /api/projects/:id` 返回全量快照含正文,UI 2.5s 无条件轮询;UI 类型根本不声明 bodyText(0 处引用),字节纯属白传。

存量基线(2026-10-15 离线实测,6 个项目、146 个快照):剥离 bodyText 后体积缩减 **95.9%–98.6%**(最小 90K→1.6K,最大 1396K→19.2K)。成功指标对齐体积/字节数,不承诺用户可感知提速(红队 What-I-Couldn't-Assess)。

## Solution

1. 快照存储从单文件字典改为一文件一快照(与 `runs/` 目录同构),存量数据自动迁移。
2. 项目详情的列表型响应剥离 `bodyText`;正文仍按需走 `/snapshots?sid=`。
3. 轮询退避**不做**(行为变化,与本次解耦——提案级决策)。

## User Stories

1. 作为本机用户,我希望长时间 gather 期间磁盘写入量不再随已采快照数平方增长,以便大项目研究不产生无谓 IO。
2. 作为本机用户,我希望 UI 轮询的项目详情响应不再携带我从不看的整页正文,以便面板刷新开销与项目规模解耦。
3. 作为本机用户,我希望升级后既有 6 个项目的快照数据原样可读(顺序、内容、id 不变),无需手工迁移。
4. 作为维护者,我希望 `/snapshots?sid=` 的查找不接受任意路径串,以便本机服务不存在路径穿越面。
5. 作为维护者,我希望快照格式变更后"最近快照"等 UI 展示顺序与旧行为逐位一致。

## Implementation Decisions

### D1 存储布局(一文件一快照 + 顺序索引)

- 新目录 `<project>/snapshots/`:每个快照一个文件,文件名 = `sha256(snapshot.id)` 前 16 位 hex + `.json`;id 全文留文件内。查找走"编码→精确文件名",**原始 sid/id 永不拼路径**(KA3)。
- `<project>/snapshots/index.json` = `{ order: string[] }`(快照 id 的插入序):`saveSnapshot` 新 id 追加到末尾;同 id 覆盖写只更新文件、**不动索引位置**——逐位复刻旧字典"位置不变、内容更新"语义(KA2)。选索引而非 fetchedAt 排序的理由:fetchedAt 排序在覆盖写时会把快照顶到末尾,不满足 KA2 的逐位一致判据;索引文件极小(仅 id 列表),重写成本可忽略。
- `listSnapshots()` 按索引顺序读文件返回;索引与目录漂移的自愈规则:目录中存在但索引缺失的 id 按 fetchedAt 升序追加到末尾(崩溃窗口兜底),索引中存在但文件缺失的 id 跳过。
- `FsProjectStore` 新增 `readSnapshot(id)`(哈希→精确文件名,缺省返回 null);`saveSnapshot`/`listSnapshots` 签名不变;`ResearchStore` 接口不动(本就不含 listSnapshots——红队核实)。

### D2 存量迁移(打开即迁,幂等)

- `FsProjectStore.open()` 时:`snapshots/` 不存在而 `snapshots.json` 存在 → 读出字典,按 D1 写入全部文件与索引,然后把旧文件改名 `snapshots.json.bak`(不删除,KA1 建议)。
- 迁移崩溃恢复:下次 open 时若两者并存,`snapshots/` 为权威,补迁缺失 id 后再改名 `.bak`(幂等)。
- `src/app/migrateLibrary.ts:56-59` 是绕过 store 的直读方(KA1,迁移从未执行过、仍是活路径):改为经共享读取 helper(新目录权威 → 回退旧文件),不再直读 `snapshots.json`。

### D3 API 形状

- `GET /api/projects/:id`:`snapshots` 字段改为剥离 `bodyText` 的序列化(其余字段不变);UI 的 `Snapshot` 类型本就未声明 bodyText,UI 零改动(typecheck 回归验证)。
- `GET /snapshots?sid=` 响应不变(text/plain 正文);实现改走 `readSnapshot(sid)` 单文件读,顺带消除该端点的全量列表读。
- `cli.ts:248` 的 `listSnapshots()` 调用(仅取计数)不变。

### D4 文档同步(KA1)

`docs/WHITEPAPER.md:208`、`docs/PLAN-COMPARE.md:69`、`docs/PRODUCT-OVERVIEW.md:203` 的快照存储布局描述同步为新格式(`.flow/archive/**` 历史归档不动)。

### D5 约束

- 不动 `src/contracts.ts` 与 `src/adapters/types.ts`;`SourceSnapshot` 契约不变。
- `runResearch.ts` 调用点不动(saveSnapshot 签名不变);golden 测试走 memory store,不受影响。
- P1-3(server.ts 拆分)、P1-4(UI)不在范围;轮询退避不做。

## Testing Decisions

好测试 = 只测外部行为(存储布局语义、HTTP 响应形状),参照 `src/stores/fsStore.test.ts` 与 `src/server/server.test.ts` 风格。

- **fsStore 新测试**:乱序写入 + 同 id 覆盖后 `listSnapshots()` 顺序与旧字典语义逐位一致(KA2);索引/目录漂移自愈;`readSnapshot` 命中/未命中。
- **迁移测试**:旧格式项目 open 后数据原样可读、旧文件改名 `.bak`、二次 open 幂等。
- **路径穿越测试**(KA3):`sid=../../project.json` 及双重编码变体必须 404(server 测试层)。
- **端点剥离测试**:`GET /api/projects/:id` 响应 snapshots 无 bodyText 键、其余字段完整。
- **写侧量化**(KA4):照 `golden.test.ts` 模式的小 harness——replayAdapters 回放既有金样本,store 换指向临时目录的 FsProjectStore,对写盘字节计数;**改造前先在旧实现上跑出基线并记录进 tasks.md**,改造后同 fixture 对比。
- **读侧量化**(KA4):基线已采集(见 Problem Statement);实现后用脚本重算剥离后体积对照。
- 既有 `npm test`(315) + `npm run typecheck` 全绿为门禁。

## Out of Scope

- 轮询退避/联动(行为变化,提案默认不做)。
- server.ts 拆分(P1-3)、UI 重构(P1-4)。
- `runs/`、`requests/` 等其他目录的存储格式。
- 情报库(library/)自身存储格式。

## Further Notes

- 替代方案取舍(红队要求记录):append-only jsonl + 启动物化索引被否——listSnapshots 每次仍需全量读;saveSnapshot 合并写防抖被否——崩溃窗口丢快照且轮询仍读全量;一文件一快照与 runs/ 同构、同时消除 `/snapshots?sid=` 的全量读,是三个方案中唯一同时治写放大与详情端点读放大的。
- 风险:迁移在 `open()` 同步执行,大项目首次打开有一次性 IO 尖峰(最大 1.4M,可忽略)。

## PRD diff gate 记录(auto 自批准,2026-10-15)

相对 proposal.md 的决策点差异——**全部为新增细化,无 change/drop 提案决策项**:

1. D1 具体布局(sha256 前 16 位文件名、index.json 顺序索引、自愈规则)— 提案开放问题的落定;索引方案替代红队建议的 fetchedAt 排序,理由已记录(覆盖写位置语义逐位一致)。
2. D2 迁移策略(open 即迁、`.bak` 改名、migrateLibrary 纳入影响面)— 红队 KA1 前置条件。
3. D3 端点序列化细化与 readSnapshot 单文件读 — 提案方向的实现细化。
4. D4 docs 三处同步 — 红队 KA1 前置条件。
5. 量化验证基线(读侧 95.9%–98.6% 已采集;写侧 golden-fixture harness 方案)— 红队 KA4 前置条件。

## GRILL 决议

### 第 1 轮(盲审子代理,9/9 按推荐采纳)

- **R1.1 迁移失败爆炸半径(Q1)**:`open()` 内迁移整体 try/catch;失败则不迁移、不动旧文件、读写回退旧格式,audit 记 `snapshot-migration-failed`。理由:`open()` 调用点遍布 server/app/cli 且项目列表端点无 per-project 保护,损坏 snapshots.json 不得拖垮整列表。
- **R1.2 并发与迁移时机(Q2)**:(a) `saveSnapshot` 的"快照文件写入 + index.json 读改写"在同一同步块内完成、中间无 await(gather maxParallel=4 并发的原子性全靠同步块,沿用现有 sync fs 风格);(b) 迁移由 `open()` 幂等触发,server 启动清扫在任何新 run 前 open 全部项目并先把中断 running 置 failed,故无"进行中 run 撞迁移"的同进程窗口;(c) 跨进程(CLI+server 同开)迁移撞车:后到者重检状态,`snapshots.json` 已消失则视为他进程已完成、继续,不抛错;跨进程并发写 index 的竞态与旧格式同级,声明不在本期保证。
- **R1.3 `open()` 同步签名为准入条件(Q3)**:迁移在 open 内同步完成;阻塞即一致,"迁移中途端点一致性"无须额外机制。风险节改述:首次启动一次性迁移全部存量(最大 1.4M,毫秒级),此后零成本。
- **R1.4 自愈边界(Q4)**:(a) index.json 非法 JSON 视同缺失:按目录扫描以 fetchedAt 升序重建(并列按文件名字典序 tiebreak)、立即落盘、audit `snapshot-index-rebuilt`;(b) order 数组清洗:去重(保留首次出现)、滤非字符串;(c) 单快照文件损坏:`listSnapshots()` 跳过 + audit,`readSnapshot` 返回 null(端点 404),一坏文件不灭整列;(d) orphan 扫描只认 `^[0-9a-f]{16}\.json$`,`.DS_Store` 等忽略。
- **R1.5 哈希截断碰撞(Q5)**:读侧 `readSnapshot` 校验文件内 id === 请求 id,不符返回 null(404);写侧 `saveSnapshot` 目标文件已存在且内 id 不符时**抛错**(fail loud,不静默覆盖)。
- **R1.6 迁移审计(Q6)**:成功记 `snapshots-migrated {count, renamedTo}`,失败记 `snapshot-migration-failed {error}`(KA1 的教训就是"迁移从未执行却无从发现")。
- **R1.7 `.bak` 归宿(Q7)**:(a) 永久保留不自动删;(b) 不入 git——`.gitignore` 加 `research-data/projects/*/snapshots.json.bak`(git 历史已含旧文件全部版本,.bak 是纯冗余);(c) 不自动从 .bak 恢复:检测到"snapshots/ 缺失而 .bak 存在"只记 audit 警示,恢复留给人工 rename;(d) 补迁场景旧文件改名为带时间戳的 `.bak-<iso>`,避免覆盖原备份。
- **R1.8 dataSync 双机版本偏移(Q8)**:不加技术方案,加部署前置:"双机须同批升级后再执行 dataSync;版本偏移窗口内旧代码机器快照列表为空属已知行为,不回写、不双写"。写入 Known Limitations 与 DONE 总结。
- **R1.9 口径收口(Q9)**:(a) 磁盘读放大保留并声明——剥离只发生在 server 序列化层,`listSnapshots()` 仍全量读 N 个文件(1 次大读→N 次小读),成功指标只对齐网络字节;不扩展索引元数据缓存;(b) migrateLibrary 共享 helper **只读不迁移**(dryRun 语义),返回顺序 = 索引序(=旧字典插入序),回退旧文件时按 `Object.values` 现状序。

### 第 2 轮(主代理自审,5/5 按推荐采纳)

- **R2.1 新项目纯新格式**:`FsProjectStore.create()` 预建 `snapshots/` 目录与空 index,新项目永不触旧格式。
- **R2.2 快照文件内容形状** = SourceSnapshot JSON 本体(与旧字典值逐位一致),不加包装信封。
- **R2.3 index 落盘时机**:每次 `saveSnapshot` 追加后立即在同一同步块写 index.json;崩溃窗口(文件已写、索引未写)由 R1.4 自愈兜底。
- **R2.4 写侧量化 harness 为一次性脚本**:`scripts/measure-snapshot-writes.mts`(与现有 probe-*.mts 同风格),replay 金样本 + 临时目录 FsProjectStore 计写字节;**先在旧实现跑出基线记入 tasks.md,改造后同 fixture 对比**,两组数字记入 handoff;不设长期字节数测试(避免脆性),长期守卫 = 既有测试套件。
- **R2.5 迁移与部署注记去向**:R1.8 的双机前置写入本 PRD「Further Notes」+ `.flow/handoff.md` + DONE 总结。

GRILL 两轮后无新增开放问题,收敛(2/2 轮)。无升级项:全部决议均为 proposal 空白处的填充,无 change/drop。

### Known Limitations / 发布注记(R1.8 + R2.5 落点)

- **dataSync 双机前置**:双机须同批升级后再执行 dataSync;版本偏移窗口内旧代码机器上快照列表为空属已知行为,不回写、不双写(旧机 `readJson("snapshots.json", {})` 落空返回空;若旧机再发起 run 会重建旧格式文件,新机 D2 并存补迁可兜住数据,但窗口期旧机证据链不可用)。
- 磁盘读放大不在本期指标:剥离只发生在 server 序列化层,`listSnapshots()` 仍全量读 N 个文件(1 次大读→N 次小读);成功指标只对齐网络字节(R1.9a)。
