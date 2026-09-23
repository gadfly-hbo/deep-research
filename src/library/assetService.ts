import { createHash, randomUUID } from "node:crypto";
import type { DocParser, PageFetcher } from "../adapters/types.js";
import type { DocType, FetchStatus, ReuseScope, Rights } from "./contracts.js";
import type { LibraryStore } from "./types.js";

/** PDF 解析依赖注入(测试用假实现,server 用 unpdf);解析失败不等于取得失败 */
export interface PdfParser {
  parsePdf(bytes: Uint8Array): Promise<{ bodyText: string; parseStatus: "ok" | "failed" }>;
}

export interface RegisterDeps {
  parsePdf?: PdfParser["parsePdf"];
}

export interface FetchDeps {
  page: PageFetcher;
  parser: DocParser;
  /** 测试用:覆盖取得目标以验证 SSRF 在取得路径同样生效 */
  urlOverride?: string;
}

/** WP02 冻结参数(proposal 附录 A):单文件 50MB、单批 20 项 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BATCH_ITEMS = 20;

export interface RegisterFileInput {
  kind: "file";
  filename: string;
  content: string | Uint8Array;
  title?: string;
  publisher?: string;
  docType?: DocType;
  dataPeriod?: string;
  publishedAt?: string;
  projectId?: string;
  reuseScope?: ReuseScope;
  rights?: Rights;
  idempotencyKey?: string;
}

export interface RegisterLinkInput {
  kind: "link";
  url: string;
  title?: string;
  publisher?: string;
  docType?: DocType;
  projectId?: string;
  reuseScope?: ReuseScope;
  rights?: Rights;
  idempotencyKey?: string;
}

export type RegisterInput = RegisterFileInput | RegisterLinkInput;

export interface RegisterOutcome {
  status: "registered" | "duplicate";
  sourceId: string;
  versionId: string;
  acquisitionId: string;
  fetchStatus: FetchStatus;
  parseStatus?: "ok" | "failed" | "partial";
}

export interface BatchItemResult {
  status: "registered" | "duplicate" | "failed";
  sourceId?: string;
  versionId?: string;
  acquisitionId?: string;
  error?: string;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** S-06:入库 URL 只允许公开 http/https;本机/私网/非 Web 协议一律拒绝 */
export function assertPublicUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`URL 无法解析: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅支持 http/https: ${url.protocol}`);
  }
  // URL.hostname 对 IPv6 返回带括号形式([::1]);统一去括号后再判定
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local")) {
    throw new Error(`禁止本机地址: ${host}`);
  }
  if (host.includes(":")) {
    // IPv6:回环/未指定/唯一本地(fc00::/7)/链路本地(fe80::/10)/IPv4 映射(::ffff:x,WHATWG 可能序列化为十六进制) 按私网处理
    const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mappedDotted) {
      assertPublicUrl(`http://${mappedDotted[1]}/`);
      return;
    }
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const quad = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
      assertPublicUrl(`http://${quad}/`);
      return;
    }
    const privateV6 = host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
    if (privateV6) throw new Error(`禁止私网/回环地址: ${host}`);
    return;
  }
  // 点分十进制与纯十进制/十六进制整型写法统一还原为四段再判定
  let quad = host;
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    const n = Number(host);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      quad = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(quad);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const privateIp =
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0;
    if (privateIp) throw new Error(`禁止私网地址: ${host}`);
  }
}

