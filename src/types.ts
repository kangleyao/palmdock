// 共享类型定义：任务状态机、适配器契约、事件与持久化记录。
import { z } from "zod";

/** 任务状态。interrupted = 服务重启中断了执行，结果未知（不伪称已停止或失败）。 */
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted";

/** 表单字段类型（公共页面仅支持这几种明确、有限的简单字段）。 */
export type FieldType = "text" | "textarea" | "number" | "boolean" | "select";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  options?: string[];
  required: boolean;
  placeholder?: string;
  help?: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 适配器对外暴露的清单（inputSchema 是输入契约的唯一来源，fields 由它派生）。 */
export interface ToolManifest {
  id: string;
  name: string;
  description: string;
  /** 建议等待时间：超过后只提示“仍未确认结束”，不标记失败、不打断执行。 */
  timeoutMs?: number;
  inputSchema: z.ZodType<unknown>;
  /** 工具形态（默认 task）：task=一次性任务；session=仅会话；both=两者皆可。 */
  mode?: ToolMode;
  /** 会话能力声明（缺省=全部不支持，公共页面不得为其渲染会话入口）。 */
  capabilities?: Partial<AdapterCapabilities>;

  fields: FieldDef[];
  /** 契约测试用的合法/非法输入样本。 */
  examples?: { valid: unknown; invalid: unknown };
}

export type EmitType = "progress" | "info" | "warning";

export interface EmitPayload {
  type: EmitType;
  message: string;
  /** 0-100；没有比例进度时省略，前端退化为“执行中 + 消息流”。 */
  percent?: number;
}

export type EmitFn = (e: EmitPayload) => void;

export interface AdapterContext {
  taskId: string;
  emit: EmitFn;
}

export interface TaskError {
  message: string;
  detail?: string;
  stage?: string;
}

export type AdapterRunResult =
  | { ok: true; result: JsonValue }
  | { ok: false; error: TaskError };

/** 适配器：受信任的进程内代码（不是沙箱，测试不等于隔离）。 */
export interface Adapter {
  manifest: ToolManifest;
  run(input: unknown, ctx: AdapterContext): Promise<AdapterRunResult>;
}

export interface TaskRecord {
  id: string;
  toolId: string;
  status: TaskStatus;
  input: JsonValue;
  idempotencyKey: string;
  paramsHash: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutMarkedAt: string | null;
  result: JsonValue | null;
  error: TaskError | null;
  eventsCapped: boolean;
}

export type EventRecordType = "progress" | "info" | "warning" | "system";

export interface EventRecord {
  seq: number;
  taskId: string;
  type: EventRecordType;
  message: string;
  percent: number | null;
  createdAt: string;
}

/** 运行限制（构造时注入，可被测试覆盖）。 */
export interface Limits {
  maxTasks: number;
  maxEventsPerTask: number;
  maxEventMessageChars: number;
  maxResultBytes: number;
  maxInputBytes: number;
  maxConcurrent: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTasks: 500,
  maxEventsPerTask: 200,
  maxEventMessageChars: 2000,
  maxResultBytes: 64 * 1024,
  maxInputBytes: 16 * 1024,
  maxConcurrent: 4,
};

// ---------------- 第二层：会话型端 ----------------

/** 适配器明确声明的会话能力。未声明者一律视为不支持，公共页面不得渲染入口。 */
export interface AdapterCapabilities {
  /** 多轮会话：可创建会话、在会话内发送消息并获得该轮结果。 */
  sessions: boolean;
  /** 列出历史会话（可恢复、可继续的会话清单）。 */
  listSessions: boolean;
  /** 持续产生输出事件（流式输出），而非一次性返回结果。 */
  streaming: boolean;
  /** 执行中向手机提出问题并阻塞等待回答。 */
  askUser: boolean;
}

/** 全部能力都不支持：第一层一次性工具的默认形态。 */
export const NO_CAPABILITIES: AdapterCapabilities = {
  sessions: false,
  listSessions: false,
  streaming: false,
  askUser: false,
};

/** 工具形态：task=一次性任务（第一层）；session=仅会话；both=两者皆可。 */
export type ToolMode = "task" | "session" | "both";

/**
 * 会话轮次状态。公共协议必须能区分这五种处境：
 * 失败（failed）、中断结果未知（interrupted）、仍在输出（streaming）、
 * 等待手机回答（awaiting_answer）、用户已回答后继续（answered）。
 */
export type TurnStatus =
  | "pending"
  | "streaming"
  | "awaiting_answer"
  | "answered"
  | "succeeded"
  | "failed"
  | "interrupted";

export interface SessionRecord {
  id: string;
  toolId: string;
  createdAt: string;
}

/** 执行中提出的问题（仅 awaiting_answer 时非空）。 */
export interface PendingQuestion {
  prompt: string;
  /** 明确可选项（至少 2 个）。手机只能从中选一个作为回答。 */
  options: string[];
  askedAt: string;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  status: TurnStatus;
  message: string;
  /** 用户已提交的回答（幂等证据：同回答重复提交不会触发第二次继续执行）。 */
  answer: string | null;
  result: JsonValue | null;
  error: TaskError | null;
  idempotencyKey: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pendingQuestion: PendingQuestion | null;
  eventsCapped: boolean;
}

/** 第二层适配器契约：在第一层之上声明能力并实现“一轮会话交互”。 */
export interface SessionAdapter extends Adapter {
  runTurn(req: TurnRequest, ctx: TurnContext): Promise<TurnResult>;
}

export interface TurnRequest {
  sessionId: string;
  message: string;
  /** 本会话此前各轮摘要（时间顺序，不可变历史），供端维持上下文。 */
  history: ReadonlyArray<{ message: string; answer: string | null }>;
}

export interface TurnContext {
  turnId: string;
  /** 流式输出事件：复用第一层事件模型（持久化、上限、截断规则与任务一致）。 */
  emit: EmitFn;
  /**
   * 向手机提问并阻塞等待回答。
   * options 至少 2 个明确选项，手机只能从中选一个；
   * 调用后该轮进入 awaiting_answer，手机回答后进入 answered 并 resolve；
   * 同一回答重复提交只 resolve 一次（由公共协议保证，端无需自行去重）。
   */
  ask(prompt: string, options: string[]): Promise<string>;
  /** 关闭信号：服务退出时 abort；端应立即终止派生资源（如杀掉子进程），不得拽住事件循环。 */
  signal: AbortSignal;
}

export type TurnResult = AdapterRunResult;
