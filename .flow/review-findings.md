# REVIEW #1 发现(2026-10-04,code-reviewer 子代理,verdict FAIL)

## BLOCKER
- B1 src/core/evidencePacks.ts:149 attachments/library-reuse 主张的素材包被静默丢弃:orderedQids 只追加 base,attachments/reuse 永不发射;附件恰是 tier A 一手资料,改进2 对该路径失效且无披露。
- B2 src/adapters/replay.ts:34 旧 replay 录制无 polish key 必然回放崩,与 PRD D4 向后兼容矛盾。

## SUGGESTION
- S1 applyCap 截断后 used 计数 off-by-one(room+1),总量/单问题上限不严格。
- S2 非逐字区间与逐字窗口合并后被 maxPerSnapshot 截断,引句上下文被裁但 verbatim 仍 true。
- S3 refCount 计 claim-evidence 对而非去重主张数;跨问题总量封顶未按引用次数全局优先(D2 语义未完全兑现)。
- S4 polish:false 恢复含 polish cp 的旧 run 仍用润色稿覆盖。
- S5 polish 走 draftFromText 无直接单测;polish checkpoint 恢复无测试(tasks 验收未兑现)。
- S6 PRD D3 编排位置表述与 GRILL#1 矛盾(实现正确随 GRILL,spec 未同步)。
- S7 rephrase 整体覆盖润色稿(GRILL#1 已决不二次润色,留痕提示)。

## UNVERIFIED
- 旧录制兼容落地形态;polish:false+polish cp 恢复语义;反编造条款无可执行护栏(K1 靠流程外试点);真实 LLM 40k 素材超时率(K3)。

## 复核
验证命令已重跑实测一致:43 文件 254/254,typecheck 0。
