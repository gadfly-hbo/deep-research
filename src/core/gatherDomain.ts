/* P2-6(D4/R1-6/KA4):gather 域——自 runResearch 纯移动(gather 函数+applyInstruction+
   investigationCard+工具构造+证据归属);GatherContext 单对象传引用(数据字段传引用非
   复制,持久化/事件回调由装配层以函数字段挂入);本拆分 commit 零断言改动(纪律)。 */
import type { Adapters, AgentTool, ModelProvider } from "../adapters/types.js";
import { assertPublicUrl } from "../library/assetService.js";
import { tierOfSource } from "../quality/sourceTier.js";
import { parseJsonLoose } from "../adapters/modelText.js";
import type { Budget, Intervention, ResearchRequest, ResearchResultBundle, ResearchRun, SourceSnapshot } from "../contracts.js";
import type { ModuleConfig } from "../modules/types.js";
import type { InvestigationEvent, ResearchStore } from "../stores/types.js";
import { addLimitation } from "./limitations.js";
import { snapshotFrom } from "./snapshotFrom.js";
import { BudgetTracker } from "./budgetTracker.js";
import { attachExtraction, attachGatherExtraction } from "./attachExtraction.js";
import type { PlanQuestion } from "./stages.js";
import type { RunState } from "./runState.js";
import type { RunOptions } from "./runResearch.js";

export interface GatherContext {
  /* —— 数据(传引用非复制;变更对装配层立即可见)—— */
  state: RunState;
  run: ResearchRun;
  budget: Budget;
  tracker: BudgetTracker;
  request: ResearchRequest;
  moduleConfig: ModuleConfig;
  keyBase: string;
  adapters: Adapters;
  model: ModelProvider;
  store: ResearchStore;
  baseBundle: ResearchResultBundle | null;
  baseSnapshotUrls: Set<string>;
  sessionDigests: string[];
  snapshotVersionMap: Map<string, string>;
  /** P2-4(C4):调查归属映射——qid→该问抓取过的 sid 集合。 */
  fetchedByQ: Map<string, Set<string>>;
  snapshotsBySid: Map<string, SourceSnapshot>;
  /* —— 三个原 let 转 ctx 字段(赋值点原位搬移)—— */
  /** P2-4/2.1:方向附注(问内注入与问间隙指令共同沉淀;进下一问任务卡)。 */
  directionNotes: string[];
  /** 2.1:当前正在采证的问题(syncProgress 进度摘要引用)。 */
  currentQuestion: PlanQuestion | undefined;
  /** 2.1:本轮 gather 的问题清单(add-questions 指令向其尾部追加)。 */
  activeGatherTargets: PlanQuestion[] | null;
  /** 2.1:add-questions 的新问题序号计数。 */
  addQuestionCounter: number;
  /* —— 装配层回调(函数字段挂入;质量回环/门域后行同用)—— */
  cancelled(): boolean;
  pollInstructions?: RunOptions["pollInstructions"];
  takeRefinement?: RunOptions["takeRefinement"];
  /** P2-6(F3):加注到达判据(装配层以运行起始预算基线快照比对同对象变异;缺省按未加注)。 */
  wasToppedUp?: () => boolean;
  /** E1(G1-1):gather 每问收束回调(纯被动切片;capability 取消保留依据)。 */
  onGatherProgress?: RunOptions["onGatherProgress"];
  persistRun(stage?: ResearchRun["stage"]): Promise<void>;
  persistUsageThrottled(): Promise<void>;
  appendInvestigationSafe(event: Omit<InvestigationEvent, "seq" | "at">): Promise<void>;
  ingestToLibrary(snapshot: SourceSnapshot): Promise<void>;
}

const TOOL_DEFINITIONS = {
  webSearch: {
    name: "web_search",
    description:
      "联网搜索:输入搜索词,返回命中列表(url/标题/摘要);base=true 表示基准研究已有该页快照,勿重抓。",
    effect: "external" as const,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索词" } },
      required: ["query"],
    },
  },
  fetchPage: {
    name: "fetch_page",
    description:
      "抓取公开网页并留存快照:返回净化正文摘录(≤6KB)与快照 id;仅公开 http/https,私网/本机地址会被拒绝。",
    effect: "external" as const,
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "要抓取的页面地址" } },
      required: ["url"],
    },
  },
  readSnapshot: {
    name: "read_snapshot",
    description: "分页读取本 run 已有快照正文(offset/limit,每页 ≤6KB;每问至多 8 次),用于复核已抓材料原文。",
    effect: "read" as const,
    parameters: {
      type: "object",
      properties: {
        sid: { type: "string", description: "快照 id" },
        offset: { type: "integer", description: "起始字符偏移(缺省 0)" },
        limit: { type: "integer", description: "读取长度上限(≤6144)" },
      },
      required: ["sid"],
    },
  },
};

