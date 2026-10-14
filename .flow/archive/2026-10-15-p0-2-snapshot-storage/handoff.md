# handoff — P0-2 快照存储与轮询负载(2026-10-15 完成)

## 本批次交付

- 快照存储:`snapshots.json` 单文件字典 → `snapshots/` 一文件一快照(sha256(id) 前 16 hex 文件名)+ `index.json` 插入序索引;`FsProjectStore.open()` 同步幂等迁移(旧文件改名 `.bak`,全程 audit 留痕);新增 `readSnapshot(id)` 单文件读。
- API:`GET /api/projects/:id` 剥离 bodyText(UI 零改动,typecheck 回归验证);`/snapshots?sid=` 改走单文件读,响应形状不变。
- migrateLibrary 改走共享只读 helper `readProjectSnapshots`(不迁移不写盘,dryRun 语义);docs 三处同步;`.bak` 豁免 git 入库。

## 量化结果(KA4)

- 读侧(6 个存量项目,146 快照):剥离 bodyText 后响应缩减 **95.9%–98.6%**(90K→1.6K … 1396K→19.2K)。
- 写侧(golden replay + 临时目录 FsProjectStore,`scripts/measure-snapshot-writes.mts`):g1 1180→821B(-30%)、g2 1852→1100B(-41%)、g3 2061→1173B(-43%)。夹具正文极小,绝对值被压缩;真实项目(72 快照/1.4M)旧格式全量重写 ≈ 50MB 量级 → 新格式 ≈ 1.5MB。

## 部署前置(硬约束)

- **双机须同批升级后再执行 dataSync**;版本偏移窗口内旧代码机器快照列表为空属已知行为,不回写、不双写。
- 迁移在 server 启动清扫/首次 open 时自动发生;失败不炸 open,读写回退旧格式,audit 记 `snapshot-migration-failed`。

## 开放项(后续批次)

- **P1-3** server.ts 拆分、**P1-4** UI 重构:未做。
- 评审 non-blocking 记录(见 .flow/review-findings.md F3–F7):saveSnapshot 索引损坏角落顺序偏离、损坏文件覆盖旁路、并存补迁分支无直接单测、全新迁移分支 .bak 覆盖保护、tmp 目录残留清理。均为加固空间,非缺陷。
- 磁盘读放大未治(轮询仍全量读 N 个文件),如成痛点再立项(索引元数据缓存)。
