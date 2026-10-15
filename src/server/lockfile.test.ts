import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, isLockOwnerDead, processBootId, type LockIdentity } from "./lockfile.js";

/** 起一个短命子进程,等其退出后返回 pid(真实死 pid,无复用窗口)。 */
const deadPid = (): number => {
  const child = spawnSync("sleep", ["0.3"]);
  return child.pid ?? -1;
};

/** 起一个存活子进程,返回 {pid, 真实 bootId, kill}。 */
const aliveChild = (): { pid: number; bootId: number; kill(): void } => {
  const child = spawn("sleep", ["10"]);
  const out = spawnSync(
    process.execPath,
    ["-e", "console.log(Math.round(Date.now() - process.uptime() * 1000))"],
    { encoding: "utf-8" },
  );
  return {
    pid: child.pid ?? -1,
    bootId: Number(out.stdout.trim()),
    kill: () => {
      child.kill("SIGKILL");
    },
  };
};

const writeLock = (path: string, identity: Partial<LockIdentity>): void => {
  writeFileSync(path, JSON.stringify({ token: "x", ...identity }));
};

describe("O_EXCL 锁共享件(P2-3b T2)", () => {
  it("双开恰一胜:第二次获取得到可读错误(带 pid 与锁路径);release 后可再入", () => {
    const dir = mkdtempSync(join(tmpdir(), "dr-lock-"));
    const path = join(dir, ".lock");
    const first = acquireLock(path, { resource: "预算账本" });
    expect(() => acquireLock(path, { resource: "预算账本" })).toThrow(/另一进程\(pid \d+\)正在使用/);
    first.release();
    const second = acquireLock(path, { resource: "预算账本" });
    expect(second.token).not.toBe(first.token);
    second.release();
    expect(() => acquireLock(path, { resource: "预算账本" })).not.toThrow(); // 释放幂等后可再取
  });

  it("陈锁接管:死 owner(spawn 短命进程取 pid 等退出)→ unlink 重试 O_EXCL 成功", () => {
    const dir = mkdtempSync(join(tmpdir(), "dr-lock-"));
    const path = join(dir, ".lock");
    const pid = deadPid();
    writeLock(path, { pid, bootId: Date.now() });
    const held = acquireLock(path, { resource: "预算账本" });
    expect((JSON.parse(readFileSync(path, "utf-8")) as LockIdentity).token).toBe(held.token);
    held.release();
  });

  it("同进程陈锁自接管(R1-4):pid==self+bootId==self+无 holder 登记 → 修复 release 异常自锁死", () => {
    const dir = mkdtempSync(join(tmpdir(), "dr-lock-"));
    const path = join(dir, ".lock");
    // 伪造 release 失败后的残局:锁内容是本进程,但 holder 登记为空
    writeLock(path, { pid: process.pid, bootId: processBootId(), token: "stale" });
    const held = acquireLock(path, { resource: "预算账本" }); // 接管成功不自锁死
    expect((JSON.parse(readFileSync(path, "utf-8")) as LockIdentity).token).toBe(held.token);
    // 接管后在役:同进程再取被拒(登记生效);释放后可再入
    expect(() => acquireLock(path, { resource: "预算账本" })).toThrow(/另一进程/);
    held.release();
    expect(() => acquireLock(path, { resource: "预算账本" })).not.toThrow();
  });

  it("存活 owner 拒绝:真实他进程 pid+真实 bootId(ps lstart 命中容差)→ 可读错误", () => {
    const dir = mkdtempSync(join(tmpdir(), "dr-lock-"));
    const path = join(dir, ".lock");
    const child = aliveChild();
    try {
      writeLock(path, { pid: child.pid, bootId: child.bootId });
      expect(() => acquireLock(path, { resource: "会话写入" })).toThrow(/另一进程/);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("判活细则(R1-8):self 短路活;bootId 不匹配判死;含糊(pid 存在但 lstart 差>2s)按记录判死接管", () => {
    expect(isLockOwnerDead(process.pid, processBootId())).toBe(false); // self 短路
    expect(isLockOwnerDead(process.pid, processBootId() - 60_000)).toBe(true); // 同 pid 异 boot=遗物
    const child = aliveChild();
    try {
      expect(isLockOwnerDead(child.pid, child.bootId)).toBe(false); // 真活:ps lstart 命中
      // pid 存活但记录 bootId 偏差 10s → 视为 pid 复用的新进程,判死(接管路径)
      expect(isLockOwnerDead(child.pid, child.bootId - 10_000)).toBe(true);
    } finally {
      child.kill();
    }
    expect(isLockOwnerDead(deadPid(), Date.now())).toBe(true); // ESRCH 判死
  });
});
