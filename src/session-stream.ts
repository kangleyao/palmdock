// 会话 SSE 推流（第二层公共传输层）。
//
// 作用：把“已持久化提交”的轮次状态与事件，按通用 SSE 事件名推送给手机页面。
// 协议刻意通用：hello（连接建立快照）/ change（增量事件 + 轮次快照）/ 注释行心跳；
// 字段与第一层事件模型一致（seq/type/message/percent/createdAt），不含任何具体端的
// 方法名、事件名或私有字段。适配器对此无感知：端只管 emit/ask，持久化即推流。
//
// 断线语义：客户端以 sinceSeq 重连，服务端先重放（DB 已提交事件）再订阅后续变更；
// 重放与订阅窗口内到达的通知由 seq 天然去重（lastSeq 单调推进，永不回退）。
// 传输不可靠 ≠ 轮次状态丢失：所有内容都在持久层，GET 会话详情为权威视图。
import type { Response } from "express";
import type { Store } from "./store";
import { TurnBus } from "./turn-bus";
import { TERMINAL_TURN_STATES } from "./session-state";
import type { TurnRecord } from "./types";

/** SSE 快照中的轮次（最近若干轮；老历史走 GET 会话详情查看）。 */
interface TurnSnapshot {
  id: string;
  status: TurnRecord["status"];
  message: string;
  answer: string | null;
  result: unknown;
  error: { message?: string; stage?: string } | null;
  createdAt: string;
  finishedAt: string | null;
  pendingQuestion: { prompt: string; options: string[] } | null;
}

interface StreamSnapshot {
  session: { id: string; toolId: string; createdAt: string };
  liveTurnId: string | null;
  lastTurnId: string | null;
  turns: TurnSnapshot[];
  events: Array<{ seq: number; turnId: string; type: string; message: string; percent: number | null; createdAt: string }>;
}

/** SSE 连接保留最近多少轮快照（老历史仍可经 GET 会话详情完整查看）。 */
const MAX_SNAPSHOT_TURNS = 20;
/** 心跳间隔：注释行（SSE 协议忽略），保持连接、对抗中间设备空闲断开。 */
const HEARTBEAT_MS = 20000;

interface SseClient {
  res: Response;
  sessionId: string;
  lastSeq: number;
  cleanup: () => void;
}

export class SessionStreamHub {
  private readonly clients = new Set<SseClient>();

  constructor(
    private readonly store: Store,
    private readonly bus: TurnBus
  ) {}

  /**
   * 挂载一条会话流：先订阅总线（捕获重放期间到来的变更），再写入 hello 快照
   * （含 sinceSeq 之后已提交的全部事件），随后随变更推送 change 帧。
   * 连接关闭（手机离开/网络断）时自动清理订阅与心跳。
   */
  attach(res: Response, sessionId: string, sinceSeq: number): void {
    const lastSeq = Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
    const client: SseClient = { res, sessionId, lastSeq, cleanup: () => {} };

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const unsubscribe = this.bus.subscribe((change) => {
      if (change.sessionId !== client.sessionId) return;
      this.pushChange(client);
    });
    const heartbeat = setInterval(() => {
      this.write(client, ": ping\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    client.cleanup = () => {
      unsubscribe();
      clearInterval(heartbeat);
      this.clients.delete(client);
    };
    this.clients.add(client);
    res.on("close", () => {
      client.cleanup();
    });

    // 订阅生效后再写 hello：窗口期内的变更会再触发一次 pushChange，由 lastSeq 去重。
    this.writeHello(client);
  }

  /** 服务关闭/测试结束：结束所有流并清理，避免 server.close() 被挂起的连接拽住。 */
  closeAll(): void {
    for (const client of this.clients) {
      try {
        client.cleanup();
        if (!client.res.writableEnded) client.res.end();
      } catch {
        // 忽略已销毁的响应
      }
    }
    this.clients.clear();
  }

  private writeHello(client: SseClient): void {
    const snapshot = this.snapshot(client);
    const data = JSON.stringify(snapshot);
    this.write(client, `event: hello\ndata: ${data}\n\n`);
  }

  private pushChange(client: SseClient): void {
    if (client.res.writableEnded || client.res.destroyed) return;
    const snapshot = this.snapshot(client);
    const data = JSON.stringify(snapshot);
    this.write(client, `event: change\ndata: ${data}\n\n`);
  }

  private write(client: SseClient, chunk: string): void {
    if (client.res.writableEnded || client.res.destroyed) return;
    client.res.write(chunk);
  }

  /**
   * 读取该会话的“增量事件 + 最近轮次快照”，并把 lastSeq 推进到已推送的最大 seq。
   * 无新事件时仍返回轮次快照：状态迁移（成功/失败/answered）本身需要推送，不一定伴随事件。
   */
  private snapshot(client: SseClient): StreamSnapshot {
    const session = this.store.getSession(client.sessionId);
    if (!session) {
      return { session: { id: client.sessionId, toolId: "", createdAt: "" }, liveTurnId: null, lastTurnId: null, turns: [], events: [] };
    }
    const turns = this.store.listTurnsOfSession(client.sessionId);
    const live = turns.find((t) => !TERMINAL_TURN_STATES.has(t.status)) ?? null;
    const last = turns.length > 0 ? turns[turns.length - 1] ?? null : null;
    const events = this.store.listSessionEventsAfter(client.sessionId, client.lastSeq);
    if (events.length > 0) {
      client.lastSeq = events[events.length - 1]?.seq ?? client.lastSeq;
    }
    const recent = turns.slice(-MAX_SNAPSHOT_TURNS);
    return {
      session: { id: session.id, toolId: session.toolId, createdAt: session.createdAt },
      liveTurnId: live ? live.id : null,
      lastTurnId: last ? last.id : null,
      turns: recent.map((t) => this.toTurnSnapshot(t)),
      events: events.map((e) => ({
        seq: e.seq,
        turnId: e.taskId,
        type: e.type,
        message: e.message,
        percent: e.percent,
        createdAt: e.createdAt,
      })),
    };
  }

  private toTurnSnapshot(t: TurnRecord): TurnSnapshot {
    return {
      id: t.id,
      status: t.status,
      message: t.message,
      answer: t.answer,
      result: t.result,
      error: t.error ? { message: t.error.message, stage: t.error.stage } : null,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt,
      pendingQuestion: t.pendingQuestion ? { prompt: t.pendingQuestion.prompt, options: t.pendingQuestion.options } : null,
    };
  }
}
