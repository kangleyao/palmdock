// 任务运行器：进程内调度、适配器执行、超时只提示不终止、失败必须留证据。
import * as crypto from "node:crypto";
import * as timers from "node:timers/promises";
import type {
  Adapter,
  AdapterContext,
  EmitPayload,
  JsonValue,
  Limits,
  TaskError,
  TaskRecord,
} from "./types";
import { guardResultForPersistence } from "./result-guard";

import { Store, StoreError } from "./store";
import { logger } from "./logger";

export class RunnerError extends Error {}

export interface TaskRunnerDeps {
  store: Store;
  getAdapter: (toolId: string) => Adapter | undefined;
  limits: Limits;
}

export class TaskRunner {
  private readonly deps: TaskRunnerDeps;
  private running = 0;

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
  }

  /** 创建任务后调用：触发调度。返回创建好的任务记录。 */
  enqueue(taskId: string): void {
    setImmediate(() => this.dispatch().catch((e) => logger.error(`调度失败：${String(e)}`)));
  }

  /** 调度循环：把最早的 pending 任务拿到 running，直到并发上限。 */
  private async dispatch(): Promise<void> {
    // 串行化调度：同一时刻只有一个 dispatch 在推进，避免超发。
    while (this.running < this.deps.limits.maxConcurrent) {
      const claimed = this.claimNextPending();
      if (!claimed) return;
      this.running += 1;
      // 不 await：任务并发执行；每个任务完成后 drain。
      this.runTask(claimed)
        .catch((e) => logger.error(`任务 ${claimed.id} 运行异常：${String(e)}`))
        .finally(() => {
          this.running -= 1;
          this.dispatch().catch((e) => logger.error(`调度失败：${String(e)}`));
        });
    }
  }

  /** 原子认领最早的 pending 任务（UPDATE ... WHERE status='pending' LIMIT 1）。 */
  private claimNextPending(): TaskRecord | null {
    const store = this.deps.store;
    const row = store.listTasksInStatus("pending", 1)[0] ?? null;
    if (!row) return null;
    try {
      return store.markRunning(row.id);
    } catch (e) {
      // 并发或状态已变：跳过本次（dispatch 会重试）。
      logger.warn(`认领任务 ${row.id} 失败：${String(e)}`);
      return null;
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    const adapter = this.deps.getAdapter(task.toolId);
    if (!adapter) {
      // 理论上不可达（API 创建时校验），仍兜底为失败并留证据。
      this.deps.store.markFailed(task.id, {
        message: `工具 ${task.toolId} 未注册`,
        stage: "lookup",
      });
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    if (adapter.manifest.timeoutMs && adapter.manifest.timeoutMs > 0) {
      timer = setTimeout(() => {
        // 超时语义：只提示“仍未确认结束”。不改状态、不打断执行。
        try {
          this.deps.store.markTimeoutExceeded(task.id);
          this.deps.store.appendEvent(task.id, "system", `已超过建议等待时间（${adapter.manifest!.timeoutMs}ms），仍未确认执行结束；任务继续运行，不会被标记为失败。`, null);
        } catch (e) {
          logger.warn(`超时标记失败 ${task.id}：${String(e)}`);
        }
      }, adapter.manifest.timeoutMs);
    }

    const emit = (e: EmitPayload): void => {
      try {
        this.deps.store.appendEvent(task.id, e.type, e.message, e.percent ?? null);
      } catch (e2) {
        // 单条事件失败不应杀死任务；记日志。
        logger.warn(`事件写入失败 ${task.id}：${String(e2)}`);
      }
    };

    const ctx: AdapterContext = { taskId: task.id, emit };

    try {
      const outcome = await adapter.run(task.input, ctx);
      if (timer) clearTimeout(timer);
      if (outcome.ok) {
        this.handleResult(task, outcome.result);
      } else {
        this.deps.store.markFailed(task.id, outcome.error);
        logger.info(`任务 ${task.id} 失败（适配器返回 error）：${outcome.error.message}`);
      }
    } catch (e) {
      if (timer) clearTimeout(timer);
      const error: TaskError = {
        message: e instanceof Error ? e.message : String(e),
        stage: "adapter.run",
        detail: e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : undefined,
      };
      try {
        this.deps.store.markFailed(task.id, error);
      } catch (e2) {
        // 可能任务已被重启恢复为 interrupted；如实记录，不掩盖。
        logger.warn(`标记失败结果时出错 ${task.id}：${String(e2)}`);
      }
      logger.info(`任务 ${task.id} 失败（抛出异常）：${error.message}`);
    }
  }

  /** 结果大小校验与截断：超出上限时截断并存证，而非假装成功或悄悄丢。 */
  private handleResult(task: TaskRecord, result: JsonValue): void {
    const guarded = guardResultForPersistence(result, this.deps.limits.maxResultBytes);
    if (guarded.status === "unserializable") {
      this.deps.store.markFailed(task.id, guarded.error);
      return;
    }
    if (guarded.status === "truncated") {
      this.deps.store.appendEvent(
        task.id,
        "system",
        `结果体积 ${guarded.bytes} 字节超过上限 ${this.deps.limits.maxResultBytes} 字节，已截断保存预览。`,
        null
      );
      this.deps.store.markSucceeded(task.id, guarded.value);
      logger.info(`任务 ${task.id} 成功（结果已截断：${guarded.bytes} 字节）`);
      return;
    }
    this.deps.store.markSucceeded(task.id, guarded.value);
    logger.info(`任务 ${task.id} 成功`);
  }

}

/** 生成幂等参数指纹：toolId + 规范化输入。 */
export function paramsHashOf(toolId: string, input: unknown): string {
  const normalized = JSON.stringify({ tool: toolId, input });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** 重启恢复：pending / running 一律 interrupted，写系统事件，不重跑、不伪称。 */
export function recoverInterruptedTasks(store: Store): { interrupted: number } {
  const recoverable = store.listRecoverable();
  for (const t of recoverable) {
    try {
      store.markInterrupted(t.id, t.status);
      store.appendEvent(
        t.id,
        "system",
        `服务重启时本任务处于 ${t.status} 状态：执行被中断，结果未知；适配器随服务进程运行，若其派生了独立子进程，该进程可能仍在运行。本服务不会自动重跑，也不会声称其已停止。`,
        null
      );
    } catch (e) {
      logger.error(`恢复任务 ${t.id} 失败：${String(e)}`);
    }
  }
  if (recoverable.length > 0) {
    logger.info(`重启恢复：${recoverable.length} 个未完成任务标记为 interrupted（结果未知）`);
  }
  return { interrupted: recoverable.length };
}

/** 测试/工具用：占用调度槽的确定性等待。 */
export function delay(ms: number): Promise<void> {
  return timers.setTimeout(ms);
}
