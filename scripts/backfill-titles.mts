/* 存量资产标题可读化回填:C 重新抓取网页真标题(<title>/og:title)→ B 有正文时模型概括 → 都不行保留现标题。
 * 用法:bash scripts/with-minimax-env.sh npx tsx scripts/backfill-titles.mts
 * 只改 research-data/library/sources.json 的 title 字段;不触碰版本与快照。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { defaultDataDir } from "../src/app/dataDir.js";
import { cleanPageTitle, livePage, liveParser } from "../src/adapters/live.js";

const dir = defaultDataDir();
const libDir = join(dir, "library");
const sourcesPath = join(libDir, "sources.json");
const versions = JSON.parse(readFileSync(join(libDir, "versions.json"), "utf8")) as Record<string, any>;
const sources = JSON.parse(readFileSync(sourcesPath, "utf8")) as Record<string, any>;

const page = livePage();
const parser = liveParser();
const model = getBuiltinModel("minimax-cn", "MiniMax-M3") as never;
const apiKey = process.env.MINIMAX_CN_API_KEY ?? "";
// MiniMax-M3 builtin api 是 anthropic-messages(踩过:硬编码 openai-completions 会 404);按模型 api 动态选流模块
const streamMod = model.api === "anthropic-messages"
  ? await import("@earendil-works/pi-ai/api/anthropic-messages")
  : await import("@earendil-works/pi-ai/api/openai-completions");
const streamSimple = streamMod.streamSimple;

async function modelTitle(bodyText: string): Promise<string | undefined> {
  try {
    const messages = (await runAgentLoop(
      [{
        role: "user",
        content: [{ type: "text", text: `根据以下网页正文,起一个不超过 20 字的简体中文标题,概括主题。只输出标题本身,不要书名号、引号、句号或任何解释。\n\n正文:\n${bodyText.slice(0, 500)}` }],
        timestamp: Date.now(),
      }] as never[],
      { messages: [] },
      {
        model, apiKey, maxRetries: 1, maxRetryDelayMs: 3_000,
        convertToLlm: (messages: { role?: string }[]) =>
          messages.filter(
            (m): m is Message => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
          ),
      } as never,
      () => {},
      AbortSignal.timeout(45_000) as never,
      streamSimple as never,
    )) as { role?: string; content?: unknown }[];
    const text = messages.filter((m) => m.role === "assistant").map((m) => contentText(m.content as never)).join("").trim();
    const t = text.replace(/^[「『《"']+/g, "").replace(/[」』》"'.。]+$/g, "").trim();
    return t.length >= 4 && t.length <= 30 && !/^[{[]/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

let viaFetch = 0;
let viaModel = 0;
let kept = 0;
const entries = Object.values(sources);
for (let i = 0; i < entries.length; i++) {
  const s = entries[i];
  const current: string = s.title ?? "";
  let next: string | undefined;
  let how = "kept";
  // C:重新抓取取真标题
  try {
    const p = await page.fetch(s.url ?? "", `backfill:${s.sourceId}`);
    const doc = await parser.parse(p, `backfill:${s.sourceId}`);
    next = cleanPageTitle(doc.title);
    if (next) how = "fetch";
  } catch {
    /* 抓取失败,落 B */
  }
  // B:有存量正文时模型概括
  if (!next) {
    const vers = Object.values(versions).filter((v) => v.sourceId === s.sourceId);
    const latest = vers.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    const ref: string | undefined = latest?.contentRef;
    if (ref) {
      try {
        const body = readFileSync(join(libDir, ref), "utf8");
        if (body.trim().length >= 40) {
          next = await modelTitle(body);
          if (next) how = "model";
        }
      } catch {
        /* 无正文文件 */
      }
    }
  }
  if (next) s.title = next;
  if (how === "fetch") viaFetch++;
  else if (how === "model") viaModel++;
  else kept++;
  process.stdout.write(`[${i + 1}/${entries.length}] ${current.slice(0, 26)} → ${(s.title ?? "").slice(0, 32)}\n`);
  await new Promise((r) => setTimeout(r, 350));
}

writeFileSync(sourcesPath, JSON.stringify(sources, null, 2), "utf8");
console.log(`完成:共 ${entries.length} 条 — 重抓真标题 ${viaFetch},模型概括 ${viaModel},保留原样 ${kept}`);
