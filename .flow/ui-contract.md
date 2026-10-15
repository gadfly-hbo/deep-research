# P2-2 UI-GATE 契约

> 产出模式:降级内联(子代理 403)。本批 UI 面 = **6 处既有文本替换**(成本数字 → 模型计量),零新增/删除表面、零布局变化。

## Surfaces(全部为既有表面)

| # | 表面 | 位置 | 变更 |
|---|---|---|---|
| S1 | 底部状态栏用量段 | ui/shell/StatusBar.tsx:39 | `成本≈X.XXX` → `模型 N 次 · 输出 M tok` |
| S2 | 采证页运行指标行(进行中) | ui/views/GatherView.tsx:99 | 同上格式,与搜索/抓取并列 |
| S3 | 采证页指标卡 | ui/views/GatherView.tsx:122 | 卡标题"成本估算"→"模型用量",值 `N 次 · M tok` |
| S4 | Inspector 运行记录行 | ui/inspector/Inspector.tsx:208 | 同 S1 格式 |
| S5 | 发布页运行行 | ui/views/PublishView.tsx:84 | 同 S1 格式 |
| S6 | 用量类型定义 | ui/state/types.ts:53 | usage 形状换字段(代码层,无视觉) |

## 术语与格式(钉死)

`模型 {modelCalls} 次 · 输出 {outputTokens} tok`——原始数字,不缩写、不 toFixed;与既有 `搜索 N · 抓取 N · …s` 的并列风格一致;存量旧记录(zod default 0)显示 `模型 0 次 · 输出 0 tok`。

## Negative cases

- 不得出现成本/¥/估算字样残留(`rg costEstimate ui/` 零命中);
- 不得新增表面/弹层/图标;
- 旧记录不得因缺字段报错(default 0 兜底)。

## Trace links

S1–S5 ↔ PRD D3/D4(计量替换);S6 ↔ D2(契约变更)。

## Visual artifact

- 格式:单页静态 HTML,`<link>` 复用仓库真实 `ui/styles.css`(路径 `../../ui/styles.css`)。
- 文件:`.flow/ui/p2-2-usage-text.html`
- 覆盖:S1(状态栏段落)、S2(指标行)、S3(指标卡)、S4/S5(运行行)替换后形态各一分区 + 存量旧记录(0 值)形态。
- 数据保真:合成示例数值;字段形状来自 PRD D2。披露:数值合成。

## 结论

PASS(契约与原型 1:1,无 PRD 外发明)——待用户批准。recheck:打开 HTML,每分区对应上表一行,无多余分区。
