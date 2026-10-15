import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "pi-agent-runtime";
import { piRuntimeModel } from "../adapters/piRuntime.js";
import { createProjectSessionRuntime, sessionLimits } from "../server/sessionRuntime.js";
import { dataSync } from "./dataSync.js";

const MODEL: ModelConfig = {
  provider: "minimax-cn",
  id: "MiniMax-M3",
  protocol: "anthropic-messages",
  endpoint: "https://api.minimaxi.com/anthropic",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  input: ["text"],
};

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setupTwoClones(): { a: string; b: string } {
  const tmp = mkdtempSync(join(tmpdir(), "dr-sync-"));
  const bare = join(tmp, "remote.git");
  mkdirSync(bare);
  git(tmp, ["init", "--bare", "-b", "main", bare]);
  const a = join(tmp, "repoA");
  git(tmp, ["clone", bare, a]);
  writeFileSync(join(a, "README.md"), "x");
  git(a, ["add", "."]);
  git(a, ["commit", "-m", "init"]);
  git(a, ["push", "origin", "main"]);
  const b = join(tmp, "repoB");
  git(tmp, ["clone", bare, b]);
  for (const r of [a, b]) {
    git(r, ["config", "user.name", "test"]);
    git(r, ["config", "user.email", "test@test"]);
  }
  return { a, b };
}

describe("dataSync(研究数据 git 同步)", () => {
  it("A 端新增数据 → push;B 端 sync → 拉到数据", () => {
    const { a, b } = setupTwoClones();
    mkdirSync(join(a, "research-data", "projects", "p1"), { recursive: true });
    writeFileSync(join(a, "research-data", "projects", "p1", "project.json"), '{"goal":"g"}');

    const push = dataSync(a);
    expect(push.ok).toBe(true);
    expect(push.action).toBe("pushed");

    const pull = dataSync(b);
    expect(pull.ok).toBe(true);
    expect(readFileSync(join(b, "research-data", "projects", "p1", "project.json"), "utf8")).toBe('{"goal":"g"}');
  });

  it("无变化时为 up-to-date,不产生空提交", () => {
    const { a } = setupTwoClones();
    mkdirSync(join(a, "research-data"), { recursive: true });
    writeFileSync(join(a, "research-data", "config.json"), "{}");
    dataSync(a);
    const before = git(a, ["rev-parse", "HEAD"]);
    const second = dataSync(a);
    expect(second.action).toBe("up-to-date");
    expect(git(a, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("P2-3b 冒烟(R1-9):模型调用+会话产物后 dataSync——git status 无账本/锁/session 新文件,三类磁盘存在", async () => {
    const { a } = setupTwoClones();
    const dataDir = join(a, "research-data");
    mkdirSync(dataDir, { recursive: true });
    // 仓库同款三处 gitignore(以仓库 research-data/.gitignore 为源)
    writeFileSync(
      join(dataDir, ".gitignore"),
      readFileSync(join(process.cwd(), "research-data", ".gitignore"), "utf-8"),
    );
    git(a, ["add", "--", "research-data"]);
    git(a, ["commit", "-m", "chore: research-data gitignore"]);
    git(a, ["push", "origin", "main"]);

    // (1) 模型调用经 FileBudgetStore(账本/锁落 dataDir 根)
    const auditPath = join(dataDir, "model-audit.jsonl");
    const provider = piRuntimeModel([], {
      auditPath,
      candidates: [
        {
          model: MODEL,
          transport: async () => ({ content: [{ kind: "text", text: '{"ok":true}' }], stop: "complete", usage: { inputTokens: 1, outputTokens: 1 } }),
        },
      ],
    });
    await provider.runStage("review", {}, "p23b:sync-smoke:0");

    // (2) 会话产物(session/ 目录随项目)
    const projectDir = join(dataDir, "projects", "p-smoke");
    const rt = createProjectSessionRuntime({
      projectDir,
      candidates: [{ model: MODEL, transport: async () => ({ content: [{ kind: "text", text: "会话回复" }], stop: "complete", usage: { inputTokens: 1, outputTokens: 1 } }) }],
      auditPath,
    });
    const session = await rt.create();
    const run = await rt.run({ sessionId: session.id, taskId: "sess:sync:1", prompt: "一问", limits: sessionLimits(), tools: [] });
    expect(run.status).toBe("succeeded");

    // 三类文件磁盘存在(被忽略,不入 git)
    expect(existsSync(join(dataDir, "model-budget.json"))).toBe(true);
    expect(existsSync(join(dataDir, ".model-budget-lock"))).toBe(true);
    expect(existsSync(join(projectDir, "session", "bindings.json"))).toBe(true);

    // dataSync 后:research-data 无待提交新文件(三类全部被 gitignore 罩住)
    const sync = dataSync(a);
    expect(sync.ok).toBe(true);
    expect(git(a, ["status", "--porcelain", "--", "research-data"])).toBe("");
    // 且未进历史
    expect(git(a, ["ls-files", "--", "research-data/model-budget.json", "research-data/.model-budget-lock"])).toBe("");
  }, 30_000);

  it("双端改同一文件 → 后推一方报告冲突并中止 rebase,本地数据保留", () => {
    const { a, b } = setupTwoClones();
    mkdirSync(join(a, "research-data"), { recursive: true });
    writeFileSync(join(a, "research-data", "config.json"), '{"v":1}');
    dataSync(a);
    dataSync(b); // b 拉到 v1
    writeFileSync(join(b, "research-data", "config.json"), '{"v":2}');
    dataSync(b); // b 推 v2
    writeFileSync(join(a, "research-data", "config.json"), '{"v":3}');
    const conflicted = dataSync(a);
    expect(conflicted.ok).toBe(false);
    expect(conflicted.action).toBe("conflict");
    expect(readFileSync(join(a, "research-data", "config.json"), "utf8")).toBe('{"v":3}');
  });

  it("非 git 目录 → not-a-repo,不报错", () => {
    const tmp = mkdtempSync(join(tmpdir(), "dr-nogit-"));
    const r = dataSync(tmp);
    expect(r).toMatchObject({ ok: false, action: "not-a-repo" });
  });
});
