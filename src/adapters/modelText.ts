/* 阶段/抽取的纯文本逻辑(P2-1 T2 自 live.ts 迁出):提示词、鲁棒解析器、prompt 拼装。
   无任何传输/SDK 依赖,单测直接覆盖;piRuntime.ts 消费。 */
import type { StageName } from "../core/stages.js";
import type { SourceSnapshot } from "../contracts.js";
import type { ExtractedClaim } from "./types.js";

const EXTRACTION_SYSTEM_PROMPT = [
  "你是研究证据抽取器。只输出一个 JSON 数组,不要任何其他文字或代码围栏。",
  "数组元素形状: {\"statement\": string, \"kind\": \"fact\"|\"inference\"|\"unverified\", \"quote\": string, \"calibration\"?: {\"entity\": string, \"period\": string, \"unit\": string}}。",
  "quote 必须从正文中直接复制连续片段(≤80字),不得改写、缩略、翻译、增删标点或合并不相邻句子;复制前先在正文中找到原句。无法逐字引用时 kind 取 \"unverified\" 且 quote 为空字符串。",
  "statement 用一句话陈述;涉及数值时必须给 calibration(对象/时间/单位)。",
].join("\n");
export function parseClaims(text: string): ExtractedClaim[] {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const claims: ExtractedClaim[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const statement = typeof rec.statement === "string" ? rec.statement : "";
    const quote = typeof rec.quote === "string" ? rec.quote : "";
    if (!statement) continue;
    const kind = rec.kind === "fact" || rec.kind === "inference" ? rec.kind : "unverified";
    const cal = rec.calibration as Record<string, unknown> | undefined;
    claims.push({
      statement,
      kind,
      quote,
      ...(cal &&
      typeof cal.entity === "string" &&
      typeof cal.period === "string" &&
      typeof cal.unit === "string" &&
      cal.entity.trim() !== "" &&
      cal.period.trim() !== "" &&
      cal.unit.trim() !== ""
        ? { calibration: { entity: cal.entity, period: cal.period, unit: cal.unit } }
        : {}),
    });
  }
  return claims;
}
export const STAGE_PROMPTS: Record<StageName, string> = {
  plan: '你是研究计划器。只输出 JSON:{"questions":[{"id":string,"question":string,"method"?:string,"status":"open"}]}。围绕目标与范围拆解研究问题,id 用 q1、q2…,不要输出其他文字。',
  outline:
    '你是报告框架设计师。只输出 JSON:{"title":string,"subtitle"?:string,"sections":[{"id":string,"title":string,"purpose"?:string,"bullets":string[]}]}。基于研究目标与已确认的问题清单设计报告章节结构,id 用 s1、s2…,每节给 2-4 条内容要点(bullets),章节须覆盖全部研究问题,不要输出其他文字。',
  analyze: '你是证据分析器。只输出 JSON:{"findings":[{"questionId":string,"summary":string,"claimIds":string[]}],"gaps":[{"questionId":string,"reason":string}]}。基于已登记主张作答,不新增主张。',
  draft: [
    '你是研究报告撰写器。只输出 JSON:{"reportMd":string}。中文 Markdown。',
    '写作规约(按优先级从高到低):',
    '1. 反编造(最高优先级):只陈述输入主张与素材中有证据支撑的内容,推断须显式标注;证据不足的节如实写明"现有证据不足以展开"并描述缺口,禁止为凑篇幅编造数据、来源或引文。',
    '2. 报告结构:# 标题 → ## 执行摘要(3-5 条决策者视角结论,带关键数字)→ 逐节正文 → ## 启示与建议(逐条对应正文发现,标注推断属性)→ ## 口径与局限披露。',
    '3. 章节展开:每节 ≥300 字且不得空泛套话;含数值主张的节必须用 Markdown 表格呈现数据矩阵(列含对象/数值/口径时间/来源),无数值主张的节用结构化要点展开并说明原因。',
    '4. 素材利用:充分使用输入 evidencePacks 中的原文摘录(引句带上下文),转述时保留口径细节;数据点尽量回溯到来源快照。',
    '5. 若输入含 outline,标题用 outline.title,逐节按 outline.sections 的标题与要点展开,章节须覆盖全部研究问题。',
    '6. 输出前自检:执行摘要、每节表格或缺项说明、建议章、披露章齐全,数值均带口径;不齐先自行补齐再输出。除 JSON 外不要输出任何其他文字。',
  ].join('\n'),
  polish: [
    '你是报告润色编辑。只输出 JSON:{"reportMd":string}。中文 Markdown。',
    '任务:对输入的草稿 reportMd 做润色与结构补全,使其丰满、连贯、可读,接近专业研究报告成稿。',
    '硬性边界(违反即失败):',
    '1. 严禁新增任何输入中无证据支撑的事实、数字、来源或引文;不得改动任何数值、口径与推断属性标注。',
    '2. 只丰富表达方式与结构:补全执行摘要、把段落中的并列数据改为表格矩阵、补建议章与披露章、理顺段间逻辑与过渡。',
    '3. 证据不足的节必须保留"现有证据不足以展开"式披露,不得润色掉缺口说明。',
    '4. 输入 evidencePacks 提供原文语境,可把概括性表述具体化,但仍受输入主张约束。',
    '5. 输出完整报告全文(不是修改说明),除 JSON 外不要输出任何其他文字。',
  ].join('\n'),
  review: '你是研究评审器。只输出 JSON:{"issues":[{"severity":"high"|"low","kind":"citation"|"caliber"|"gap"|"counterexample"|"other","detail":string,"targetClaimId"?:string,"targetQuestionId"?:string,"fix":"regather"|"rephrase"|"disclose"}],"counterexampleChecked":boolean}。检查引用核查与口径冲突输入,对关键结论做反例检查。',
  formal:
    '你是报告定稿编辑。只输出 JSON:{"executiveSummary":string[],"sectionHighlights":[{"sectionId":string,"bullets":string[]}]}。executiveSummary 给 3-5 条决策者视角的结论要点;sectionHighlights 按输入 sections 的 sectionId 逐节提炼 2-4 条要点。只允许重组草稿已有内容与主张,严禁新增任何事实或数字。',
};
export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 继续尝试截取第一个 JSON 块
  }
  const start = cleaned.search(/[{[]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // 落到空输出,由编排器 schema 校验报出
    }
  }
  return {};
}
/** 主备链路:按序尝试各 provider,配额/限流类错误自动切备用(用户决策:minimax 主用,xiaomi 备用)。 */
/** draft 输出鲁棒解析:优先 JSON 包装,模型直接吐 Markdown 时原文即报告(去围栏)。 */
export function draftFromText(text: string): { reportMd: string } {
  const cleaned = text
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const parsed = parseJsonLoose(cleaned) as { reportMd?: unknown };
  if (parsed && typeof parsed.reportMd === "string" && parsed.reportMd.trim() !== "") {
    return { reportMd: parsed.reportMd };
  }
  return { reportMd: cleaned };
}


/** 抽取 prompt 拼装(xiaomi system 通道怪癖:指令并入正文,不使用 system 消息)。 */
export const buildExtractPrompt = (snapshot: SourceSnapshot): string =>
  `${EXTRACTION_SYSTEM_PROMPT}\n\n快照 URL: ${snapshot.url}\n标题: ${snapshot.title}\n正文:\n${snapshot.bodyText}`;

/** 阶段 prompt 拼装(同上,不使用 system 消息)。 */
export const buildStagePrompt = (stage: StageName, input: unknown): string =>
  `${STAGE_PROMPTS[stage]}\n\n输入(JSON):\n${JSON.stringify(input)}`;
