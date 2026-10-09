// 诊断:同一 minimax-cn/MiniMax-M3 连续多轮调用,验证稳定性与无配额/限流问题
import { piAiModel } from "../src/adapters/live.js";

const model = piAiModel([{ provider: "minimax-cn", modelId: "MiniMax-M3" }]);
const bodies = [
  "中国咖啡市场规模约 1,200 亿元(2025 年),同比增长 15%。",
  "森马服饰 2025 年营收 148.2 亿元,归母净利润 11.5 亿元。",
  "童装行业集中度提升,前五大品牌市占率合计约 22%。",
  "2026 年上半年新能源汽车渗透率突破 55%。",
  "某省 2025 年 GDP 总量 6.2 万亿元,增速 5.1%。",
  "咖啡连锁品牌门店数突破 8 万家,下沉市场贡献主要增量。",
];

let ok = 0;
let totalCost = 0;
for (let i = 0; i < bodies.length; i++) {
  const snapshot = {
    id: `s${i}`,
    url: `https://example.com/${i}`,
    title: `t${i}`,
    fetchedAt: "2026-10-05T00:00:00Z",
    bodyText: bodies[i],
    parseStatus: "ok" as const,
    contentType: "text/html",
  };
  const t0 = Date.now();
  try {
    const r = await model.extractClaims({ snapshot }, `round:${i}:${Date.now()}`);
    totalCost += r.cost;
    console.log(
      `第 ${i + 1} 轮:成功 ${((Date.now() - t0) / 1000).toFixed(1)}s, claims=${r.claims.length}, cost=${r.cost.toFixed(4)}`,
    );
    ok++;
  } catch (e) {
    console.log(`第 ${i + 1} 轮:失败 ${((Date.now() - t0) / 1000).toFixed(1)}s — ${(e as Error).message.slice(0, 200)}`);
  }
}
console.log(`\n结果: ${ok}/${bodies.length} 轮成功,累计 cost=${totalCost.toFixed(4)}`);
