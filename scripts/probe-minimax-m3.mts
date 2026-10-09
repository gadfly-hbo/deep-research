// 诊断:生产同款配置(minimax-cn / MiniMax-M3)实测模型链路
import { piAiModel } from "../src/adapters/live.js";
const model = piAiModel([{ provider: "minimax-cn", modelId: "MiniMax-M3" }]);
const snapshot = { id: "s1", url: "https://example.com", title: "t", fetchedAt: "2026-09-21T00:00:00Z", bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" as const, contentType: "text/html" };
const t0 = Date.now();
const r = await model.extractClaims({ snapshot }, `probe:${Date.now()}`);
console.log(`minimax M3 用时 ${((Date.now()-t0)/1000).toFixed(1)}s, claims:`, JSON.stringify(r.claims).slice(0, 300));
