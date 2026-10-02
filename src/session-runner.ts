// 会话轮次运行器：第二层执行核心（与第一层 TaskRunner 对称）。
// 职责：认领 pending 轮次 → 驱动 SessionAdapter.runTurn → 持久化事件/状态/结果；
//      端调用 ctx.ask() 时把轮次挂起为 awaiting_answer，手机回答后恢复且只恢复一次。
// 服务重启时未终结的轮次不重跑，由恢复逻辑标记 interrupted（结果未知），与任务一致。
import type {
  EmitPayload,
  JsonValue,
  Limits,
  PendingQuestion,
  SessionAdapter,
  TaskError,
  TurnContext,
  TurnRecord,
} from "./types";
import type { Store } from "./store";
import { logger } from "./logger";
import { guardResultForPersistence } from "./result-guard";

export interface SessionRunnerDeps {
  store: Store;
  getSessionAdapter: (toolId: string) => SessionAdapter | undefined;
  limits: Limits;
}

export class SessionRunner {
  private readonly deps: SessionRunnerDeps;
  private running = 0;
  /** turnId → 回答 resolver。只在 awaiting_answer 期间存在；轮次终结时清除。 */
  private readonly pendingAnswers = new Map<string, (answer: string) => void>();
  /** turnId → 关闭控制器。dispose 时统一 abort，端据此杀子进程。 */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(deps: SessionRunnerDeps) {
    this.deps = deps;
  }


  /** 创建轮次后调用：触发调度。 */
  enqueueTurn(turnId: string): void {
    setImmediate(() => this.dispatch().catch((e) => logger.error(`会话调度失败：${String(e)}`)));
  }

  /** 调度循环：最早的 pending 轮次拿到 streaming，直到并发上限（每会话至多一个活跃轮次，由存储层保证）。 */
  private async dispatch(): Promise<void> {
    while (this.running < this.deps.limits.maxConcurrent) {
      const claimed = this.claimNextPendingTurn();
      if (!claimed) return;
      this.running += 1;
      this.runTurn(claimed)
        .catch((e) => logger.error(`轮次 ${claimed.id} 运行异常：${String(e)}`))
        .finally(() => {
          this.running -= 1;
          this.dispatch().catch((e) => logger.error(`会话调度失败：${String(e)}`));
        });
    }
  }

  /** 原子认领最早的 pending 轮次。 */
  private claimNextPendingTurn(): TurnRecord | null {
    const store = this.deps.store;
    const row = store.listTurnsInStatus("pending", 1)[0] ?? null;
    if (!row) return null;
    try {
      return store.markTurnStreaming(row.id);
    } catch (e) {
      logger.warn(`认领轮次 ${row.id} 失败：${String(e)}`);
      return null;
    }
  }

