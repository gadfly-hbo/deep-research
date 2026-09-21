// 诊断:仅 minimax,无备用链路;返回 claims 即证明 minimax 真实在服务
import { piAiModel } from "../src/adapters/live.js";
const model = piAiModel([{ provider: "minimax-cn", modelId: "MiniMax-M2.7" }]);
const snapshot = { id: "s1", url: "https://example.com", title: "t", fetchedAt: "2026-09-21T00:00:00Z", bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" as const, contentType: "text/html" };
const t0 = Date.now();
const r = await model.extractClaims({ snapshot }, `probe:${Date.now()}`);
console.log(`minimax-only 用时 ${((Date.now()-t0)/1000).toFixed(1)}s, claims:`, JSON.stringify(r.claims).slice(0, 200));
