import { InterventionSchema, type Budget, type Intervention } from "../contracts.js";

/**
 * 运行态注册表(P1-3 D3,纯内存、无 I/O):封装原本散落在 server.ts 闭包里的两个裸 Map。
 *
 * 双键空间(KA3 硬性要求,文档化):
 * - 键空间 A:AbortController 按 **requestId**(launch/resume 用 request.id ?? "" 作键;
 *   cancel 按 body.requestId 原样查,含 undefined 的情形)。
 * - 键空间 B:干预指令队列按 **run.id**(非 requestId)。
 *
 * Registry 纯内存、无 I/O(R1-Q4):pending 指令落盘走 FsProjectStore.savePendingInstructions,
 * 是 per-project 实例,Registry 无从知道项目目录;双写编排由路由层完成(R2-7:先 enqueue 后落盘)。
 */
export class RunRegistry {
  private controllers = new Map<string, AbortController>();
  private instructionQueues = new Map<string, Intervention[]>();
  // P2-3(R1-6):门条件写的 per-run 互斥 + 启动守卫的 per-project 互斥;
  // Promise 链式串行(同键临界区不重叠),链空闲后清理条目避免随键无限增长
  private gateLocks = new Map<string, Promise<unknown>>();
  private projectLocks = new Map<string, Promise<unknown>>();

  private chainLock<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
    const next = (locks.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    locks.set(key, next);
    return next.finally(() => {
      if (locks.get(key) === next) locks.delete(key);
    });
  }

  /** P2-3:per-run 门临界区(gate confirm/cancel 的锁内条件写,confirm×cancel 恰一胜)。 */
  withGateLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.chainLock(this.gateLocks, runId, fn);
  }

  /** P2-3:per-project 启动临界区(单 active-run 守卫与 launch/rerun 之间消 TOCTOU)。 */
  withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.chainLock(this.projectLocks, projectId, fn);
  }

  // ---- 键空间 A:controllers 按 requestId ----

  /** 注册新 controller(set 语义:同键覆盖);返回实例供路由取 signal。 */
  acquire(requestId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller;
  }

  /** delete 语义(路由在 finally 中调用)。 */
  release(requestId: string): void {
    this.controllers.delete(requestId);
  }

  /**
   * 查找键原样透传(含 undefined):有则 abort 并返回 true,无则 false(路由据此 404)。
   * 只 abort 不 delete——delete 由路由 finally 中的 release 完成(现状语义:重复 cancel 仍命中)。
   */
  cancel(requestId: unknown): boolean {
    const controller = this.controllers.get(requestId as string);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // ---- 键空间 C:P2-6(D1/R1-1)——runId → 运行中 Budget ----
  // 加注端点经 budgetOf 拿到编排器注册的同一对象做原地变异(KA2:禁引用替换);
  // 生命周期=流水线起止(startPipeline 注册/finally 注销);resume/gate-confirm 重启丢加注(新账,P2-3 已定)
  private budgets = new Map<string, Budget>();

  /** 流水线启动时注册(编排器入口经 RunOptions.registerBudget 透传到这里)。 */
  registerBudget(runId: string, budget: Budget): void {
    this.budgets.set(runId, budget);
  }

  /** 流水线收尾注销(finally;防长跑 Map 泄漏)。 */
  unregisterBudget(runId: string): void {
    this.budgets.delete(runId);
  }

  /** 加注端点读取(run 不在运行态时由路由层 409)。 */
  budgetOf(runId: string): Budget | undefined {
    return this.budgets.get(runId);
  }

  /**
   * P2-6(D2/R1-5):问内 refine 即时注入的 filtered take——仅取 refine-direction,
   * skip/add 留队列给问间隙 drain(共存分层);同步 peek+按谓词 splice,parallel 下无竞态。
   */
  takeRefinement(runId: string): Intervention | null {
    const q = this.instructionQueues.get(runId);
    if (!q) return null;
    const idx = q.findIndex((i) => i.instruction.type === "refine-direction");
    if (idx < 0) return null;
    return q.splice(idx, 1)[0] ?? null;
  }

  // ---- 键空间 B:instructionQueues 按 run.id ----

  /** push 语义:返回入队后的队列长度。 */
  enqueue(runId: string, record: Intervention): number {
    let q = this.instructionQueues.get(runId);
    if (!q) {
      q = [];
      this.instructionQueues.set(runId, q);
    }
    q.push(record);
    return q.length;
  }

  pendingCount(runId: string): number {
    return this.instructionQueues.get(runId)?.length ?? 0;
  }

  /** 取空内存队列(splice 语义);队列不存在或为空返回 [](调用方据此跳过落盘,R2-2)。 */
  drain(runId: string): Intervention[] {
    const q = this.instructionQueues.get(runId);
    if (!q || q.length === 0) return [];
    return q.splice(0);
  }

  /** resume 回灌:InterventionSchema.safeParse 过滤(合法入队、非法丢弃),返回成功入队数。 */
  restoreFromDisk(runId: string, items: unknown[]): number {
    let restored = 0;
    for (const raw of items) {
      const check = InterventionSchema.safeParse(raw);
      if (check.success) {
        this.enqueue(runId, check.data);
        restored += 1;
      }
    }
    return restored;
  }

  /** 当前队列的防御性拷贝:供 instruct 路由在 enqueue 后整队落盘(R2-7 双写的内存侧读出)。 */
  snapshot(runId: string): Intervention[] {
    return [...(this.instructionQueues.get(runId) ?? [])];
  }
}
