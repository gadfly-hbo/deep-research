import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptyState } from "./runState.js";
import { runStageSafe } from "./runStageSafe.js";

const OutSchema = z.object({ text: z.string() });

describe("runStageSafe", () => {
  it("成功路径:call → onCost → parse → apply 顺序执行并返回解析值", async () => {
    const state = emptyState();
    const order: string[] = [];
    const parsed = await runStageSafe({
      call: async () => {
        order.push("call");
        return { output: { text: "ok" }, cost: 1.5 };
      },
      schema: OutSchema,
      fallback: () => ({ text: "fallback" }),
      limitation: "不应出现",
      state,
      onCost: (c) => order.push(`cost:${c}`),
      apply: (p) => {
        order.push(`apply:${p.text}`);
      },
    });
    expect(parsed).toEqual({ text: "ok" });
    expect(order).toEqual(["call", "cost:1.5", "apply:ok"]);
    expect(state.limitations).toEqual([]);
  });

  it("safeParse 失败:降级为 fallback 并披露限制(不抛出),apply 仍执行", async () => {
    const state = emptyState();
    const applied: string[] = [];
    const parsed = await runStageSafe({
      call: async () => ({ output: { wrong: 1 }, cost: 0.1 }),
      schema: OutSchema,
      fallback: () => ({ text: "降级" }),
      limitation: "输出不合格,已降级",
      state,
      onCost: () => {},
      apply: (p) => {
        applied.push(p.text);
      },
    });
    expect(parsed).toEqual({ text: "降级" });
    expect(applied).toEqual(["降级"]);
    expect(state.limitations).toEqual(["输出不合格,已降级"]);
  });

  it("coerce 存在时先整形再解析", async () => {
    const state = emptyState();
    const parsed = await runStageSafe({
      call: async () => ({ output: "原始字符串", cost: 0 }),
      schema: OutSchema,
      coerce: (o) => ({ text: String(o) }),
      fallback: () => ({ text: "fallback" }),
      limitation: "不应出现",
      state,
      onCost: () => {},
      apply: () => {},
    });
    expect(parsed).toEqual({ text: "原始字符串" });
    expect(state.limitations).toEqual([]);
  });

  it("apply 为异步函数时被等待", async () => {
    const state = emptyState();
    let settled = false;
    await runStageSafe({
      call: async () => ({ output: { text: "x" }, cost: 0 }),
      schema: OutSchema,
      fallback: () => ({ text: "f" }),
      limitation: "不应出现",
      state,
      onCost: () => {},
      apply: async () => {
        await Promise.resolve();
        settled = true;
      },
    });
    expect(settled).toBe(true);
  });
});
