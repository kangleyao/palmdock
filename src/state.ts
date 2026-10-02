// 任务状态机：合法迁移定义在此集中，store 层强制执行。
import type { TaskStatus } from "./types";

export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set([
  "succeeded",
  "failed",
  "interrupted",
]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/** 合法迁移表。interrupted 只能由重启恢复逻辑写入；超时只打标记不改状态。 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["running"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  interrupted: [],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 恢复专用：pending / running 在服务重启时统一标记为 interrupted（结果未知）。 */
export function isRecoverable(status: TaskStatus): boolean {
  return status === "pending" || status === "running";
}
