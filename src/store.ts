// SQLite 持久层。better-sqlite3 同步事务 = 单进程内写串行化 + 原子提交；
// 冲突恢复语义明确（WAL + synchronous FULL）。单限制：只支持单服务实例写同一库。
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EventRecord,
  EventRecordType,
  JsonValue,
  PendingQuestion,
  SessionRecord,
  TaskError,
  TaskRecord,
  TaskStatus,
  TurnRecord,
  TurnStatus,
} from "./types";
import { TERMINAL_TURN_STATES } from "./session-state";
import type { TurnChange } from "./turn-bus";


export class StoreError extends Error {}

/** 会话已有活跃轮次时 createTurn 抛出；携带已存在轮次 id 供调用方回链。 */
export class SessionBusyError extends StoreError {
  constructor(public sessionId: string, public existingTurnId: string) {
    super(`会话 ${sessionId} 已有活跃轮次 ${existingTurnId}：每会话同时只能进行一轮`);
    this.name = "SessionBusyError";
  }
}


interface NewTaskInput {
  id: string;
  toolId: string;
  input: JsonValue;
  idempotencyKey: string;
  paramsHash: string;
}

export class Store {
  private readonly db: DatabaseType;
  private readonly maxTasks: number;
  private readonly maxEventsPerTask: number;
  private readonly maxEventMessageChars: number;
  private readonly onTurnChange: ((change: TurnChange) => void) | undefined;
  constructor(
    dbPath: string,
    opts: {
      maxTasks: number;
      maxEventsPerTask: number;
      maxEventMessageChars: number;
      /** 轮次事件/状态提交后的同步通知（第二层推流用）；不传则纯持久层。 */
      onTurnChange?: (change: TurnChange) => void;
    }
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.maxTasks = opts.maxTasks;
    this.maxEventsPerTask = opts.maxEventsPerTask;
    this.maxEventMessageChars = opts.maxEventMessageChars;
    this.onTurnChange = opts.onTurnChange;
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        timeout_marked_at TEXT,
        result TEXT,
        error TEXT,
        events_capped INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        percent INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        answer TEXT,
        idempotency_key TEXT NOT NULL,
        result TEXT,
        error TEXT,
        pending_question TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        events_capped INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_idempotency ON turns(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);

      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
    `);
  }

  // ---------- 任务 ----------

  createTask(input: NewTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const insert = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT INTO tasks (id, tool_id, status, input, idempotency_key, params_hash, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?)`
      );
      stmt.run(input.id, input.toolId, JSON.stringify(input.input), input.idempotencyKey, input.paramsHash, now);
      const created = this.getTaskRow(input.id);
      if (!created) throw new StoreError("任务插入后读不到：" + input.id);
      this.pruneOldTasks();
      return created;
    });
    return this.toRecord(insert());
  }

  getTask(id: string): TaskRecord | null {
    const row = this.getTaskRow(id);
    return row ? this.toRecord(row) : null;
  }

  getTaskByIdempotencyKey(key: string): TaskRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE idempotency_key = ?`)
      .get(key) as TaskRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  listTasks(limit: number): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 200))) as TaskRow[];
    return rows.map((r) => this.toRecord(r));
  }

  listTasksInStatus(status: TaskStatus, limit: number): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?`)
      .all(status, Math.max(1, limit)) as TaskRow[];
    return rows.map((r) => this.toRecord(r));
  }

  listRecoverable(): { id: string; toolId: string; status: TaskStatus }[] {
    const rows = this.db
      .prepare(`SELECT id, tool_id, status FROM tasks WHERE status IN ('pending', 'running') ORDER BY created_at ASC`)
      .all() as { id: string; tool_id: string; status: TaskStatus }[];
    return rows.map((r) => ({ id: r.id, toolId: r.tool_id, status: r.status }));
  }

  /** 带状态前置条件的迁移；非法迁移抛错（防并发/错误路径乱序）。 */
  private transition(id: string, from: TaskStatus[], to: TaskStatus, sets: Partial<TaskRow>): TaskRecord {
    const tx = this.db.transaction(() => {
      const setClauses: string[] = ["status = ?"];
      const values: unknown[] = [to];
      for (const [k, v] of Object.entries(sets)) {
        setClauses.push(`${k} = ?`);
        values.push(v);
      }
      values.push(id);
      const placeholders = from.map(() => "?").join(",");
      const res = this.db
        .prepare(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
        .run(...values, ...from);
      if (res.changes !== 1) {
        throw new StoreError(`状态迁移失败 ${id}：${from.join("|")} -> ${to}（共更新 ${res.changes} 行）`);
      }
      const row = this.getTaskRow(id);
      if (!row) throw new StoreError("迁移后读不到任务：" + id);
      // 进入终态时裁剪历史，保证终态记录不超过 maxTasks（非终态任务永不裁剪）。
      if (to !== "running") this.pruneOldTasks();
      return row;
    });
    return this.toRecord(tx());
  }

  markRunning(id: string): TaskRecord {
    return this.transition(id, ["pending"], "running", { started_at: new Date().toISOString() });
  }

  markSucceeded(id: string, result: JsonValue): TaskRecord {
    return this.transition(id, ["running"], "succeeded", {
      finished_at: new Date().toISOString(),
      result: JSON.stringify(result),
    });
  }

  markFailed(id: string, error: TaskError): TaskRecord {
    return this.transition(id, ["running"], "failed", {
      finished_at: new Date().toISOString(),
      error: JSON.stringify(error),
    });
  }

  markInterrupted(id: string, priorStatus: TaskStatus): TaskRecord {
    return this.transition(id, ["pending", "running"], "interrupted", {
      finished_at: new Date().toISOString(),
    });
  }

  /** 超时只打标记，不改状态（任务仍是 running，不算失败）。 */
  markTimeoutExceeded(id: string): void {
    this.db.prepare(`UPDATE tasks SET timeout_marked_at = ? WHERE id = ? AND status = 'running' AND timeout_marked_at IS NULL`)
      .run(new Date().toISOString(), id);
  }

  // ---------- 事件 ----------

  appendEvent(taskId: string, type: EventRecordType, message: string, percent: number | null): EventRecord | null {
    const tx = this.db.transaction(() => {
      const task = this.getTaskRow(taskId);
      if (!task) throw new StoreError("事件写入失败：任务不存在 " + taskId);
      const count = this.db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ?`)
        .get(taskId) as { n: number };
      if (count.n >= this.maxEventsPerTask) {
        if (task.events_capped === 0) {
          this.db.prepare(`UPDATE tasks SET events_capped = 1 WHERE id = ?`).run(taskId);
          const now = new Date().toISOString();
          this.db
            .prepare(`INSERT INTO events (task_id, type, message, percent, created_at) VALUES (?, 'system', ?, NULL, ?)`)
            .run(taskId, `[系统] 事件数已达上限（${this.maxEventsPerTask} 条），后续事件被丢弃`, now);
        }
        return null; // 已达上限：静默丢弃（标记事件只写一次）
      }
      const truncated = message.length > this.maxEventMessageChars
        ? message.slice(0, this.maxEventMessageChars) + `…[已截断，原始长度 ${message.length}]`
        : message;
      const now = new Date().toISOString();
      const res = this.db
        .prepare(`INSERT INTO events (task_id, type, message, percent, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(taskId, type, truncated, percent === undefined ? null : percent, now);
      const row = this.db
        .prepare(`SELECT * FROM events WHERE seq = ?`)
        .get(Number(res.lastInsertRowid)) as EventRow;
      return this.toEvent(row);
    });
    return tx();
  }

  getEvents(taskId: string, sinceSeq?: number): EventRecord[] {
    const rows = sinceSeq === undefined
      ? this.db.prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC`).all(taskId)
      : this.db.prepare(`SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC`).all(taskId, sinceSeq);
    return (rows as EventRow[]).map((r) => this.toEvent(r));
  }

  /** 会话级事件流（第二层推流用）：该会话所有轮次中 seq 大于 sinceSeq 的事件，按 seq 升序。 */
  listSessionEventsAfter(sessionId: string, sinceSeq: number): EventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events e
         JOIN turns t ON t.id = e.task_id
         WHERE t.session_id = ? AND e.seq > ?
         ORDER BY e.seq ASC`
      )
      .all(sessionId, sinceSeq) as EventRow[];
    return rows.map((r) => this.toEvent(r));
  }

  // ---------- 会话与轮次（第二层） ----------

  createSession(id: string, toolId: string): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO sessions (id, tool_id, created_at) VALUES (?, ?, ?)`)
      .run(id, toolId, now);
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    if (!row) throw new StoreError("会话插入后读不到：" + id);
    return { id: row.id, toolId: row.tool_id, createdAt: row.created_at };
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? { id: row.id, toolId: row.tool_id, createdAt: row.created_at } : null;
  }

  listSessions(
    limit: number
  ): Array<
    SessionRecord & {
      turnCount: number;
      lastTurnStatus: TurnStatus | null;
      lastTurnAt: string | null;
      lastTurnMessage: string | null;
    }
  > {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count,
         (SELECT t.status FROM turns t WHERE t.session_id = s.id ORDER BY t.created_at DESC LIMIT 1) AS last_turn_status,
         (SELECT t.created_at FROM turns t WHERE t.session_id = s.id ORDER BY t.created_at DESC LIMIT 1) AS last_turn_at,
         (SELECT t.message FROM turns t WHERE t.session_id = s.id ORDER BY t.created_at DESC LIMIT 1) AS last_turn_message
         FROM sessions s ORDER BY s.created_at DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 200))) as Array<
      SessionRow & {
        turn_count: number;
        last_turn_status: string | null;
        last_turn_at: string | null;
        last_turn_message: string | null;
      }
    >;
    return rows.map((r) => ({
      id: r.id,
      toolId: r.tool_id,
      createdAt: r.created_at,
      turnCount: r.turn_count,
      lastTurnStatus: r.last_turn_status as TurnStatus | null,
      lastTurnAt: r.last_turn_at,
      lastTurnMessage: r.last_turn_message,
    }));
  }

  createTurn(input: {
    id: string;
    sessionId: string;
    message: string;
    idempotencyKey: string;
  }): TurnRecord {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      // 同一会话已存在活跃轮次 → 事务内拒绝（并发安全）
      const live = this.getLiveTurnRow(input.sessionId);
      if (live) {
        throw new SessionBusyError(input.sessionId, live.id);
      }
      this.db
        .prepare(
          `INSERT INTO turns (id, session_id, status, message, idempotency_key, created_at)
           VALUES (?, ?, 'pending', ?, ?, ?)`
        )
        .run(input.id, input.sessionId, input.message, input.idempotencyKey, now);
      const created = this.getTurnRow(input.id);
      if (!created) throw new StoreError("轮次插入后读不到：" + input.id);
      return created;
    });
    return this.toTurnRecord(tx());
  }

  getTurn(id: string): TurnRecord | null {
    const row = this.getTurnRow(id);
    return row ? this.toTurnRecord(row) : null;
  }

  getTurnByIdempotencyKey(key: string): TurnRecord | null {
    const row = this.db.prepare(`SELECT * FROM turns WHERE idempotency_key = ?`).get(key) as TurnRow | undefined;
    return row ? this.toTurnRecord(row) : null;
  }

  /** 该会话的活跃（未终结）轮次；没有则 null。 */
  getLiveTurnOfSession(sessionId: string): TurnRecord | null {
    const row = this.getLiveTurnRow(sessionId);
    return row ? this.toTurnRecord(row) : null;
  }

  listTurnsOfSession(sessionId: string): TurnRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as TurnRow[];
    return rows.map((r) => this.toTurnRecord(r));
  }

  listTurnsInStatus(status: TurnStatus, limit: number): TurnRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE status = ? ORDER BY created_at ASC LIMIT ?`)
      .all(status, Math.max(1, limit)) as TurnRow[];
    return rows.map((r) => this.toTurnRecord(r));
  }

  listRecoverableTurns(): Array<{ id: string; sessionId: string; status: TurnStatus }> {
    const rows = this.db
      .prepare(`SELECT id, session_id, status FROM turns WHERE status IN ('pending','streaming','awaiting_answer','answered') ORDER BY created_at ASC`)
      .all() as { id: string; session_id: string; status: string }[];
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, status: r.status as TurnStatus }));
  }

  private getLiveTurnRow(sessionId: string): TurnRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM turns WHERE session_id = ? AND status IN ('pending','streaming','awaiting_answer','answered') ORDER BY created_at DESC LIMIT 1`
      )
      .get(sessionId) as TurnRow | undefined;
    return row ?? null;
  }

  /** 带状态前置条件的轮次迁移；非法迁移抛错（防并发/错误路径乱序）。 */
  private transitionTurn(id: string, from: TurnStatus[], to: TurnStatus, sets: Partial<TurnRow>): TurnRecord {
    const tx = this.db.transaction(() => {
      const setClauses: string[] = ["status = ?"];
      const values: unknown[] = [to];
      for (const [k, v] of Object.entries(sets)) {
        setClauses.push(`${k} = ?`);
        values.push(v);
      }
      values.push(id);
      const placeholders = from.map(() => "?").join(",");
      const res = this.db
        .prepare(`UPDATE turns SET ${setClauses.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
        .run(...values, ...from);
      if (res.changes !== 1) {
        throw new StoreError(`轮次状态迁移失败 ${id}：${from.join("|")} -> ${to}（共更新 ${res.changes} 行）`);
      }
      const row = this.getTurnRow(id);
      if (!row) throw new StoreError("迁移后读不到轮次：" + id);
      if (TERMINAL_TURN_STATES.has(to)) this.pruneOldTurns();
      return row;
    });
    const record = this.toTurnRecord(tx());
    // 事务已提交：通知推流订阅者重读已提交数据（总线本身不传业务负载）。
    this.notifyTurn(record.id, record.sessionId);
    return record;
  }

  markTurnStreaming(id: string): TurnRecord {
    return this.transitionTurn(id, ["pending"], "streaming", { started_at: new Date().toISOString() });
  }

  markTurnAwaiting(id: string, question: PendingQuestion): TurnRecord {
    return this.transitionTurn(id, ["streaming", "answered"], "awaiting_answer", {
      pending_question: JSON.stringify(question),
    });
  }

  /** awaiting_answer → answered 的事务迁移：同一回答的重复提交只会成功一次。 */
  markTurnAnswered(id: string, answer: string): TurnRecord {
    return this.transitionTurn(id, ["awaiting_answer"], "answered", {
      answer,
      pending_question: null,
    });
  }

  markTurnSucceeded(id: string, result: JsonValue): TurnRecord {
    return this.transitionTurn(id, ["streaming", "awaiting_answer", "answered"], "succeeded", {
      finished_at: new Date().toISOString(),
      result: JSON.stringify(result),
      pending_question: null,
    });
  }

  markTurnFailed(id: string, error: TaskError): TurnRecord {
    return this.transitionTurn(id, ["streaming", "awaiting_answer", "answered"], "failed", {
      finished_at: new Date().toISOString(),
      error: JSON.stringify(error),
      pending_question: null,
    });
  }

  markTurnInterrupted(id: string, _priorStatus: TurnStatus): TurnRecord {
    return this.transitionTurn(id, ["pending", "streaming", "awaiting_answer", "answered"], "interrupted", {
      finished_at: new Date().toISOString(),
      pending_question: null,
    });
  }

  /** 轮次事件：与任务事件共用 events 表（task_id 列对两层通用）；上限/截断规则一致。 */
  appendTurnEvent(turnId: string, type: EventRecordType, message: string, percent: number | null): EventRecord | null {
    const tx = this.db.transaction(() => {
      const turn = this.getTurnRow(turnId);
      if (!turn) throw new StoreError("事件写入失败：轮次不存在 " + turnId);
      const count = this.db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ?`)
        .get(turnId) as { n: number };
      if (count.n >= this.maxEventsPerTask) {
        if (turn.events_capped === 0) {
          this.db.prepare(`UPDATE turns SET events_capped = 1 WHERE id = ?`).run(turnId);
          const now = new Date().toISOString();
          this.db
            .prepare(`INSERT INTO events (task_id, type, message, percent, created_at) VALUES (?, 'system', ?, NULL, ?)`)
            .run(turnId, `[系统] 事件数已达上限（${this.maxEventsPerTask} 条），后续事件被丢弃`, now);
        }
        return null;
      }
      const truncated = message.length > this.maxEventMessageChars
        ? message.slice(0, this.maxEventMessageChars) + `…[已截断，原始长度 ${message.length}]`
        : message;
      const now = new Date().toISOString();
      const res = this.db
        .prepare(`INSERT INTO events (task_id, type, message, percent, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(turnId, type, truncated, percent === undefined ? null : percent, now);
      const row = this.db
        .prepare(`SELECT * FROM events WHERE seq = ?`)
        .get(Number(res.lastInsertRowid)) as EventRow;
      return this.toEvent(row);
    });
    const event = tx();
    const row = this.getTurnRow(turnId);
    // 事件已提交：会话级推流订阅者按 seq 重放（去重由订阅侧 lastSeq 保证）。
    this.notifyTurn(turnId, row?.session_id ?? "");
    return event;
  }

  /** 轮次事件/状态提交后的同步通知（第二层 SSE 推流的触发点）；无回调时空操作。 */
  private notifyTurn(turnId: string, sessionId: string): void {
    if (!this.onTurnChange) return;
    try {
      this.onTurnChange({ turnId, sessionId });
    } catch {
      // 订阅者异常不得影响持久化调用方；总线侧亦有容错。
    }
  }

  /** 终态轮次超出上限时裁剪（连同事件），保留最近 maxTasks 条（与任务同一上限）。会话头保留（行小且是“列出会话”能力的价值）。 */
  private pruneOldTurns(): void {
    this.db
      .prepare(
        `DELETE FROM turns WHERE id IN (
           SELECT id FROM turns WHERE status IN ('succeeded','failed','interrupted')
           ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(this.maxTasks);
    this.db
      .prepare(`DELETE FROM events WHERE task_id NOT IN (SELECT id FROM tasks) AND task_id NOT IN (SELECT id FROM turns)`)
      .run();
  }


  // ---------- 内部工具 ----------

  private pruneOldTasks(): void {
    // 终态任务按创建时间超出上限时裁剪（连同事件）。保留最近 maxTasks 条。
    this.db
      .prepare(
        `DELETE FROM tasks WHERE id IN (
           SELECT id FROM tasks WHERE status IN ('succeeded','failed','interrupted')
           ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(this.maxTasks);
    this.db
      .prepare(
        `DELETE FROM events WHERE task_id NOT IN (SELECT id FROM tasks)`
      )
      .run();
  }

  private getTaskRow(id: string): TaskRow | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    return row ?? null;
  }

  private toRecord(row: TaskRow): TaskRecord {
    return {
      id: row.id,
      toolId: row.tool_id,
      status: row.status as TaskStatus,
      input: JSON.parse(row.input) as JsonValue,
      idempotencyKey: row.idempotency_key,
      paramsHash: row.params_hash,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      timeoutMarkedAt: row.timeout_marked_at,
      result: row.result === null ? null : (JSON.parse(row.result) as JsonValue),
      error: row.error === null ? null : (JSON.parse(row.error) as TaskError),
      eventsCapped: row.events_capped === 1,
    };
  }

  private toEvent(row: EventRow): EventRecord {
    return {
      seq: row.seq,
      taskId: row.task_id,
      type: row.type as EventRecordType,
      message: row.message,
      percent: row.percent,
      createdAt: row.created_at,
    };
  }
  private getTurnRow(id: string): TurnRow | null {
    const row = this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id) as TurnRow | undefined;
    return row ?? null;
  }

  private toTurnRecord(row: TurnRow): TurnRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      status: row.status as TurnStatus,
      message: row.message,
      answer: row.answer,
      result: row.result === null ? null : (JSON.parse(row.result) as JsonValue),
      error: row.error === null ? null : (JSON.parse(row.error) as TaskError),
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      pendingQuestion: row.pending_question === null ? null : (JSON.parse(row.pending_question) as PendingQuestion),
      eventsCapped: row.events_capped === 1,
    };
  }

}

interface TaskRow {
  id: string;
  tool_id: string;
  status: string;
  input: string;
  idempotency_key: string;
  params_hash: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  timeout_marked_at: string | null;
  result: string | null;
  error: string | null;
  events_capped: number;
}

interface EventRow {
  seq: number;
  task_id: string;
  type: string;
  message: string;
  percent: number | null;
  created_at: string;
}


interface SessionRow {
  id: string;
  tool_id: string;
  created_at: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  status: string;
  message: string;
  answer: string | null;
  idempotency_key: string;
  result: string | null;
  error: string | null;
  pending_question: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  events_capped: number;
}