/** P2-4(D1):按字节截断摘录(摘录/分页两层截断之一;尾部残缺代理对丢弃)。 */
const clipExcerpt = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\ufffd+$/, "");
};

const EXCERPT_MAX_BYTES = 6 * 1024;
const READ_PER_QUESTION_LIMIT = 8;

/**
 * P2-4(R1-5):调查任务卡——固定六段,常量级篇幅;预算余量为调用时静态快照
 * (只进 prompt 不进 configuration,R1-1);不用 claims(未过 review)。
 */
const investigationCard = (ctx: GatherContext, q: PlanQuestion, perQuestion: number): string => {
  const answered = ctx.state.questions
    .filter((x) => x.status === "answered" || x.status === "partially")
    .map((x) => x.question);
  const baseUrls = ctx.baseBundle?.snapshots.map((s) => s.url) ?? [];
  const fold = (items: string[], sep: string, max: number): string =>
    items.length === 0 ? "无" : `${items.slice(0, max).join(sep)}${items.length > max ? ` 等 ${items.length} 项` : ""}`;
  return [
    `【研究问题】${q.question}`,
    `【方向附注】${ctx.directionNotes.length ? ctx.directionNotes.join(";") : "无"}`,
    `【研究目标与范围】${ctx.request.goal}(${ctx.request.scope.summary})`,
    `【已答问题】${fold(answered, " / ", 8)}`,
    ...(ctx.sessionDigests.length
      ? [`【既往研究纪要】(叙事补充;与基准统计不一致时,以基准数据为准)\n${ctx.sessionDigests
          .slice(0, 3)
          .map((d, i) => `${i + 1}. ${d}`)
          .join("\n")}`]
      : []),
    `【已有快照(勿重抓)】${fold(baseUrls, " ; ", 8)}`,
    `【证据规则】本产品关键结论必须逐条绑定已抓取页面的原文快照——搜索摘要只是发现线索,不构成证据。判定 sufficient=true 的前提:你已 fetch_page 抓取并阅读了足以支撑本问结论的页面(通常 ≥2 个独立来源);只凭搜索摘要判定"充分"将被评审打回。`,
    `【预算余量】搜索 ${Math.max(0, ctx.budget.maxSearches - ctx.run.usage.searches)} 次 / 抓取 ${Math.max(
      0,
      ctx.budget.maxFetches - ctx.run.usage.fetches,
    )} 次(本问抓取上限 ${perQuestion});余量以工具返回为准,用尽会收到错误提示`,
    `【输出契约】调查结束后停止调用工具,只输出 JSON:{"sufficient":boolean,"note":"一句话结论口径"}`,
  ].join("\n");
};