async function registerLink(store: LibraryStore, input: RegisterLinkInput): Promise<RegisterOutcome> {
  assertPublicUrl(input.url);
  if (input.idempotencyKey) {
    const prior = await store.findAcquisitionByIdempotencyKey(input.idempotencyKey);
    if (prior) {
      const version = await store.getVersion(prior.versionId);
      return {
        status: "duplicate",
        sourceId: version?.sourceId ?? "",
        versionId: prior.versionId,
        acquisitionId: prior.acquisitionId,
        fetchStatus: version?.fetchStatus ?? "DISCOVERED",
      };
    }
  }
  // URL 去重:同一入口重复登记不新建来源;按本次上下文另记取得记录(授权不合并,§8.1)
  const existingByUrl = (await store.listSources()).find((s) => s.url === input.url);
  if (existingByUrl) {
    const versions = (await store.versionsForSource(existingByUrl.sourceId)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const latest = versions[versions.length - 1];
    if (latest) {
      const now0 = new Date().toISOString();
      const acquisitionId = newId("aq");
      await store.saveAcquisition({
        acquisitionId,
        versionId: latest.versionId,
        projectId: input.projectId,
        acquiredAt: now0,
        recordedAt: now0,
        method: "user-link",
        readScope: latest.fetchStatus,
        reuseScope: input.reuseScope ?? "PROJECT_ONLY",
        rights: input.rights ?? {},
        idempotencyKey: input.idempotencyKey,
      });
      return {
        status: "duplicate",
        sourceId: existingByUrl.sourceId,
        versionId: latest.versionId,
        acquisitionId,
        fetchStatus: latest.fetchStatus,
      };
    }
  }
  const now = new Date().toISOString();
  const sourceId = newId("s");
  const versionId = newId("sv");
  // 链接登记只保存入口,fetchStatus=DISCOVERED;不读取正文(proposal 流程 A / A-03)
  await store.saveSource({
    sourceId,
    title: input.title ?? input.url,
    url: input.url,
    publisher: input.publisher,
    docType: input.docType ?? "other",
    entityIds: [],
    tags: [],
    lifecycle: "ACTIVE",
    createdAt: now,
  });
  await store.saveVersion({
    versionId,
    sourceId,
    fetchStatus: "DISCOVERED",
    createdAt: now,
  });
  const acquisitionId = newId("aq");
  await store.saveAcquisition({
    acquisitionId,
    versionId,
    projectId: input.projectId,
    acquiredAt: now,
    recordedAt: now,
    method: "user-link",
    readScope: "DISCOVERED",
    reuseScope: input.reuseScope ?? "PROJECT_ONLY",
    rights: input.rights ?? {},
    idempotencyKey: input.idempotencyKey,
  });
  return { status: "registered", sourceId, versionId, acquisitionId, fetchStatus: "DISCOVERED" };
}

const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".json", ".csv", ".log"];

