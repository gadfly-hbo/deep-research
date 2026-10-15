import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { buildExportFilesV2, zipExport } from "../../app/exportBundle.js";
import { generateFormal } from "../../app/projectService.js";
import { json } from "./http.js";
import type { Ctx } from "./http.js";

// P1-3 T3:versions 域(附录 A 第 13–17 项:versions 子树 4 端点 + snapshots)。
// 由 projectsRuns 域在验 id 之后委托(R2-1);HTTP 行为与拆分前逐位一致。
// T5:Ctx 已迁至 routes/http.ts。

export interface VersionRouteInput {
  id: string;
  dir: string;
  rest: string;
  url: URL;
  method: string;
}

/** 返回 true=已处理;false=落回(本域未匹配的子路径最终由 server.ts catch-all 404)。 */
export const handleVersionRoutes = async (
  ctx: Ctx,
  res: ServerResponse,
  { id, dir, rest, url, method }: VersionRouteInput,
): Promise<boolean> => {
  const versionMatch = rest.match(/^\/versions\/(\d+)(\/.*)?$/);
  if (versionMatch) {
    const [, vRaw, vRest = ""] = versionMatch;
    const v = Number(vRaw);
    const bundlePath = join(dir, "reports", `v${v}`, "bundle.json");
    if (!existsSync(bundlePath)) {
      json(res, 404, { error: `版本不存在: v${v}` });
      return true;
    }

    // 生成正式报告(幂等:重新生成覆盖旧产物)
    if (method === "POST" && vRest === "/formal") {
      json(res, 200, await generateFormal(dir, v, ctx.makeAdapters().model));
      return true;
    }

    if (method === "GET" && vRest === "/bundle") {
      json(res, 200, JSON.parse(readFileSync(bundlePath, "utf8")));
      return true;
    }

    const formalMatch = vRest.match(/^\/formal\/(html|pptx|json)$/);
    if (method === "GET" && formalMatch) {
      const formalDir = join(dir, "reports", `v${v}`, "formal");
      const file =
        formalMatch[1] === "html"
          ? { path: join(formalDir, "report.html"), type: "text/html; charset=utf-8", name: `research-v${v}.html` }
          : formalMatch[1] === "pptx"
            ? {
                path: join(formalDir, "report.pptx"),
                type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                name: `research-v${v}.pptx`,
              }
            : { path: join(formalDir, "formal.json"), type: "application/json; charset=utf-8", name: `research-v${v}-formal.json` };
      if (!existsSync(file.path)) {
        json(res, 404, { error: `正式报告尚未生成: v${v}(先 POST /versions/${v}/formal)` });
        return true;
      }
      const buf = readFileSync(file.path);
      res.writeHead(200, {
        "content-type": file.type,
        "content-disposition": `${formalMatch[1] === "json" ? "inline" : "attachment"}; filename="${file.name}"`,
      });
      res.end(buf);
      return true;
    }

    if (method === "GET" && vRest === "/export") {
      const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      const files = await buildExportFilesV2(bundle, { library: ctx.library, runId: bundle.runId });
      const formalDir = join(dir, "reports", `v${v}`, "formal");
      if (existsSync(formalDir)) {
        files.push({
          path: "formal/report.html",
          content: readFileSync(join(formalDir, "report.html"), "utf8"),
        });
        files.push({
          path: "formal/report.pptx",
          content: new Uint8Array(readFileSync(join(formalDir, "report.pptx"))),
        });
        files.push({
          path: "formal/formal.json",
          content: readFileSync(join(formalDir, "formal.json"), "utf8"),
        });
      }
      const zipped = zipExport(files);
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="research-v${v}.zip"`,
      });
      res.end(Buffer.from(zipped));
      return true;
    }

    // versionMatch 命中但子路径未匹配(如 GET /versions/:v 裸路径):落回,最终 catch-all 404
    return false;
  }

  if (method === "GET" && rest === "/snapshots") {
    const sid = url.searchParams.get("sid") ?? "";
    // P0-2:单文件读(哈希→精确文件名,原始 sid 永不拼路径)
    const snapshot = await ctx.storeFor(id).readSnapshot(sid);
    if (!snapshot) {
      json(res, 404, { error: `快照不存在: ${sid}` });
      return true;
    }
    // 只回传净化后的纯文本正文,来源 HTML 永不下发(06 数据与工具权限)
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(snapshot.bodyText);
    return true;
  }

  return false;
};
