#!/usr/bin/env node
// 假 MCP stdio 服务器:实现 initialize / tools/list / tools/call(web_search),返回固定搜索结果。
let buffer = Buffer.alloc(0);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-search", version: "0.0.0" } } });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "web_search", description: "Search the web (MiniMax)", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] } });
    return;
  }
  if (msg.method === "tools/call" && msg.params?.name === "web_search") {
    if (String(msg.params?.arguments?.query ?? "").includes("quota")) {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Failed to perform search: API Error: 2067-quota" }] } });
      return;
    }
    const results = [
      { url: "https://a.example/report", title: "中国咖啡市场规模报告", snippet: "中国咖啡市场规模约 1,200 亿元(2025 年)。" },
      { url: "https://b.example/news", title: "现磨咖啡门店数增长", snippet: "2025 年现磨咖啡门店约 12 万家。" },
    ];
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(results) }] } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method: ${msg.method}` } });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const nl = buffer.indexOf(0x0a);
    if (nl < 0) return;
    const line = buffer.subarray(0, nl).toString("utf8").trim();
    buffer = buffer.subarray(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore malformed */ }
  }
});