async function registerFile(
  store: LibraryStore,
  input: RegisterFileInput,
  deps: RegisterDeps = {},
): Promise<RegisterOutcome> {
  const bytes = typeof input.content === "string" ? Buffer.byteLength(input.content) : input.content.byteLength;
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`文件超过 50MB 上限(${Math.round(bytes / 1024 / 1024)}MB): ${input.filename}`);
  }
  const lower = input.filename.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isText = TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!isText && !isPdf) {
    throw new Error(`暂不支持的格式(本轮基线 TXT/MD/JSON/CSV/文本PDF): ${input.filename}`);
  }
  if (isPdf && typeof input.content === "string") {
    throw new Error(`PDF 需以字节提交: ${input.filename}`);
  }

  // PDF:先解析再决定入库内容;解析失败如实登记缺口(A-04)
  let stored: string | Uint8Array = input.content;
  let parseStatus: "ok" | "failed" | "partial" | undefined;
  let parseIssue: string | undefined;
  let fetchStatus: FetchStatus = "READ_FULL";
  if (isPdf) {
    if (!deps.parsePdf) throw new Error("PDF 解析器未配置");
    const parsed = await deps.parsePdf(input.content as Uint8Array);
    parseStatus = parsed.parseStatus;
    if (parsed.parseStatus === "ok" && parsed.bodyText.trim()) {
      stored = parsed.bodyText;
    } else {
      // 解析失败:保留原文取得事实,正文缺口明示
      parseIssue = "PDF 文本解析失败或为空(可能为扫描件/复杂表格),原文已取得但正文不可读";
      fetchStatus = "READ_PARTIAL";
      stored = input.content;
    }
  }
  const contentHash = sha256(stored);

  // 重试去重优先于内容去重(同一幂等键返回原登记)
  if (input.idempotencyKey) {
    const prior = await store.findAcquisitionByIdempotencyKey(input.idempotencyKey);
    if (prior) {
      return {
        status: "duplicate",
        sourceId: (await store.getVersion(prior.versionId))?.sourceId ?? "",
        versionId: prior.versionId,
        acquisitionId: prior.acquisitionId,
        fetchStatus: "READ_FULL",
      };
    }
  }

  // 精确内容去重(U2-07):同内容复用已有版本/存储,但本次取得记录独立(授权不合并,§8.1/S-02)
  const existing = await store.findVersionByHash(contentHash);
  if (existing) {
    const sameContext = (await store.acquisitionsForVersion(existing.versionId)).find(
      (a) =>
        a.projectId === input.projectId &&
        a.method === "user-file" &&
        JSON.stringify(a.rights) === JSON.stringify(input.rights ?? {}),
    );
    if (sameContext) {
      return {
        status: "duplicate",
        sourceId: existing.sourceId,
        versionId: existing.versionId,
        acquisitionId: sameContext.acquisitionId,
        fetchStatus: existing.fetchStatus,
        parseStatus: existing.parseStatus,
      };
    }
    const nowDup = new Date().toISOString();
    const acquisitionId = newId("aq");
    await store.saveAcquisition({
      acquisitionId,
      versionId: existing.versionId,
      projectId: input.projectId,
      acquiredAt: nowDup,
      recordedAt: nowDup,
      method: "user-file",
      readScope: fetchStatus,
      reuseScope: input.reuseScope ?? "PROJECT_ONLY",
      rights: input.rights ?? {},
      idempotencyKey: input.idempotencyKey,
    });
    return {
      status: "duplicate",
      sourceId: existing.sourceId,
      versionId: existing.versionId,
      acquisitionId,
      fetchStatus: existing.fetchStatus,
      parseStatus: existing.parseStatus,
    };
  }

  const now = new Date().toISOString();
  const stagingId = await store.stageContent(
    typeof stored === "string" ? stored : Buffer.from(stored),
  );
  const { contentRef } = await store.commitContent(stagingId);
  const sourceId = newId("s");
  const versionId = `sv-${contentHash.slice(0, 12)}`;
  await store.saveSource({
    sourceId,
    title: input.title ?? input.filename.replace(/\.[^.]+$/, ""),
    publisher: input.publisher,
    docType: input.docType ?? "other",
    entityIds: [],
    tags: [],
    lifecycle: "ACTIVE",
    createdAt: now,
  });
  await store.saveVersion({
    versionId,
    sourceId,
    contentRef,
    contentHash,
    fetchStatus,
    parseStatus,
    parseIssue,
    publishedAt: input.publishedAt,
    dataPeriod: input.dataPeriod,
    createdAt: now,
  });
  const acquisitionId = newId("aq");
  await store.saveAcquisition({
    acquisitionId,
    versionId,
    projectId: input.projectId,
    acquiredAt: now,
    recordedAt: now,
    method: "user-file",
    readScope: fetchStatus,
    reuseScope: input.reuseScope ?? "PROJECT_ONLY",
    rights: input.rights ?? {},
    idempotencyKey: input.idempotencyKey,
  });
  return { status: "registered", sourceId, versionId, acquisitionId, fetchStatus, parseStatus };
}

/** register_asset(proposal §12.2):入口登记不等于正文读取成功;逐项状态由批量层组装 */
export async function registerAsset(
  store: LibraryStore,
  input: RegisterInput,
  deps: RegisterDeps = {},
): Promise<RegisterOutcome> {
  return input.kind === "link" ? registerLink(store, input) : registerFile(store, input, deps);
}

/**
 * 对已登记链接执行正文取得(proposal 流程 A:取得与解析分开记录)。
 * 成功产生新的内容版本(原 DISCOVERED 版本保留,历史不改写);失败如实登记 UNAVAILABLE。
 */
