import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelConfig, ModelReply, ModelTransport } from "pi-agent-runtime";
import {
  createProjectSessionRuntime,
  createSessionRuntimeOptions,
  sessionLimits,
} from "./sessionRuntime.js";

/** P2-3b T4:SessionRuntime 装配冒烟(合成 transport,R1-1:run() 非 runText)+ bindings 语义(R1-7)。 */

const MODEL: ModelConfig = {
  provider: "minimax-cn",
  id: "MiniMax-M3",
  protocol: "anthropic-messages",
  endpoint: "https://api.minimaxi.com/anthropic",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  input: ["text"],
};
const reply = (text: string): ModelReply => ({ content: [{ kind: "text", text }], stop: "complete", usage: { inputTokens: 8, outputTokens: 9 } });
const transport: ModelTransport = async () => reply("会话回合回复");

const tmp = (): string => mkdtempSync(join(tmpdir(), "dr-sess-"));
const deadPid = (): number => {
  const child = spawnSync("sleep", ["0.3"]);
  return child.pid ?? -1;
};

describe("SessionRuntime 装配冒烟(P2-3b T4,R1-1)", () => {
  it("create→run(prompt op ×2)history 累积;idle followUp INVALID_REQUEST(KA5 钉死)", async () => {
    const root = tmp();
    const projectDir = join(root, "proj");
    const rt = createProjectSessionRuntime({
      projectDir,
      candidates: [{ model: MODEL, transport }],
      auditPath: join(root, "model-audit.jsonl"),
    });
    const session = await rt.create();
    expect(session.id).toBeTruthy();
    const taskId = "sess:smoke:1"; // session 侧 sess: 前缀(与 plain dr: 命名空间隔离)
    const limits = sessionLimits();

    const r1 = await rt.run({ sessionId: session.id, taskId, prompt: "第一问", limits, tools: [] });
    expect(r1.status).toBe("succeeded");
    const r2 = await rt.run({ sessionId: session.id, taskId, prompt: "第二问", limits, tools: [] });
    expect(r2.status).toBe("succeeded");

    const history = await rt.history(session.id);
    const texts = history.filter((e) => e.message?.role === "user").map((e) => e.message?.text);
    expect(texts).toContain("第一问");
    expect(texts).toContain("第二问"); // transcript 累积(R1-1)
    expect(history.filter((e) => e.message?.role === "assistant").length).toBeGreaterThanOrEqual(2);

    // KA5:SDK 对 idle 会话拒绝 followUp(追问=同会话新 prompt operation 或活跃期 steer,P2-5 措辞)
    await expect(
      rt.control({ taskId, sessionId: session.id, command: { kind: "followUp", text: "追问" } }),
    ).rejects.toMatchObject({ reason: "INVALID_REQUEST" });
  });

  it("陈锁接管重开:伪造死 owner .writer-lock → inspect 历史 + 续跑(reconcile open=[] ready)", async () => {
    const root = tmp();
    const projectDir = join(root, "proj");
    const auditPath = join(root, "model-audit.jsonl");
    const rt = createProjectSessionRuntime({ projectDir, candidates: [{ model: MODEL, transport }], auditPath });
    const session = await rt.create();
    const taskId = "sess:smoke:2";
    const limits = sessionLimits();
    await rt.run({ sessionId: session.id, taskId, prompt: "进程一的第一问", limits, tools: [] });
    const before = (await rt.history(session.id)).length;

    // 模拟进程一遗留死锁(writer 未释放即崩溃)
    writeFileSync(
      join(projectDir, "session", ".writer-lock"),
      JSON.stringify({ pid: deadPid(), bootId: Date.now(), token: "orphan" }),
    );

    // "重开"同目录的新 runtime:首次 access(只读 inspect 也持 writer,KA1)打在陈锁接管上
    const rt2 = createProjectSessionRuntime({ projectDir, candidates: [{ model: MODEL, transport }], auditPath });
    const status = await rt2.inspect(session.id);
    expect(status.session.id).toBe(session.id); // 历史可读
    expect(status.pending).toBeNull();

    // 续跑:新 prompt op(reconcile open=[] → ready),transcript 继续累积
    const r3 = await rt2.run({ sessionId: session.id, taskId, prompt: "进程二的续问", limits, tools: [] });
    expect(r3.status).toBe("succeeded");
    const after = (await rt2.history(session.id)).length;
    expect(after).toBeGreaterThan(before);

    // bindings 落 session/(随目录 gitignore),两个操作各一条
    const bindings = JSON.parse(readFileSync(join(projectDir, "session", "bindings.json"), "utf-8")) as Array<{
      operationId: string;
      taskId: string;
    }>;
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.taskId === taskId)).toBe(true);
  });
});

