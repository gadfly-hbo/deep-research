# P0-2 任务切片(自批准,auto;依据=PRD D1–D5 + GRILL R1/R2 决议)

- [x] 1. 写侧量化基线 — 证据:scripts/measure-snapshot-writes.mts 可运行,旧实现三夹具快照写字节 g1=1180/g2=1852/g3=2061(total 38667/27549/46641):scripts/measure-snapshot-writes.mts(golden replay + 临时目录 FsProjectStore 字节计数),旧实现基线入档
- [x] 2. 快照布局改造 — 证据:typecheck 绿;npm test 322/322 绿(+7 fsStore 测试:KA2 保序/迁移幂等/迁移失败回退/自愈重建/崩溃窗口 orphan/碰撞 fail-loud/readSnapshot 穿越串 null):FsProjectStore 一文件一快照 + index.json + open() 幂等迁移 + 自愈/碰撞校验,fsStore 测试更新
- [ ] 3. migrateLibrary 改走共享只读 helper + docs 三处同步 + .gitignore 加 .bak
- [ ] 4. server 端点:详情剥离 bodyText + /snapshots?sid= 改走 readSnapshot + 路径穿越 404 测试
- [ ] 5. 量化收尾:写侧改造后对比 + 读侧离线重算,数字入 handoff

---

## T1 写侧量化基线(KA4 前置;Blocked by:无;User stories:1)

照 `src/core/golden.test.ts` 模式写一次性脚本 `scripts/measure-snapshot-writes.mts`:replayAdapters 回放既有金样本夹具,store 换指向临时目录的 FsProjectStore,统计快照相关写盘字节数(包装写盘函数或 du 前后差)。**必须在 T2 动工前的旧实现上运行**,基线数字记入下方。

- [x] 脚本可运行,输出总写字节数与快照文件写字节数
- [x] 旧实现基线数字记录于本文件(改造后同 fixture 对比)

**旧实现基线**:g1=1180B / g2=1852B / g3=2061B 快照写字节(夹具正文极小,O(n²) 绝对值被压缩,但改写次数=n(n+1)/2 可推算)

## T2 快照布局改造(Blocked by:T1;User stories:1/3/5)

D1+D2+R1.1–R1.7、R2.1–R2.3:文件名 sha256(id) 前 16 hex;index.json `{order: string[]}`;`create()` 预建目录与空索引;`open()` 同步幂等迁移(try/catch 回退旧格式 + audit);同 id 覆盖不动索引位置;自愈(非法索引重建落盘+audit、order 清洗、坏文件跳过、orphan 只认 `^[0-9a-f]{16}\.json$`);碰撞读侧校验/写侧抛错;新增 `readSnapshot(id)`。迁移成功/失败/索引重建均记 audit。

- [x] KA2 单测:乱序写入 3 快照 + 同 id 覆盖,`listSnapshots()` 顺序与旧字典语义逐位一致
- [x] 迁移单测:旧格式 open 后数据原样可读、旧文件改名 `.bak`、二次 open 幂等、损坏 snapshots.json 回退不炸
- [x] 自愈/碰撞单测覆盖 R1.4/R1.5 各分支
- [ ] `npm test` + `npm run typecheck` 全绿

## T3 migrateLibrary + docs + gitignore(Blocked by:T2;User stories:3)

KA1 + R1.7b + R1.9b:共享只读 helper(新目录权威→回退旧文件,顺序=索引序/旧 `Object.values` 序),migrateLibrary.ts:56-59 改走 helper;docs/WHITEPAPER.md、PLAN-COMPARE.md、PRODUCT-OVERVIEW.md 存储布局描述同步;`.gitignore` 加 `research-data/projects/*/snapshots.json.bak`。

- [ ] helper 只读不迁移(dryRun 语义);migrateLibrary 既有测试全绿
- [ ] 三处 docs 更新;`.gitignore` 生效(`git check-ignore` 验证)
- [ ] `npm test` + `npm run typecheck` 全绿

## T4 server 端点(Blocked by:T2;User stories:2/4)

D3:`GET /api/projects/:id` 的 snapshots 剥离 bodyText(其余字段不变);`/snapshots?sid=` 改走 `readSnapshot(sid)` 单文件读,响应不变(text/plain 正文);KA3 路径穿越测试。

- [ ] 端点测试:详情响应 snapshots 无 bodyText 键、其余字段完整
- [ ] `sid=../../project.json` 及双重编码变体 404;正常 sid 正文不变
- [ ] UI 零改动验证:`npm run typecheck`(含 ui 子工程)绿
- [ ] `npm test` 全绿

## T5 量化收尾(KA4;Blocked by:T2+T4;User stories:1/2)

- [ ] 写侧:同一金样本 fixture 在新实现上重跑 T1 脚本,两组数字对比记录
- [ ] 读侧:离线重算 6 个存量项目剥离后体积,与 PRD 基线(95.9%–98.6% 缩减)对照确认
- [ ] 数字写入 `.flow/handoff.md` 与 DONE 总结