// --- 2.1 执行中干预:问题间隙消费指令,不打断进行中的调用
//    (三个可变态 directionNotes/activeGatherTargets/addQuestionCounter 为 ctx 字段,装配层初始化) ---
/** 应用一条指令;返回 true 表示当前问题被跳过(调用方应 continue)。 */
const applyInstruction = async (ctx: GatherContext, pending: Intervention): Promise<boolean> => {
  const ins = pending.instruction;
  const finish = (effect: "applied" | "invalid" | "failed", detail?: string): false => {
    pending.consumedAt = new Date().toISOString();
    pending.effect = effect;
    if (detail) pending.detail = detail;
    (ctx.run.interventions ??= []).push(pending);
    return false;
  };
  if (ins.type === "skip-question") {
    const target = ins.questionId ? ctx.state.questions.find((q) => q.id === ins.questionId) : ctx.currentQuestion;
    if (!target) return finish("invalid", "找不到目标问题");
    if (target.status === "answered" || target.status === "partially") {
      return finish("invalid", `问题 ${target.id} 已回答(${target.status}),不可跳过`);
    }
    target.status = "skipped";
    const skipNote = `问题被用户跳过:${target.question}`;
    if (!ctx.state.unresolved.includes(skipNote)) ctx.state.unresolved.push(skipNote);
    const skippedCurrent = target === ctx.currentQuestion;
    finish("applied", `问题 ${target.id} 已跳过`);
    return skippedCurrent;
  }
  if (ins.type === "add-questions") {
    ins.questions.forEach((text) => {
      ctx.addQuestionCounter += 1;
      const q: PlanQuestion = { id: `q-ins-${ctx.addQuestionCounter}`, question: text, status: "open" };
      ctx.state.questions.push(q);
      ctx.activeGatherTargets?.push(q);
    });
    return finish("applied", `新增 ${ins.questions.length} 个问题`);
  }
  if (ins.type === "refine-direction") {
    ctx.directionNotes.push(ins.note);
    return finish("applied", "方向附注已注入剩余问题的搜索");
  }
  // add-source:挂到当前问题(或最相关 open 问题),失败不中断
  const host = ctx.currentQuestion ?? ctx.state.questions.find((q) => q.status === "open");
  if (!host) return finish("invalid", "没有可挂接的开放问题");
  try {
    let snapshot: SourceSnapshot;
    if (ins.url) {
      // 2.1:同 URL 已有快照直接复用,避免覆盖项目级快照正文导致旧证据引文漂移
      const existing = ctx.state.snapshots.find((s) => s.url === ins.url);
      if (existing) {
        snapshot = existing;
      } else {
        const page = await ctx.adapters.page.fetch(ins.url, `${ctx.keyBase}:instruct:fetch:${pending.id}`);
        if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
        const doc = await ctx.adapters.parser.parse(page, `${ctx.keyBase}:instruct:parse:${pending.id}`);
        snapshot = snapshotFrom({
          id: `snap:${ins.url}`,
          url: ins.url,
          title: ins.title ?? ins.url,
          bodyText: doc.bodyText,
          parseStatus: doc.parseStatus,
          contentType: page.contentType,
        });
      }
    } else {
      snapshot = snapshotFrom({
        id: `snap:user-text:${pending.id}`,
        url: `user-text://${pending.id}`,
        title: ins.title ?? "用户补充材料",
        bodyText: ins.text ?? "",
        parseStatus: "ok",
        contentType: "text/plain",
      });
    }
    await ctx.store.saveSnapshot(snapshot);
    await ctx.ingestToLibrary(snapshot);
    const extracted = await ctx.model.extractClaims({ snapshot }, `${ctx.keyBase}:instruct:model:${pending.id}`);
    if (!ctx.state.snapshots.some((s) => s.id === snapshot.id)) ctx.state.snapshots.push(snapshot);
    attachExtraction(ctx.state, snapshot, extracted, {
      kind: "question",
      qid: host.id,
      infix: "ins",
      versionId: ctx.snapshotVersionMap.get(snapshot.id),
    });
    return finish("applied", `补充信源已入证据链(${snapshot.url}),挂接问题 ${host.id}`);
  } catch (error) {
    const note = `补充信源取得失败(${ins.url ?? "文本"}):${error instanceof Error ? error.message : String(error)}`;
    addLimitation(ctx.state.limitations, note);
    return finish("failed", note);
  }
};

const consumeInstructions = async (ctx: GatherContext): Promise<boolean> => {
  if (!ctx.pollInstructions) return false;
  let skippedCurrent = false;
  // 每个消费点拉取一次;pollInstructions 应一次返回全部新指令(队列 drain 语义)
  const batch = await ctx.pollInstructions();
  for (const pending of batch) {
    if (await applyInstruction(ctx, pending)) skippedCurrent = true;
  }
  if (batch.length > 0) await ctx.persistRun();
  return skippedCurrent;
};

/** P2-6(F3/R1-4):加注评估点复位半段——真实加注到达(基线快照可证预算被增)+全量程预算
 *  均有余量(容量已恢复)→复位 capped。R1-4 原文以 canSearch() 为准;REVIEW F3 收紧两处:
 *  ①须有真实加注(v1 恢复的 capped 无配额成因,余量探测会误复位);②抓取触顶的 run 搜索
 *  配额常仍有余量,canSearch-only 会误复位。墙钟延长但搜索配额尽→不复位(现语义)。 */
export const resetCappedIfToppedUp = (
  ctx: Pick<GatherContext, "state" | "tracker" | "budget" | "run" | "wasToppedUp">,
): boolean => {
  if (!ctx.state.capped) return false;
  if (!ctx.wasToppedUp?.()) return false;
  if (!ctx.tracker.canSearch()) return false;
  if (ctx.run.usage.fetches >= ctx.budget.maxFetches) return false;
  ctx.state.capped = false;
  return true;
};