describe("bindings 读写语义(P2-3b T4,R1-7)", () => {
  const setup = () => {
    const root = tmp();
    const projectDir = join(root, "proj");
    const opts = createSessionRuntimeOptions({ projectDir, auditPath: join(root, "model-audit.jsonl") });
    const signal = new AbortController().signal;
    return { projectDir, opts, signal, bindingsPath: join(projectDir, "session", "bindings.json") };
  };

  it("幂等:同 operationId 同内容重复 bind 只落一条", async () => {
    const { opts, signal, bindingsPath } = setup();
    const input = { sessionId: "s1", branch: "main", operationId: "op-1", taskId: "t1" };
    await opts.bindOperation(input, signal);
    await opts.bindOperation(input, signal);
    const list = JSON.parse(readFileSync(bindingsPath, "utf-8"));
    expect(list).toHaveLength(1);
  });

  it("冲突 reject:同 operationId 异 taskId(或 sessionId/branch/purpose)→ STATE_FAILED", async () => {
    const { opts, signal } = setup();
    await opts.bindOperation({ sessionId: "s1", branch: "main", operationId: "op-1", taskId: "t1" }, signal);
    await expect(
      opts.bindOperation({ sessionId: "s1", branch: "main", operationId: "op-1", taskId: "t2" }, signal),
    ).rejects.toMatchObject({ reason: "STATE_FAILED" });
    await expect(
      opts.bindOperation({ sessionId: "s2", branch: "main", operationId: "op-1", taskId: "t1" }, signal),
    ).rejects.toMatchObject({ reason: "STATE_FAILED" });
    await expect(
      opts.bindOperation({ sessionId: "s1", branch: "dev", operationId: "op-1", taskId: "t1" }, signal),
    ).rejects.toMatchObject({ reason: "STATE_FAILED" });
    await expect(
      opts.bindOperation({ sessionId: "s1", branch: "main", operationId: "op-1", taskId: "t1", purpose: "p2" }, signal),
    ).rejects.toMatchObject({ reason: "STATE_FAILED" });
  });

  it("reconcile:open=[] 全 ready;匹配 ready;缺失 unknown;不一致 denied", async () => {
    const { opts, signal } = setup();
    await opts.bindOperation({ sessionId: "s1", branch: "main", operationId: "op-1", taskId: "t1" }, signal);
    expect(await opts.reconcile({ taskId: "t1", sessionId: "s1", branch: "main", open: [] }, signal)).toBe("ready");
    expect(
      await opts.reconcile({ taskId: "t1", sessionId: "s1", branch: "main", open: [{ operationId: "op-1", branch: "main", kind: "run" }] }, signal),
    ).toBe("ready");
    expect(
      await opts.reconcile({ taskId: "t1", sessionId: "s1", branch: "main", open: [{ operationId: "op-x", branch: "main", kind: "run" }] }, signal),
    ).toBe("unknown");
    expect(
      await opts.reconcile({ taskId: "t2", sessionId: "s1", branch: "main", open: [{ operationId: "op-1", branch: "main", kind: "run" }] }, signal),
    ).toBe("denied");
  });
});
