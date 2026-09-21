import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataSync } from "./dataSync.js";

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