/** P2-6(F3/R1-4):同款扫描——复位 + 配额饿死问题重标 open+清成因并返回(调用方决定重开时机)。 */
export const scanTopupReopen = (
  ctx: Pick<GatherContext, "state" | "tracker" | "budget" | "run" | "wasToppedUp">,
): PlanQuestion[] => {
  if (!resetCappedIfToppedUp(ctx)) return [];
  const starved = ctx.state.questions.filter(
    (x) => x.status === "unanswered" && x.unansweredReason === "quota-starved",
  );
  for (const q of starved) {
    q.status = "open";
    q.unansweredReason = undefined;
  }
  return starved;
};

export const gather = async (ctx: GatherContext, round: number, targets?: PlanQuestion[]): Promise<void> => {
  const questions = targets ?? ctx.state.questions.filter((q) => q.status === "open");
  ctx.activeGatherTargets = questions;
  // P2-6(R1-4):加注评估点收集的重开问题——循环末尾递归补采(新一轮次 taskId)
  const reopened: PlanQuestion[] = [];
  try {
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const q = questions[qIdx];
      // 2.1:被用户跳过的问题(含指令指向的后续问题)不再采证,状态不被覆盖
      if (q.status === "skipped") continue;
      ctx.currentQuestion = q;
      if (ctx.cancelled()) return;
      // 2.1:问题间隙消费干预指令(D2:问启动前 drain,skip/add/refine 零漂移)
      if (await consumeInstructions(ctx)) continue;
      // P2-6(R1-4):加注评估点——复位 capped,配额饿死问题收集后循环末尾递归重开
      reopened.push(...scanTopupReopen(ctx));
      if (!ctx.tracker.canSearch()) {
        ctx.state.capped = true;
        if (q.status === "open") {
          q.status = "unanswered";
          q.unansweredReason = "quota-starved";
        }
        continue;
      }
      // 补采/重采前清掉该问题的旧主张与证据,受影响分支被重算(现状语义,D3)
      const staleClaimIds = ctx.state.claims
        .filter((c) => ctx.state.claimQuestions[c.id] === q.id)
        .map((c) => c.id);
      ctx.state.claims = ctx.state.claims.filter((c) => ctx.state.claimQuestions[c.id] !== q.id);
      ctx.state.evidence = ctx.state.evidence.filter((e) => !e.id.startsWith(`ev:${q.id}:`));
      for (const cid of staleClaimIds) delete ctx.state.claimQuestions[cid];

      // --- P2-4(D2):runAgent 全自主调查;通道缺席(旧夹具路径)按不支持降级,ctx.run 不死 ---
      if (!ctx.model.runAgent) {
        addLimitation(ctx.state.limitations, `问题「${q.question}」的模型通道不支持自主调查,该问未采证`);
        q.status = "unanswered";
        await ctx.appendInvestigationSafe({
          qid: q.id,
          kind: "verdict",
          summary: "未采证(通道不支持自主调查)",
          sufficient: false,
        });
        await ctx.persistRun();
        continue;
      }
      // 单问软顶(KA5):fetchQuota 按剩余问题均分保留(补证轮有预算的公平性)
      const remainingQuestions = questions.length - qIdx;
      const perQuestion = ctx.tracker.fetchQuota(remainingQuestions);
      let searchN = 0;
      let fetchN = 0;
      let readN = 0;
      let fetchedForQ = 0;
      let allBaseHits = false;
      const errMsgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

      // --- 工具三件(D1:executor 闭包捕获 qid/轮次/软顶计数;定义轮次不变) ---
      const webSearch: AgentTool = {
        ...TOOL_DEFINITIONS.webSearch,
        execute: async (args) => {
          searchN += 1;
          const query = String(args.query ?? "");
          if (ctx.tracker.overBudget()) {
            ctx.state.capped = true;
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "query", summary: query, query, note: "配额已尽(墙钟),未执行" });
            return { error: "budget-exhausted", note: "墙钟预算已到,请立即收束并输出结论" };
          }
          if (ctx.run.usage.searches >= ctx.budget.maxSearches) {
            ctx.state.capped = true;
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "query", summary: query, query, note: "配额已尽(搜索),未执行" });
            return { error: "search-quota-exhausted", note: "全局搜索配额已用尽,请基于已有材料收束" };
          }
          try {
            // P2-6(R1-5):问内 refine 即时注入——filtered take 只消费 refine-direction
            // (skip/add 留队给问间隙 drain);三步:interventions 记录→ctx.directionNotes
            // 沉淀(下一问任务卡)→工具返回值 prepend note(prompt 轮次注入)
            let refineNote: string | undefined;
            const refinement = ctx.takeRefinement?.() ?? null;
            if (refinement && refinement.instruction.type === "refine-direction") {
              const refineText = refinement.instruction.note;
              (ctx.run.interventions ??= []).push({
                ...refinement,
                consumedAt: new Date().toISOString(),
                effect: "applied",
                detail: "问内即时注入",
              });
              ctx.directionNotes.push(refineText);
              refineNote = `方向调整:${refineText}`;
            }
            const hits = await ctx.adapters.search.search(
              query,
              `${ctx.keyBase}:gather:r${round}:a:${q.id}:search:${searchN}`,
            );
            ctx.run.usage.searches += 1;
            await ctx.persistUsageThrottled();
            if (hits.length > 0) allBaseHits = hits.every((h) => ctx.baseSnapshotUrls.has(h.url));
            const baseHits = hits.filter((h) => ctx.baseSnapshotUrls.has(h.url)).length;
            await ctx.appendInvestigationSafe({
              qid: q.id,
              kind: "query",
              summary: query,
              query,
              note: `命中 ${hits.length}${baseHits > 0 ? `(基准已有 ${baseHits},勿重抓)` : ""}${refineNote ? ` · ${refineNote}` : ""}`,
            });
            return {
              hits: hits.map((h) => ({
                url: h.url,
                title: h.title,
                snippet: h.snippet,
                ...(ctx.baseSnapshotUrls.has(h.url) ? { base: true } : {}),
              })),
              ...(refineNote ? { note: refineNote } : {}),
            };
          } catch (error) {
            addLimitation(ctx.state.limitations, `问题「${q.question}」的搜索调用失败:${errMsgOf(error)}`);
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "query", summary: query, query, note: `搜索失败:${errMsgOf(error)}` });
            return { error: "search-failed", note: `搜索服务不可用:${errMsgOf(error)}` };
          }
        },
      };

      const fetchPage: AgentTool = {
        ...TOOL_DEFINITIONS.fetchPage,
        execute: async (args) => {
          fetchN += 1;
          const url = String(args.url ?? "");
          if (ctx.tracker.overBudget()) {
            ctx.state.capped = true;
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "fetch", summary: `抓取未执行:${url}`, url, note: "配额已尽(墙钟)" });
            return { error: "budget-exhausted", note: "墙钟预算已到,请立即收束并输出结论" };
          }
          if (fetchedForQ >= perQuestion) {
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "fetch", summary: `抓取未执行:${url}`, url, note: `本问上限 ${perQuestion} 次` });
            return { error: "question-quota-exhausted", note: `本问抓取已达上限(${perQuestion} 次),请基于已有材料收束` };
          }
          if (ctx.tracker.fetchRoom(perQuestion, fetchedForQ) <= 0) {
            ctx.state.capped = true;
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "fetch", summary: `抓取未执行:${url}`, url, note: "全局抓取配额已尽" });
            return { error: "fetch-quota-exhausted", note: "全局抓取配额已用尽,请基于已有材料收束" };
          }
          // C3:SSRF 边界——直接地址与重定向终址都过 assertPublicUrl(硬性前置)
          try {
            assertPublicUrl(url);
          } catch {
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "fetch", summary: `抓取被拒绝:${url}`, url, note: "仅公开 http/https" });
            return { error: "url-rejected", note: `地址被拒绝(仅公开 http/https): ${url}` };
          }
          try {
            const page = await ctx.adapters.page.fetch(url, `${ctx.keyBase}:gather:r${round}:a:${q.id}:fetch:${fetchN}`);
            if (page.finalUrl) {
              try {
                assertPublicUrl(page.finalUrl);
              } catch {
                await ctx.appendInvestigationSafe({ qid: q.id, kind: "fetch", summary: `抓取被拒绝:${url}`, url, note: `重定向目标被拒绝:${page.finalUrl}` });
                return { error: "url-rejected", note: `重定向目标被拒绝: ${page.finalUrl}` };
              }
            }
            if (page.error || page.status !== 200) {
              await ctx.appendInvestigationSafe({ qid: q.id, kind: "fetch", summary: `抓取失败:${url}`, url, note: `HTTP ${page.status}` });
              return { error: "fetch-failed", note: `抓取失败(HTTP ${page.status})` };
            }
            const doc = await ctx.adapters.parser.parse(page, `${ctx.keyBase}:gather:r${round}:a:${q.id}:parse:${fetchN}`);
            const snapshot = snapshotFrom({
              id: `snap:${url}`,
              url,
              // 网页自身标题最准;agent 只传 url,无搜索命中标题可兜底
              title: doc.title || url,
              bodyText: doc.bodyText,
              parseStatus: doc.parseStatus,
              contentType: page.contentType,
              tier: tierOfSource(url, ctx.moduleConfig.sourceStrategy.preferredDomains),
            });
            await ctx.store.saveSnapshot(snapshot);
            await ctx.ingestToLibrary(snapshot);
            fetchedForQ += 1;
            ctx.run.usage.fetches += 1;
            if (ctx.tracker.shouldCapOnTake(0)) ctx.state.capped = true;
            // C4:归属映射——共享快照对抓取过它的每个问展开
            (ctx.fetchedByQ.get(q.id) ?? ctx.fetchedByQ.set(q.id, new Set()).get(q.id)!).add(snapshot.id);
            ctx.snapshotsBySid.set(snapshot.id, snapshot);
            await ctx.persistUsageThrottled();
            await ctx.appendInvestigationSafe({
              qid: q.id,
              kind: "fetch",
              summary: snapshot.title || url,
              url,
              sid: snapshot.id,
              title: snapshot.title,
            });
            return {
              sid: snapshot.id,
              title: snapshot.title,
              url,
              parseStatus: snapshot.parseStatus,
              excerpt: clipExcerpt(snapshot.bodyText, EXCERPT_MAX_BYTES),
            };
          } catch (error) {
            addLimitation(ctx.state.limitations, `问题「${q.question}」的抓取调用失败:${errMsgOf(error)}`);
            await ctx.appendInvestigationSafe({ qid: q.id, kind: "fetch", summary: `抓取失败:${url}`, url, note: errMsgOf(error) });
            return { error: "fetch-failed", note: `抓取服务不可用:${errMsgOf(error)}` };
          }
        },
      };

      const readSnapshot: AgentTool = {
        ...TOOL_DEFINITIONS.readSnapshot,
        execute: async (args) => {
          readN += 1;
          const sid = String(args.sid ?? "");
          const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
          const limit = Math.min(EXCERPT_MAX_BYTES, Math.max(1, Math.floor(Number(args.limit ?? EXCERPT_MAX_BYTES)) || EXCERPT_MAX_BYTES));
          await ctx.appendInvestigationSafe({ qid: q.id, kind: "read", summary: `读取 ${sid}(offset=${offset})`, sid });
          if (readN > READ_PER_QUESTION_LIMIT) {
            return { error: "read-limit-exceeded", note: `本问读取次数已达上限(${READ_PER_QUESTION_LIMIT} 次),请基于已有摘录收束` };
          }
          const snap = ctx.state.snapshots.find((s) => s.id === sid) ?? ctx.snapshotsBySid.get(sid);
          if (!snap) return { error: "snapshot-not-found", note: `快照不存在: ${sid}` };
          return { sid, title: snap.title, excerpt: clipExcerpt(snap.bodyText.slice(offset), limit) };
        },
      };

      const res = await ctx.model.runAgent(
        {
          prompt: investigationCard(ctx, q, perQuestion),
          // R1-1:taskId 完整字面量含轮次;工具定义轮次不变
          taskId: `dr:${ctx.keyBase}:gather-agent:r${round}:${q.id}`,
          toolExecution: "parallel",
        },
        [webSearch, fetchPage, readSnapshot],
        `${ctx.keyBase}:gather:r${round}:a:${q.id}`,
      );

      // --- 终局后验(裁决②:parseJsonLoose;解析失败→sufficient:false+limitation) ---
      let sufficient = false;
      let note = "";
      let agentFailed = false;
      if (res.status === "succeeded" && res.text !== null) {
        const parsed = parseJsonLoose(res.text) as { sufficient?: unknown; note?: unknown };
        if (parsed && typeof parsed === "object" && typeof parsed.sufficient === "boolean") {
          sufficient = parsed.sufficient;
          note = typeof parsed.note === "string" ? parsed.note : "";
        } else {
          addLimitation(ctx.state.limitations, `问题「${q.question}」的调查结论无法解析,按未充分处理`);
        }
      } else if (res.status === "succeeded") {
        addLimitation(ctx.state.limitations, `问题「${q.question}」的调查结论文本不可用(截断),按未充分处理`);
      } else {
        // D2:RunResult failed/blocked→该问 unanswered+limitation,整 ctx.run 不死
        agentFailed = true;
        addLimitation(
          ctx.state.limitations,
          `问题「${q.question}」的自主调查失败(${res.reason ?? res.status}),该问按未回答处理`,
        );
      }
      await ctx.appendInvestigationSafe({
        qid: q.id,
        kind: "verdict",
        summary: sufficient ? "调查充分" : agentFailed ? "调查失败" : "调查未充分",
        sufficient,
        ...(note ? { note } : {}),
      });

      // --- extract 批量后置(R1-4 callKey;C4:对该问抓取过的快照逐个装配) ---
      let claimsForQ = 0;
      const sids = [...(ctx.fetchedByQ.get(q.id) ?? [])];
      for (let i = 0; i < sids.length; i++) {
        const snapshot = ctx.snapshotsBySid.get(sids[i]);
        if (!snapshot) continue;
        const extracted = await ctx.model.extractClaims(
          { snapshot },
          `${ctx.keyBase}:gather:r${round}:extract:${q.id}:${i}`,
        );
        claimsForQ += attachGatherExtraction(ctx.state, snapshot, extracted, q.id, ctx.snapshotVersionMap.get(snapshot.id));
      }

      // --- q.status 合成(D3:现状判定链的 agent 形态;P2-6 R1-3:未答成因) ---
      if (agentFailed) {
        q.status = "unanswered";
        q.unansweredReason = "insufficient";
      } else if (sufficient && claimsForQ > 0) {
        q.status = "answered";
      } else if (claimsForQ > 0) {
        q.status = "partially";
      } else {
        q.status = "unanswered";
        q.unansweredReason = "insufficient";
      }
      // 2.1 增量:检索命中全部为基准已采信源(未重复采证)的问题如实披露
      if (q.status === "unanswered" && allBaseHits && fetchedForQ === 0) {
        addLimitation(
          ctx.state.limitations,
          `问题「${q.question}」的检索命中均为基准研究已采信源,本次未重复采证;答案可能存在于延续证据中`,
        );
      }
      await ctx.persistRun();
      // E1(G1-1):每问收束切片回调——浅拷贝防串改;skipped/starved/通道不支持路径不进本循环,天然不触发
      ctx.onGatherProgress?.({
        questions: ctx.state.questions.map((pq) => ({ ...pq })),
        claimQuestions: { ...ctx.state.claimQuestions },
        claims: [...ctx.state.claims],
        evidence: [...ctx.state.evidence],
        snapshots: [...ctx.state.snapshots],
        limitations: [...ctx.state.limitations],
        unresolved: [...ctx.state.unresolved],
      });
    }
  } finally {
    ctx.activeGatherTargets = null;
    ctx.currentQuestion = undefined;
  }
  // P2-6(F3):循环末评估窗——末问 runAgent 中到达的加注在此同款复位+重开(问开始点之后唯一出口)
  reopened.push(...scanTopupReopen(ctx));
  // P2-6(R1-4):加注重开——新一轮次补采配额饿死问题(cancelled 提前 return 不重开);
  // REVIEW B1:递归前过滤——本轮 targets 中被扫描重开的问题已在此轮推进状态,再递归会
  // 双轮调查并清除其刚产出的主张/证据(gap 补采 targets∩starved 实证踩中);只补采仍为 open 的。
  // REVIEW B1R:并按 id 去重——同一问可跨两次扫描重复入列(扫开→配额再耗尽重标 starved→
  // 二次加注后再扫开),[X,X] 会在同一递归内双轮调查且共用同一 taskId
  const seenReopen = new Set<string>();
  const needReopen: PlanQuestion[] = [];
  for (const q of reopened) {
    if (q.status === "open" && !seenReopen.has(q.id)) {
      seenReopen.add(q.id);
      needReopen.push(q);
    }
  }
  if (needReopen.length > 0) await gather(ctx, round + 1, needReopen);
};