export async function fetchAssetContent(
  store: LibraryStore,
  registeredVersionId: string,
  deps: FetchDeps,
): Promise<{ versionId: string; sourceId: string; fetchStatus: FetchStatus }> {
  const registered = await store.getVersion(registeredVersionId);
  if (!registered) throw new Error(`版本不存在: ${registeredVersionId}`);
  const source = await store.getSource(registered.sourceId);
  if (!source) throw new Error(`来源不存在: ${registered.sourceId}`);
  const target = deps.urlOverride ?? source.url ?? "";
  if (!target) throw new Error(`来源无 URL,无法取得: ${source.sourceId}`);
  assertPublicUrl(target);

  const now = new Date().toISOString();
  const versionId = newId("sv");
  const page = await deps.page.fetch(target, `library-fetch-${versionId}`);
  // S-06:重定向后的最终地址同样过边界;体积超上限按不可得登记
  if (page.finalUrl) assertPublicUrl(page.finalUrl);
  const bodySize = page.text?.length ?? page.html?.length ?? page.pdf?.byteLength ?? 0;
  if (bodySize > MAX_FILE_BYTES) {
    await store.saveVersion({
      versionId,
      sourceId: source.sourceId,
      fetchStatus: "UNAVAILABLE",
      parseStatus: "failed",
      parseIssue: `正文超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限,未保存`,
      createdAt: now,
    });
    return { versionId, sourceId: source.sourceId, fetchStatus: "UNAVAILABLE" };
  }
  // 取得记录继承登记上下文(项目/权利),避免授权在取得时丢失
  const priorAcquisitions = await store.acquisitionsForVersion(registeredVersionId);
  const inherited = priorAcquisitions[priorAcquisitions.length - 1];
  if (page.error || (page.status >= 400 && !page.text && !page.html && !page.pdf)) {
    await store.saveVersion({
      versionId,
      sourceId: source.sourceId,
      fetchStatus: "UNAVAILABLE",
      parseStatus: "failed",
      parseIssue: `取得失败: HTTP ${page.status} ${page.error ?? ""}`.trim(),
      createdAt: now,
    });
    await store.saveAcquisition({
      acquisitionId: newId("aq"),
      versionId,
      projectId: inherited?.projectId,
      acquiredAt: now,
      recordedAt: now,
      method: "user-link",
      readScope: "UNAVAILABLE",
      reuseScope: inherited?.reuseScope ?? "PROJECT_ONLY",
      rights: inherited?.rights ?? {},
    });
    return { versionId, sourceId: source.sourceId, fetchStatus: "UNAVAILABLE" };
  }
  const parsed = await deps.parser.parse(page, `library-parse-${versionId}`);
  const ok = parsed.parseStatus === "ok" && parsed.bodyText.trim() !== "";
  const stagingId = await store.stageContent(ok ? parsed.bodyText : (page.text ?? page.html ?? ""));
  const { contentRef, contentHash } = await store.commitContent(stagingId);
  await store.saveVersion({
    versionId,
    sourceId: source.sourceId,
    contentRef,
    contentHash,
    fetchStatus: ok ? "READ_FULL" : "READ_PARTIAL",
    parseStatus: parsed.parseStatus,
    parseIssue: ok ? undefined : "正文解析不完整或为空",
    createdAt: now,
  });
  await store.saveAcquisition({
    acquisitionId: newId("aq"),
    versionId,
    projectId: inherited?.projectId,
    acquiredAt: now,
    recordedAt: now,
    method: "user-link",
    readScope: ok ? "READ_FULL" : "READ_PARTIAL",
    reuseScope: inherited?.reuseScope ?? "PROJECT_ONLY",
    rights: inherited?.rights ?? {},
  });
  return { versionId, sourceId: source.sourceId, fetchStatus: ok ? "READ_FULL" : "READ_PARTIAL" };
}

/** 批量导入:逐项状态(成功/重复/失败),不用一个"全部完成"掩盖部分失败(proposal §5.1) */
export async function registerAssets(
  store: LibraryStore,
  inputs: RegisterInput[],
  deps: RegisterDeps = {},
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = [];
  for (const [i, input] of inputs.entries()) {
    if (i >= MAX_BATCH_ITEMS) {
      results.push({ status: "failed", error: `超过单批 ${MAX_BATCH_ITEMS} 项上限,请分批提交` });
      continue;
    }
    try {
      const out = await registerAsset(store, input, deps);
      results.push({
        status: out.status,
        sourceId: out.sourceId,
        versionId: out.versionId,
        acquisitionId: out.acquisitionId,
      });
    } catch (err) {
      results.push({ status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
