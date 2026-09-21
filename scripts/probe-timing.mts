// 诊断:真实大快照经主备链路抽取一次,计时
import { piAiModel } from "../src/adapters/live.js";
import { readFileSync } from "node:fs";
const b1 = JSON.parse(readFileSync("/tmp/dr-spike/b1-run.json", "utf8"));
const snaps = [...(b1.bundle?.snapshots ?? [])].sort((a, b) => b.bodyText.length - a.bodyText.length);
const snap = snaps[0];
console.log("snapshot:", snap.url.slice(0, 60), "bodyText chars:", snap.bodyText.length, "parse:", snap.parseStatus);
const model = piAiModel([
  { provider: "minimax-cn", modelId: "MiniMax-M2.7" },
  { provider: "xiaomi-token-plan-cn", modelId: "mimo-v2.5-pro", api: "openai-completions", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
]);
const t0 = Date.now();
const r = await model.extractClaims({ snapshot: snap }, `probe-timing:${Date.now()}`);
console.log(`chain 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s, claims: ${r.claims.length}, cost: ${r.cost}`);
