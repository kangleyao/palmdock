// 会话 HTTP API（第二层）：创建会话、在会话内发送消息（幂等）、回答端提出的问题（幂等）。
// 与任务 API 共用鉴权、持久层与事件模型；断线重连靠 GET 会话/轮次恢复已产生的事件与当前等待状态。
// 创建即返回，不等执行；HTTP 请求超时 ≠ 轮次未创建。
import * as crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { bearerAuth } from "./auth";
import { logger } from "./logger";
import { capabilitiesOf, defaultRegistry } from "./registry";
import type { Registry } from "./registry";
import type { SessionRecord, TurnRecord, TurnStatus } from "./types";
import type { Store } from "./store";
import { SessionBusyError, StoreError } from "./store";
import type { SessionRunner } from "./session-runner";
import type { SessionStreamHub } from "./session-stream";

const createSessionBody = z.object({
  toolId: z.string().min(1).max(64),
});

const sendMessageBody = z.object({
  message: z.string().min(1).max(2000),
  idempotencyKey: z.string().min(1).max(100),
});

const answerBody = z.object({
  answer: z.string().min(1).max(200),
});

export interface SessionApiDeps {
  store: Store;
  sessionRunner: SessionRunner;
  limits: { maxInputBytes: number };
  token: string;
  /** 会话 SSE 推流中心（第二层公共传输层；不传则 stream 端点不可用）。 */
  hub?: SessionStreamHub;
  /** 适配器注册表视图：默认为产品端清单；测试可注入含测试替身的注册表。 */
  registry?: Registry;
}

function sessionToJson(s: SessionRecord) {
  return { id: s.id, toolId: s.toolId, createdAt: s.createdAt };
}

function turnToJson(t: TurnRecord) {
  return {
    id: t.id,
    sessionId: t.sessionId,
    status: t.status,
    message: t.message,
    answer: t.answer,
    result: t.result,
    error: t.error,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    pendingQuestion: t.pendingQuestion,
    eventsCapped: t.eventsCapped,
  };
}

/** 活跃轮次状态（供“断线重连”一眼看出当前是不是在等回答）。 */
const LIVE_STATUSES: TurnStatus[] = ["pending", "streaming", "awaiting_answer", "answered"];

