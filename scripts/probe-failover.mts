// 诊断:minimax(配额耗尽)+ 信号超时下的失败形态与耗时
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
const t0 = Date.now();
const model = getBuiltinModel("minimax-cn", "MiniMax-M2.7");
const mod = await import("@earendil-works/pi-ai/api/anthropic-messages");
const events: string[] = [];
let finalMessage: any = null;
try {
  for await (const ev of mod.streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] }, { apiKey: process.env.MINIMAX_CN_API_KEY, signal: AbortSignal.timeout(150_000) } as never)) {
    events.push(ev.type);
    if (ev.type === "error") {
      const e = (ev as any).error;
      console.log(`ERROR-EVENT after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, e?.errorMessage?.slice(0, 150) ?? JSON.stringify(ev).slice(0, 150));
    }
    if (ev.type === "done") finalMessage = (ev as any).message;
  }
  console.log("events:", events.join(","));
  console.log("done.stopReason:", finalMessage?.stopReason, "errorMessage:", String(finalMessage?.errorMessage ?? "").slice(0, 150));
} catch (e) {
  console.log(`THROWN after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String(e).slice(0, 200));
}
