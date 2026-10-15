/* P2-3b(D1/R1-4/R1-8):O_EXCL 锁共享件——跨进程互斥 + pid 判死接管 + 同进程 holder 登记。
   FileBudgetStore 打开收口与 SessionRuntime 的 acquireWriter 共用此机制。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LockIdentity {
  pid: number;
  bootId: number;
  token: string;
}

export interface HeldLock {
  path: string;
  token: string;
  /** 尽力释放:清同进程登记;锁内容 token 匹配才 unlink(已易主则不动)。幂等不抛错。 */
  release(): void;
}

/** 进程启动时刻(ms)——与 ps lstart 对比的判活基准(bootId)。 */
export const processBootId = (): number => Date.now() - Math.round(process.uptime() * 1000);

// 同进程 holder 登记:lockPath → token(R1-4:release 异常遗留锁时,同进程可识别陈锁自接管,
// 修复"release 失败后自锁死";登记非空=本进程内有在役持有者,拒绝)
const holders = new Map<string, string>();

/**
 * R1-8 判活细则:pid==self 且 bootId 在容差内→短路判活(免 ps;bootId 计算含 ±1ms 舍入抖动,
 * 比较用 2s 容差);kill(pid,0) ESRCH→死;其余比对 ps lstart——trim 后 new Date 解析,
 * NaN/ps 失败/异常一律判活(含糊判活:误判活=TASK_BUSY 可忍,误判死=双写者不可忍);
 * |lstart−bootId|>2000ms 才判死。
 */
export function isLockOwnerDead(pid: number, bootId: number): boolean {
  if (pid === process.pid) return Math.abs(bootId - processBootId()) > 2000;
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
    const lstart = new Date(out.trim()).getTime();
    if (Number.isNaN(lstart)) return false;
    return Math.abs(lstart - bootId) > 2000;
  } catch {
    return false;
  }
}

const randomToken = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * O_EXCL('wx') 获取锁;陈锁接管=unlink 后重试 O_EXCL(接管竞态恰一胜):
 * - 死 owner(pid 不存在,或 ps lstart 与记录启动时刻差 >2s);
 * - 同进程遗物(pid==self && bootId==self && 本进程登记空——release 异常残留)。
 * owner 存活/含糊 → 可读错误(带 pid 与陈锁文件路径)。
 */
export function acquireLock(lockPath: string, opts: { resource: string }): HeldLock {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomToken();
    const identity: LockIdentity = { pid: process.pid, bootId: processBootId(), token };
    try {
      writeFileSync(lockPath, JSON.stringify(identity), { flag: "wx" });
      holders.set(lockPath, token);
      return {
        path: lockPath,
        token,
        release: () => {
          if (holders.get(lockPath) === token) holders.delete(lockPath);
          try {
            const raw = readFileSync(lockPath, "utf-8");
            if ((JSON.parse(raw) as LockIdentity).token === token) unlinkSync(lockPath);
          } catch {
            /* 锁已不在/已易主:幂等 */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let info: LockIdentity | undefined;
    try {
      info = JSON.parse(readFileSync(lockPath, "utf-8")) as LockIdentity;
    } catch {
      info = undefined; // 锁内容不可读:含糊,不接管(fail-closed)
    }
    const selfStale =
      info !== undefined &&
      info.pid === process.pid &&
      Math.abs(info.bootId - processBootId()) <= 2000 && // 本进程同期(容差吸收 bootId 舍入抖动)
      !holders.has(lockPath);
    if (selfStale || (info !== undefined && isLockOwnerDead(info.pid, info.bootId))) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* 竞态:他人已接管,重读再判 */
      }
      continue;
    }
    throw new Error(
      `另一进程(pid ${info?.pid ?? "?"})正在使用本数据目录的${opts.resource};确认其退出后重试,或删除陈锁文件 ${lockPath}`,
    );
  }
  throw new Error(`锁竞争未决(重试耗尽): ${lockPath}`);
}