export function createSessionRouter(deps: SessionApiDeps): express.Router {
  const registry = deps.registry ?? defaultRegistry;
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));
  router.use(bearerAuth(deps.token));

  //创建会话
  router.post("/sessions", (req, res) => {
    const parsed = createSessionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "INVALID_INPUT",
        message: "请求体不合法：需要 toolId",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const { toolId } = parsed.data;
    const adapter = registry.getSessionAdapter(toolId);
    if (!adapter) {
      // 不支持会话的能力被明确标记：返回声明，而不是静默 404 或空入口
      res.status(409).json({
        error: "SESSIONS_NOT_SUPPORTED",
        message: `工具 ${toolId} 不支持会话（未在 capabilities 中声明 sessions）`,
      });
      return;
    }
    const id = crypto.randomUUID();
    try {
      const session = deps.store.createSession(id, toolId);
      logger.info(`会话创建 ${id}（工具 ${toolId}）`);
      res.status(201).json({ session: sessionToJson(session), capabilities: capabilitiesOf(adapter) });
    } catch (e) {
      logger.error(`创建会话失败：${String(e)}`);
      res.status(500).json({ error: "INTERNAL", message: "会话创建失败" });
    }
  });

  // 列出会话（listSessions 能力由公共页面按声明渲染；末轮消息供列表预览）
  router.get("/sessions", (req, res) => {
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
    const sessions = deps.store.listSessions(limit).map((s) => ({
      ...sessionToJson(s),
      turnCount: s.turnCount,
      lastTurnStatus: s.lastTurnStatus,
      lastTurnAt: s.lastTurnAt,
      lastTurnMessage: s.lastTurnMessage,
    }));
    res.json({ sessions });
  });

  //会话详情：历史轮次 + 当前活跃轮次含全部事件（断线重连视图）
  router.get("/sessions/:id", (req, res) => {
    const session = deps.store.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "SESSION_NOT_FOUND", message: `会话 ${req.params.id} 不存在` });
      return;
    }
    const turns = deps.store.listTurnsOfSession(session.id);
    const live = turns.find((t) => LIVE_STATUSES.includes(t.status)) ?? null;
    // lastTurn = 最新一轮（无论是否终态）：轮询终态靠它；liveTurn 只表示“进行中”。
    const last = turns.length > 0 ? (turns[turns.length - 1] ?? null) : null;

    const adapter = registry.getSessionAdapter(session.toolId);
    res.json({
      session: sessionToJson(session),
      capabilities: adapter ? capabilitiesOf(adapter) : null,
      turns: turns.map(turnToJson),
      liveTurn: live
        ? {
            ...turnToJson(live),
            events: deps.store.getEvents(live.id),
          }
      : null,
      lastTurn: last
        ? {
            ...turnToJson(last),
            events: deps.store.getEvents(last.id),
          }
        : null,


    });
  });

  // 在会话内发送一条消息（创建轮次，幂等）
  router.post("/sessions/:id/messages", (req, res) => {
    const session = deps.store.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "SESSION_NOT_FOUND", message: `会话 ${req.params.id} 不存在` });
      return;
    }
    const parsed = sendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "INVALID_INPUT",
        message: "请求体不合法：需要 message（1..2000 字）与 idempotencyKey",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const { message, idempotencyKey } = parsed.data;

    const adapter = registry.getSessionAdapter(session.toolId);
    if (!adapter) {
      res.status(409).json({
        error: "SESSIONS_NOT_SUPPORTED",
        message: `工具 ${session.toolId} 已不再支持会话`,
      });
      return;
    }
    // 消息上限与任务输入上限同策略
    const serialized = JSON.stringify({ message });
    if (serialized.length > deps.limits.maxInputBytes) {


      res.status(400).json({
        error: "INPUT_TOO_LARGE",
        message: `消息体积 ${serialized.length} 字节，超过上限 ${deps.limits.maxInputBytes} 字节`,
      });
      return;
    }

    // 幂等：同 key + 同消息 → 已存在的轮次；同 key + 异消息 → 409。
    const existing = deps.store.getTurnByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.sessionId !== session.id || existing.message !== message) {
        res.status(409).json({
          error: "IDEMPOTENCY_CONFLICT",
          message: `幂等键 ${idempotencyKey} 已用于其他消息或会话；重试请使用新的幂等键。`,
          existingTurnId: existing.id,
        });
        return;
      }
      res.status(200).json({ turn: turnToJson(existing), idempotentReplay: true });
      return;
    }

    const id = crypto.randomUUID();
    try {
      const turn = deps.store.createTurn({ id, sessionId: session.id, message, idempotencyKey });
      deps.sessionRunner.enqueueTurn(turn.id);
      logger.info(`轮次创建 ${id}（会话 ${session.id}）`);
      res.status(201).json({ turn: turnToJson(turn) });
    } catch (e) {
      if (e instanceof SessionBusyError) {
        res.status(409).json({
          error: "SESSION_BUSY",
          message: `会话 ${session.id} 已有一轮进行中（${e.existingTurnId}）；请先等它结束或回答它的问题。`,
          existingTurnId: e.existingTurnId,
        });
        return;
      }
      if (e instanceof StoreError || String(e).includes("UNIQUE")) {
        const again = deps.store.getTurnByIdempotencyKey(idempotencyKey);
        if (again) {
          if (again.sessionId !== session.id || again.message !== message) {
            res.status(409).json({
              error: "IDEMPOTENCY_CONFLICT",
              message: `幂等键 ${idempotencyKey} 已用于其他消息或会话`,
              existingTurnId: again.id,
            });
            return;
          }
          res.status(200).json({ turn: turnToJson(again), idempotentReplay: true });
          return;
        }
      }
      logger.error(`创建轮次失败：${String(e)}`);
      res.status(500).json({ error: "INTERNAL", message: "轮次创建失败" });
    }
  });

  // 回答端提出的问题（幂等：同一回答重复提交不会触发第二次继续执行）
  router.post("/sessions/:id/turns/:turnId/answer", (req, res) => {
    const session = deps.store.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "SESSION_NOT_FOUND", message: `会话 ${req.params.id} 不存在` });
      return;
    }
    const turn = deps.store.getTurn(req.params.turnId);
    if (!turn || turn.sessionId !== session.id) {
      res.status(404).json({ error: "TURN_NOT_FOUND", message: `轮次 ${req.params.turnId} 不属于会话 ${session.id}` });
      return;
    }

    const parsed = answerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "INVALID_INPUT",
        message: "请求体不合法：需要 answer（1..200 字）",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const { answer } = parsed.data;

    if (turn.status !== "awaiting_answer") {
      // 已经记录过回答：同一回答重放 → 200；不同回答 → 409
      if (turn.answer !== null && turn.answer === answer) {
        res.status(200).json({ turn: turnToJson(turn), idempotentReplay: true });
        return;
      }
      if (turn.answer !== null) {
        res.status(409).json({
          error: "ANSWER_ALREADY_GIVEN",
          message: `该轮已记录回答“${turn.answer}”，不能再提交别的回答。`,
        });
        return;
      }
      const terminal = ["succeeded", "failed", "interrupted"];
      if (terminal.includes(turn.status)) {
        res.status(409).json({
          error: "TURN_FINISHED",
          message: `该轮已结束（${turn.status}），不能再回答。`,
        });
        return;
      }
      res.status(409).json({
        error: "NOT_AWAITING",
        message: `该轮当前状态为 ${turn.status}，不在等待回答。`,
      });
      return;
    }

    // 回答必须是当前问题的可选项之一
    const options = turn.pendingQuestion?.options ?? [];
    if (!options.includes(answer)) {
      res.status(400).json({
        error: "INVALID_ANSWER",
        message: `回答必须是当前问题的可选项之一：${options.join(" / ")}`,
        options,
      });
      return;
    }

    try {
      const answered = deps.store.markTurnAnswered(turn.id, answer);
      deps.store.appendTurnEvent(
        turn.id,
        "system",
        `已收到你的回答：“${answer}”，继续执行。`,
        null
      );
      const resumed = deps.sessionRunner.answerTurn(turn.id, answer);
      if (!resumed) {
        // 持久层是 awaiting→answered 但进程内没有等待中的 resolver：
        // 理论上不可达（ask 与 resolver 同进程生命周期），如实上报而非伪称成功。
        logger.error(`回答状态不一致：轮次 ${turn.id} 已迁移为 answered 但无等待中的 resolver`);
        res.status(500).json({ error: "INTERNAL", message: "回答状态不一致，请联系管理员核查" });
        return;
      }
      logger.info(`轮次 ${turn.id} 收到回答并恢复执行`);
      res.status(200).json({ turn: turnToJson(answered) });
    } catch (e) {
      if (e instanceof StoreError || String(e).includes("UNIQUE")) {
        // 并发竞态：重读一次按既有回答处理
        const again = deps.store.getTurn(turn.id);
        if (again && again.answer === answer && again.status !== "awaiting_answer") {
          res.status(200).json({ turn: turnToJson(again), idempotentReplay: true });
          return;
        }
      }
      logger.error(`提交回答失败：${String(e)}`);
      res.status(500).json({ error: "INTERNAL", message: "回答提交失败" });
    }
  });

  // 会话 SSE 流（第二层公共传输：hello 建立快照 → change 推增量事件与轮次状态；心跳为注释行）。
  // 协议通用，不含任何具体端的方法名/事件名；sinceSeq 支持断线重连重放。
  router.get("/sessions/:id/stream", (req, res) => {
    const session = deps.store.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "SESSION_NOT_FOUND", message: `会话 ${req.params.id} 不存在` });
      return;
    }
    const sinceSeqRaw = req.query.sinceSeq;
    const parsed = sinceSeqRaw === undefined ? 0 : Number(sinceSeqRaw);
    const sinceSeq = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    if (!deps.hub) {
      // 装配未提供推流中心（不应发生于生产装配）：如实 501，不伪称支持。
      res.status(501).json({ error: "STREAM_UNAVAILABLE", message: "本服务未装配会话推流" });
      return;
    }
    deps.hub.attach(res, session.id, sinceSeq);
  });

  // 轮次详情（增量事件，供断线重连与流式展示）
  router.get("/sessions/:id/turns/:turnId", (req, res) => {
    const session = deps.store.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "SESSION_NOT_FOUND", message: `会话 ${req.params.id} 不存在` });
      return;
    }
    const turn = deps.store.getTurn(req.params.turnId);
    if (!turn || turn.sessionId !== session.id) {
      res.status(404).json({ error: "TURN_NOT_FOUND", message: `轮次 ${req.params.turnId} 不属于会话 ${session.id}` });
      return;
    }
    const sinceSeqRaw = req.query.sinceSeq;
    const sinceSeq = sinceSeqRaw === undefined ? undefined : Number(sinceSeqRaw);
    const events = deps.store.getEvents(turn.id, Number.isFinite(sinceSeq) ? (sinceSeq as number) : undefined);
    res.json({ turn: turnToJson(turn), events });
  });

  return router;
}
