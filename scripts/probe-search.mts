import { mcpWebSearch } from "../src/adapters/mcpSearch.js";
import { xiaomiWebSearch } from "../src/adapters/xiaomiSearch.js";
import { searchWithFallback } from "../src/adapters/searchFailover.js";

const minimax = mcpWebSearch({
  command: "uvx",
  args: ["--with", "mcp<2", "minimax-coding-plan-mcp", "-y"],
  env: { MINIMAX_API_HOST: "https://api.minimaxi.com" },
  timeoutMs: 60_000,
});
const xiaomi = xiaomiWebSearch({ apiKey: process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY! });
const search = searchWithFallback([minimax, xiaomi]);
try {
  const hits = await search.search("中国咖啡市场规模 2025", "probe:0");
  console.log("hits:", hits.length);
  for (const h of hits.slice(0, 4)) console.log("-", h.title.slice(0, 50), "|", h.url.slice(0, 70));
} finally {
  await minimax.close();
}
