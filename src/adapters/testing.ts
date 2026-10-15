/* P2-4(R1-8):共享 scripted-agent 测试假件——离线驱动编排器传入的真实工具 executor,
   快照/调查事件/主张装配全链再生。gather 相关测试逐份接入(T3 全量收敛 fakeAdapters)。 */
import type { AgentTool, ModelProvider, RunAgentResult } from "./types.js";

export interface ScriptedTurn {
  /** 一轮工具调用:按名找到编排器传入的工具,直接执行其真实 executor。 */
  tool?: { name: string; args: Record<string, unknown> };
  /** 终局文本(停止调工具)。 */
  text?: string;
}

export interface AgentScript {
  /** 任务卡匹配(子串或正则);缺省=不匹配任何卡(仅作显式脚本)。 */
  match?: string | RegExp;
  turns: ScriptedTurn[];
}

const USAGE = { modelCalls: 1, outputTokens: 16 };
const finalOf = (sufficient: boolean, note: string): string => JSON.stringify({ sufficient, note });

/** 从任务卡解析问题与方向附注,按旧 gather 同款拼搜索词(保持既有 query 断言形状)。 */
const cardQuery = (prompt: string): string => {
  const q = /【研究问题】(.*)/.exec(prompt)?.[1]?.trim() ?? "";
  const notes = /【方向附注】(.*)/.exec(prompt)?.[1]?.trim();
  const note = !notes || notes === "无" ? "" : ` ${notes.split(";").map((n) => `(${n})`).join(" ")}`;
  return `${q}${note}`;
};

/**
 * 默认调查脚本:搜一次 → 跳过基准已有快照的命中(base 标记)→ 抓其余 → 判充分。
 * 近似旧 gather 的机械行为,让不关心 agent 形态的既有断言(用量/快照/主张)保持形状。
 */
async function defaultInvestigate(prompt: string, tools: AgentTool[], signal: AbortSignal): Promise<string> {
  const search = tools.find((t) => t.name === "web_search");
  if (!search) return finalOf(true, "无检索工具,默认充分");
  const res = (await search.execute({ query: cardQuery(prompt) }, signal)) as {
    hits?: Array<{ url: string; base?: boolean }>;
    error?: string;
  };
  if (!res.error && res.hits) {
    const fetchTool = tools.find((t) => t.name === "fetch_page");
    if (fetchTool) {
      for (const hit of res.hits) {
        if (hit.base) continue; // 增量基准已有快照:勿重抓(旧过滤行为的 agent 形态)
        await fetchTool.execute({ url: hit.url }, signal);
      }
    }
  }
  return finalOf(true, "默认调查完成");
}

/** scripted runAgent:按任务卡匹配脚本依次执行轮次;未匹配走默认调查脚本。 */
export function scriptedRunAgent(
  scripts: AgentScript[] = [],
  opts?: {
    /** 每轮工具的执行结果落此(供测试断言 error-as-value 形状)。 */
    log?: Array<{ name: string; result: unknown }>;
    /** 收到任务卡时回调(供测试断言任务卡六段内容)。 */
    onPrompt?: (prompt: string) => void;
  },
): NonNullable<ModelProvider["runAgent"]> {
  return async (input, tools): Promise<RunAgentResult> => {
    const signal = new AbortController().signal;
    opts?.onPrompt?.(input.prompt);
    const script = scripts.find((s) =>
      !s.match
        ? false
        : typeof s.match === "string"
          ? input.prompt.includes(s.match)
          : s.match.test(input.prompt),
    );
    if (!script) {
      return { status: "succeeded", text: await defaultInvestigate(input.prompt, tools, signal), usage: { ...USAGE } };
    }
    for (const turn of script.turns) {
      if (turn.tool) {
        const tool = tools.find((t) => t.name === turn.tool!.name);
        if (!tool) throw new Error(`scripted agent: 工具未注册 ${turn.tool.name}`);
        const result = await tool.execute(turn.tool.args, signal);
        opts?.log?.push({ name: turn.tool.name, result });
      } else if (turn.text !== undefined) {
        return { status: "succeeded", text: turn.text, usage: { ...USAGE } };
      }
    }
    return { status: "succeeded", text: finalOf(true, "脚本默认充分"), usage: { ...USAGE } };
  };
}
