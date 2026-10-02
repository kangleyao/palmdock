// 会话轮次状态机：合法迁移定义在此集中，store 层强制执行（与第一层 state.ts 对称）。
import type { TurnStatus } from "./types";

/** 终态：结果已定（成功 / 失败 / 中断）。 */
export const TERMINAL_TURN_STATES: ReadonlySet<TurnStatus> = new Set([
  "succeeded",
  "failed",
  "interrupted",
]);

export function isTurnTerminal(status: TurnStatus): boolean {
  return TERMINAL_TURN_STATES.has(status);
}

/**
 * 合法迁移表。
 * - streaming → awaiting_answer：端在执行中提出问题
 * - awaiting_answer → answered：手机回答（只发生一次，由回答通道的事务迁移保证）
 * - answered → awaiting_answer：一次对话中可能追问多次
 * - interrupted 只能由重启恢复逻辑写入；超时只打标记不改状态（与任务一致）
 */
const TURN_TRANSITIONS: Record<TurnStatus, TurnStatus[]> = {
  pending: ["streaming"],
  streaming: ["awaiting_answer", "succeeded", "failed"],
  awaiting_answer: ["answered", "failed"],
  answered: ["awaiting_answer", "succeeded", "failed"],
  succeeded: [],
  failed: [],
  interrupted: [],
};

export function isValidTurnTransition(from: TurnStatus, to: TurnStatus): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

/** 活跃轮次：尚未进入终态（创建消息时据此限制每会话最多一个活跃轮次）。 */
export function isTurnLive(status: TurnStatus): boolean {
  return !TERMINAL_TURN_STATES.has(status);
}

/** 恢复专用：服务重启时未终结的轮次一律标记 interrupted（结果未知），不重跑、不伪称。 */
export const RECOVERABLE_TURN_STATUSES: TurnStatus[] = [
  "pending",
  "streaming",
  "awaiting_answer",
  "answered",
];
