
import { spawn } from "node:child_process";
const child = spawn("uvx", ["--with", "mcp<2", "minimax-coding-plan-mcp", "-y"], { env: { ...process.env, MINIMAX_API_HOST: "https://api.minimaxi.com" }, stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0);
const pending = new Map();
child.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) { const nl = buf.indexOf(0x0a); if (nl < 0) return; const line = buf.subarray(0, nl).toString("utf8").trim(); buf = buf.subarray(nl + 1); if (!line) continue; try { const m = JSON.parse(line); const e = pending.get(m.id); if (e) { pending.delete(m.id); e(m); } } catch {} }
});
child.stderr.on("data", () => {});
const call = (id, method, params) => new Promise((res) => { pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const init = await call(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
console.log("initialize ok:", JSON.stringify(init.result?.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = await call(2, "tools/list", {});
console.log("tools:", JSON.stringify((tools.result?.tools ?? []).map((t) => t.name)));
const r = await call(3, "tools/call", { name: "web_search", arguments: { query: "中国咖啡市场规模 2025" } });
const text = (r.result?.content ?? []).map((c) => c.text ?? "").join("\n");
console.log("RAW RESULT:", text.slice(0, 500));
child.kill();