  private async runTurn(turn: TurnRecord): Promise<void> {
    let toolId: string;
    try {
      toolId = this.toolIdOf(turn);
    } catch (e) {
      this.deps.store.markTurnFailed(turn.id, {
        message: e instanceof Error ? e.message : String(e),
        stage: "lookup",
      });
      return;
    }
    const adapter = this.deps.getSessionAdapter(toolId);
    if (!adapter) {
      this.deps.store.markTurnFailed(turn.id, {
        message: `工具 ${toolId} 未注册或不支持会话能力`,
        stage: "lookup",
      });
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    if (adapter.manifest.timeoutMs && adapter.manifest.timeoutMs > 0) {
      timer = setTimeout(() => {
        // 超时语义与任务一致：只提示“仍未确认结束”，不改状态、不打断执行。
        try {
          this.deps.store.appendTurnEvent(
            turn.id,
            "system",
            `已超过建议等待时间（${adapter.manifest!.timeoutMs}ms），仍未确认执行结束；轮次继续运行，不会被标记为失败。`,
            null
          );
        } catch (e) {
          logger.warn(`超时标记失败 ${turn.id}：${String(e)}`);
        }
      }, adapter.manifest.timeoutMs);
    }


    const emit = (e: EmitPayload): void => {
      try {
        this.deps.store.appendTurnEvent(turn.id, e.type, e.message, e.percent ?? null);
      } catch (e2) {
        logger.warn(`轮次事件写入失败 ${turn.id}：${String(e2)}`);
      }
    };

    const ask = (prompt: string, options: string[]): Promise<string> => {
      return this.askQuestion(turn.id, prompt, options, emit);
    };

    const abortController = new AbortController();
    this.abortControllers.set(turn.id, abortController);
    const ctx: TurnContext = { turnId: turn.id, emit, ask, signal: abortController.signal };


    try {
      const outcome = await adapter.runTurn(
        { sessionId: turn.sessionId, message: turn.message, history: this.historyOf(turn) },
        ctx
      );
      if (timer) clearTimeout(timer);
      this.pendingAnswers.delete(turn.id);
      this.abortControllers.delete(turn.id);
      if (outcome.ok) {
        this.handleTurnResult(turn, outcome.result);
      } else {
        this.deps.store.markTurnFailed(turn.id, outcome.error);
        logger.info(`轮次 ${turn.id} 失败（端返回 error）：${outcome.error.message}`);
      }
    } catch (e) {
      if (timer) clearTimeout(timer);
      this.pendingAnswers.delete(turn.id);
      this.abortControllers.delete(turn.id);
      const error: TaskError = {
        message: e instanceof Error ? e.message : String(e),
        stage: "adapter.runTurn",
        detail: e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : undefined,
      };
      try {
        this.deps.store.markTurnFailed(turn.id, error);
      } catch (e2) {
        // 可能轮次已被重启恢复为 interrupted；如实记录，不掩盖。
        logger.warn(`标记轮次失败结果时出错 ${turn.id}：${String(e2)}`);
      }
      logger.info(`轮次 ${turn.id} 失败（抛出异常）：${error.message}`);
    }
  }

  private toolIdOf(turn: TurnRecord): string {
    const session = this.deps.store.getSession(turn.sessionId);
    if (!session) {
      throw new Error(`轮次 ${turn.id} 引用的会话 ${turn.sessionId} 不存在`);
    }
    return session.toolId;
  }

  /** 该轮之前的会话历史（时间顺序，供端维持上下文）。 */
  private historyOf(turn: TurnRecord): Array<{ message: string; answer: string | null }> {
    return this.deps.store
      .listTurnsOfSession(turn.sessionId)
      .filter((t) => t.createdAt < turn.createdAt)
      .map((t) => ({ message: t.message, answer: t.answer }));
  }

  /** 端提出的问题：持久化后挂起，等待回答通道恢复。 */
  private askQuestion(
    turnId: string,
    prompt: string,
    options: string[],
    emit: (e: EmitPayload) => void
  ): Promise<string> {
    const errors: string[] = [];
    if (typeof prompt !== "string" || prompt.trim().length === 0) errors.push("prompt 必须为非空字符串");
    if (!Array.isArray(options) || options.length < 2) errors.push("options 至少需要 2 个明确选项");
    else {
      const distinct = new Set(options.map(String));
      if (distinct.size !== options.length) errors.push("options 不得重复");
      for (const o of options) if (typeof o !== "string" || o.trim().length === 0) errors.push("options 每项须为非空字符串");
    }
    if (errors.length > 0) {
      return Promise.reject(new Error(`提问参数不合法：${errors.join("；")}`));
    }

    const question: PendingQuestion = {
      prompt: prompt.trim(),
      options: options.map(String),
      askedAt: new Date().toISOString(),
    };
    try {
      this.deps.store.markTurnAwaiting(turnId, question);
    } catch (e) {
      return Promise.reject(new Error(`挂起问题失败（状态可能已变更）：${e instanceof Error ? e.message : String(e)}`));
    }
    emit({
      type: "info",
      message: `【等待你的回答】${question.prompt}（选项：${question.options.join(" / ")}）`,
    });

    return new Promise<string>((resolve, reject) => {
      this.pendingAnswers.set(turnId, resolve);
      // 服务关闭：等待中的提问直接拒绝，端收到信号后杀子进程，轮次由终结逻辑或重启恢复处理。
      const controller = this.abortControllers.get(turnId);
      if (controller) {
        if (controller.signal.aborted) {
          this.pendingAnswers.delete(turnId);
          reject(new Error("轮次被关闭信号中止"));
          return;
        }
        controller.signal.addEventListener("abort", () => {
          if (this.pendingAnswers.delete(turnId)) {
            reject(new Error("轮次被关闭信号中止（服务退出）"));
          }
        });
      }
    });
  }

  /**
   * 手机回答通道（幂等）：
   * - 仅当轮次处于 awaiting_answer 且迁移到 answered 成功时 resolve 一次；
   * - 重复提交同一回答由调用方依据持久化记录判重，不会走到这里；
   * - 返回 false 表示该轮次当前没有等待中的 resolver。
   */
  answerTurn(turnId: string, answer: string): boolean {
    const resolver = this.pendingAnswers.get(turnId);
    if (!resolver) return false;
    this.pendingAnswers.delete(turnId);
    resolver(answer);
    return true;
  }

  /**
   * 服务关闭时调用：abort 全部在途轮次的信号。
   * 端据此终止派生资源（子进程等）；轮次状态不做改动——若进程随之退出，
   * 下次启动由恢复逻辑标记 interrupted（结果未知），既不伪称完成也不假装正常停止。
   */
  dispose(): void {
    for (const controller of this.abortControllers.values()) {
      if (!controller.signal.aborted) controller.abort();
    }
    this.abortControllers.clear();
  }


  /** 结果大小校验与截断：与任务完全相同的规则。 */
  private handleTurnResult(turn: TurnRecord, result: JsonValue): void {
    const guarded = guardResultForPersistence(result, this.deps.limits.maxResultBytes);
    if (guarded.status === "unserializable") {
      this.deps.store.markTurnFailed(turn.id, guarded.error);
      return;
    }
    if (guarded.status === "truncated") {
      this.deps.store.appendTurnEvent(
        turn.id,
        "system",
        `结果体积 ${guarded.bytes} 字节超过上限 ${this.deps.limits.maxResultBytes} 字节，已截断保存预览。`,
        null
      );
      this.deps.store.markTurnSucceeded(turn.id, guarded.value);
      logger.info(`轮次 ${turn.id} 成功（结果已截断：${guarded.bytes} 字节）`);
      return;
    }
    this.deps.store.markTurnSucceeded(turn.id, guarded.value);
    logger.info(`轮次 ${turn.id} 成功`);
  }
}

/** 重启恢复：未终结轮次一律 interrupted，写系统事件，不重跑、不伪称。 */
export function recoverInterruptedTurns(store: Store): { interrupted: number } {
  const recoverable = store.listRecoverableTurns();
  for (const t of recoverable) {
    try {
      store.markTurnInterrupted(t.id, t.status);
      store.appendTurnEvent(
        t.id,
        "system",
        `服务重启时本轮处于 ${t.status} 状态：执行被中断，结果未知；端派生的独立子进程可能仍在运行（stdio 类端在父进程退出后通常自行终止）。本服务不会自动重跑，也不会声称其已停止。`,
        null
      );
    } catch (e) {
      logger.error(`恢复轮次 ${t.id} 失败：${String(e)}`);
    }
  }
  if (recoverable.length > 0) {
    logger.info(`重启恢复：${recoverable.length} 个未终结轮次标记为 interrupted（结果未知）`);
  }
  return { interrupted: recoverable.length };
}
