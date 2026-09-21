import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DataSyncResult {
  ok: boolean;
  action: "pushed" | "up-to-date" | "conflict" | "not-a-repo" | "error";
  detail: string;
}

const git = (root: string, args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * 研究数据双机同步:数据目录(research-data/)寄居在仓库内,
 * 提交本机数据变更 → rebase 拉取远端 → 推送。只动 research-data/,不碰代码工作区。
 * 冲突时中止 rebase、保留本机数据并返回 conflict,由上层提示人工处理。
 */
export function dataSync(repoRoot = process.cwd()): DataSyncResult {
  if (!existsSync(join(repoRoot, ".git"))) {
    return { ok: false, action: "not-a-repo", detail: "当前目录不是 git 仓库,研究数据仅本机保存" };
  }
  try {
    let status = "";
    if (existsSync(join(repoRoot, "research-data"))) {
      git(repoRoot, ["add", "--", "research-data"]);
      status = git(repoRoot, ["status", "--porcelain", "--", "research-data"]);
      if (status) {
        git(repoRoot, ["commit", "-m", `data: 研究数据同步 ${new Date().toISOString()}`]);
      }
    }
    const remotes = git(repoRoot, ["remote"]).split("\n").filter(Boolean);
    if (!remotes.includes("origin")) {
      return { ok: true, action: "up-to-date", detail: "已本地提交(未配置 origin 远端)" };
    }
    const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(repoRoot, ["pull", "--rebase", "--autostash", "origin", branch]);
    git(repoRoot, ["push", "origin", branch]);
    return { ok: true, action: status ? "pushed" : "up-to-date", detail: "" };
  } catch (error) {
    try {
      git(repoRoot, ["rebase", "--abort"]);
    } catch {
      // 没有 rebase 进行中则忽略
    }
    return { ok: false, action: "conflict", detail: String(error instanceof Error ? error.message : error).slice(0, 240) };
  }
}
