// 结果守卫：把适配器返回值序列化并施加体积限制，超限则截断存证。
// 第一层（任务）与第二层（会话轮次）共用同一规则，避免两处实现漂移。
import type { JsonValue, TaskError } from "./types";

export type GuardedResult =
  | { status: "ok"; value: JsonValue }
  | { status: "truncated"; value: JsonValue; bytes: number }
  | { status: "unserializable"; error: TaskError };

/**
 * 序列化结果并按 limit 截断。
 * - 无法序列化 → unserializable（调用方按失败处理并留证据）
 * - 超过 limit → truncated：保留预览 + 原始字节数，调用方应写一条系统事件留证
 */
export function guardResultForPersistence(result: JsonValue, limit: number): GuardedResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch (e) {
    return {
      status: "unserializable",
      error: {
        message: `结果无法序列化为 JSON：${e instanceof Error ? e.message : String(e)}`,
        stage: "result.serialize",
      },
    };
  }
  if (serialized.length > limit) {
    const truncated: JsonValue = {
      truncated: true,
      originalBytes: serialized.length,
      preview: serialized.slice(0, Math.min(8192, limit)),
    };
    return { status: "truncated", value: truncated, bytes: serialized.length };
  }
  return { status: "ok", value: result };
}
