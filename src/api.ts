// HTTP API：工具清单、任务提交（幂等）、任务查询（增量事件）。
// 提交 = 创建即返回 taskId，不等执行；HTTP 请求超时 ≠ 任务未创建。
import * as crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { bearerAuth } from "./auth";
import { logger } from "./logger";
import { publicManifests, getAdapter } from "./registry";
import { paramsHashOf } from "./runner";
import type { JsonValue, Limits, TaskRecord, EventRecord } from "./types";
import type { Store } from "./store";
import { StoreError } from "./store";

const submitBodySchema = z.object({
  toolId: z.string().min(1).max(64),
  idempotencyKey: z.string().min(1).max(100),
  input: z.record(z.string(), z.unknown()),
});

export interface ApiDeps {
  store: Store;
  /** 触发调度的回调（由 runner 提供）。 */
  onTaskCreated: (taskId: string) => void;
  limits: Limits;
  token: string;
}

export function createApiRouter(deps: ApiDeps): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  // health 不需 token：仅供前端区分“服务可达但未授权”与“不可达”，不泄露任何信息。
  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.use(bearerAuth(deps.token));

  router.get("/tools", (_req, res) => {
    res.json({ tools: publicManifests() });
  });

  router.post("/tasks", (req, res) => {
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "INVALID_INPUT",
        message: "请求体不合法：需要 toolId、idempotencyKey、input（对象）",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const { toolId, idempotencyKey, input } = parsed.data;

    const adapter = getAdapter(toolId);
    if (!adapter) {
      res.status(404).json({ error: "UNKNOWN_TOOL", message: `工具 ${toolId} 未注册` });
      return;
    }
    // 会话形态工具不参与一次性任务（公共页面也不会渲染表单入口）
    if ((adapter.manifest.mode ?? "task") === "session") {
      res.status(400).json({
        error: "TOOL_MODE_MISMATCH",
        message: `工具 ${toolId} 是会话形态（session），请通过会话入口 /session.html 使用`,
      });
      return;
    }


    const inputParsed = adapter.manifest.inputSchema.safeParse(input);
    if (!inputParsed.success) {
      res.status(400).json({
        error: "INVALID_INPUT",
        message: "输入不符合工具 schema",
        details: inputParsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }

    const validated = inputParsed.data as Record<string, unknown>;
    const serialized = JSON.stringify(validated);
    if (serialized.length > deps.limits.maxInputBytes) {
      res.status(400).json({
        error: "INPUT_TOO_LARGE",
        message: `输入体积 ${serialized.length} 字节，超过上限 ${deps.limits.maxInputBytes} 字节`,
      });
      return;
    }

    const paramsHash = paramsHashOf(toolId, validated);

    // 幂等：同 key + 同参数 → 返回已存在任务；同 key + 异参数 → 409 参数冲突。
    const existing = deps.store.getTaskByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.toolId !== toolId || existing.paramsHash !== paramsHash) {
        res.status(409).json({
          error: "IDEMPOTENCY_CONFLICT",
          message: `幂等键 ${idempotencyKey} 已用于其他参数（工具 ${existing.toolId}）；重试请使用新的幂等键，或沿用同一组参数。`,
          existingTaskId: existing.id,
        });
        return;
      }
      res.status(200).json({ task: serializeTask(existing), idempotentReplay: true });
      return;
    }

    const id = crypto.randomUUID();
    try {
      deps.store.createTask({
        id,
        toolId,
        input: validated as JsonValue,
        idempotencyKey,
        paramsHash,
      });
    } catch (e) {
      // 并发重复提交同 key（唯一索引冲突）→ 当作幂等重放重新走一遍逻辑。
      if (e instanceof StoreError || String(e).includes("UNIQUE")) {
        const again = deps.store.getTaskByIdempotencyKey(idempotencyKey);
        if (again) {
          if (again.toolId !== toolId || again.paramsHash !== paramsHash) {
            res.status(409).json({
              error: "IDEMPOTENCY_CONFLICT",
              message: `幂等键 ${idempotencyKey} 已用于其他参数（工具 ${again.toolId}）`,
              existingTaskId: again.id,
            });
            return;
          }
          res.status(200).json({ task: serializeTask(again), idempotentReplay: true });
          return;
        }
      }
      logger.error(`创建任务失败：${String(e)}`);
      res.status(500).json({ error: "INTERNAL", message: "任务创建失败" });
      return;
    }
    deps.onTaskCreated(id);
    logger.info(`任务创建 ${id}（工具 ${toolId}）`);
    const created = deps.store.getTask(id);
    res.status(201).json({ task: created ? serializeTask(created) : null });
  });

  router.get("/tasks", (req, res) => {
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    res.json({ tasks: deps.store.listTasks(limit).map(serializeTask) });
  });

  router.get("/tasks/:id", (req, res) => {
    const task = deps.store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "TASK_NOT_FOUND", message: `任务 ${req.params.id} 不存在` });
      return;
    }
    const sinceSeqRaw = req.query.sinceSeq;
    const sinceSeq = sinceSeqRaw === undefined ? undefined : Number(sinceSeqRaw);
    const events = deps.store.getEvents(
      task.id,
      Number.isFinite(sinceSeq) ? (sinceSeq as number) : undefined
    );
    res.json({ task: serializeTask(task), events });
  });

  return router;
}

/** 序列化任务记录给 API。input 是用户自己的数据，原样返回；不含任何凭证。 */
export function serializeTask(task: TaskRecord): TaskRecord {
  return task;
}
