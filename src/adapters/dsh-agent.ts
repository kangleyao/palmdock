// 适配器：DeepSeek Harness（DSH）真实会话端（第二层）。
//
// 端形态：远端 HTTP + WebSocket 服务（官方 dsh web 服务器）。协议取自 DSH 产品自身
// 的公开契约（@deepseek-ai/dsh-host-apiproxy 的 lib/types 声明与各包 README）：
//   - 请求：POST /api/<method>，body 为 ClientRequest 全形式
//     {type:'client-request', rpcId, method, payload}；HTTP 响应体为 ServerResponse
//     {type:'server-response', rpcId, result}，result 为 {ok:true,value} 或
//     {ok:false,error:{code,message,details}}——业务错误不抛异常，全在 result 里。
//   - 下行：WebSocket /api/events.mux（会话事件透传、session/subscribed、
//     question/requested、approval/requested、stream/error 等帧）与
//     /api/events.host（host/session-status 等）。帧是 ServerRequest 的 payload 槽。
//   - 回答通道：POST /api/respond，body 为 ClientResponse
//     {type:'client-response', rpcId, result:{ok:true, value}}，rpcId 原样回显
//     提问/审批请求帧的 rpcId（幂等：重复或迟到得 accepted:false, reason:'not-pending'）。
//   - 信任栅栏：/api 下每个入口校验 Host 必须为回环权威或已声明 trustedHosts。
//     本适配器只以回环 base URL 调用（Host 由 fetch 依 URL 自动填写），
//     不伪造 Origin、不绕栅栏——栅栏由 DSH 服务侧执行，这里是合法的回环客户端。
//   - 断线恢复（DSH 官方 v1 模型）："reconnection = reopen the stream + refetch
//     history"（since 在 v1 未实现）：本适配器在 mux 意外断开时拉一次
//     session.history 尾页按 seq 去重补齐，再重开流。
//
// 配置：服务器地址由环境变量 DSH_BASE_URL 提供（如 http://127.0.0.1:8877）。
// 未配置时 runTurn 以明确错误失败（不静默装作可用）。
// 隔离：DSH 侧会话 id 直接复用本底座的会话 id（UUID，文件系统安全），利用官方
// session.create 的预分配幂等（同 id 重试返回同一会话），重启后同一底座会话仍落到
// 同一 DSH 会话，上下文由 DSH 服务端日志保持。
//
// 已知限制（协议翻译层如实声明，不改 DSH 本体、不猜私有接口）：
//   - DSH 的批量多问/多选/自由文本回答：底座会话协议只支持“单问 + ≥2 明确选项单选”。
//     适配器只处理“恰好一题、非多选、≥2 选项且选项标签无重复”的提问；多题批次、多选、自由文本、
//     选项不足、重复标签一律整轮显式失败并附原始问题证据——不悄悄只答首题、不把多选降级成
//     单选、不伪造选项、不自动回答（手机侧看到 failed + 缺口说明后可重开轮次）。
//   - turn/end 的失败判定用 kind 白名单：error/aborted/interrupted ⇒ failed，
//     其余 kind ⇒ succeeded（以失败为可判定的保守方向）。
//   - 写操作（session.create/session.prompt/POST /api/respond）只对本适配器自己
//     创建的隔离会话执行；严禁对用户既有 DSH 会话发 prompt 或替用户审批
//     （审批映射为向手机提问，由手机用户选择允许一次/拒绝）。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AdapterCapabilities,
  JsonValue,
  SessionAdapter,
  TaskError,
  TurnContext,
  TurnRequest,
  TurnResult,
} from "../types";
import { fieldsFor } from "../schema-fields";

/** Node ≥22 自带全局 WebSocket（undici 实现，仅客户端）；tsconfig 无 DOM lib，这里声明最小本地类型。 */
interface WebSocketLike {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}
declare const WebSocket: { new (url: string): WebSocketLike };
const WS_OPEN = 1;

/** DSH 服务器地址（回环），如 http://127.0.0.1:8877。未配置=没有可用的真实端。 */
export function dshBaseUrl(): string | null {
  const raw = process.env.DSH_BASE_URL;
  if (!raw) return null;
  const url = raw.trim().replace(/\/+$/, "");
  return url === "" ? null : url;
}

/** ws/wss URL：与 HTTP base 同一主机端口。 */
function toWsUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + path;
}

// ---------------- 协议的最小本地视图（忠实重声明 DSH 公开契约的必需子集） ----------------

interface DshRpcError {
  code: string;
  message: string;
  details?: unknown;
}
type DshRpcResult<T> = { ok: true; value: T } | { ok: false; error: DshRpcError };

/** /api 响应体可能为 ServerResponse（业务结果）或错误封套（respond 的 receipt 等）。 */
interface ServerResponseWire<T> {
  type: "server-response";
  rpcId: string;
  result: DshRpcResult<T>;
}
interface RpcReceipt {
  accepted: true;
}
interface RpcRejected {
  accepted: false;
  reason: "not-pending" | "bad-response";
}

interface SessionEventWire {
  type: string;
  seq: number;
  time: string;
  data?: unknown;
}
interface HistoryEntryWire {
  event: SessionEventWire;
}

type MuxFrame =
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | { type: "session/event"; sessionId: string; event: SessionEventWire }
  | {
      type: "question/requested";
      sessionId: string;
      questions: Array<{
        id: string;
        question: string;
        detail?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
      }>;
    }
  | {
      type: "approval/requested";
      sessionId: string;
      approvalId: string;
      toolName: string;
      reason?: string;
    }
  | { type: "stream/error"; error: DshRpcError };

/** 可回答帧（提问/审批）联合：handleAnswerable 的参数类型，保证 if/else 两支窄化。 */
type AnswerableMuxFrame =
  | Extract<MuxFrame, { type: "question/requested" }>
  | Extract<MuxFrame, { type: "approval/requested" }>;
interface ServerRequestWire {
  type: "server-request";
  rpcId: string;
  method: string;
  payload?: unknown;
}

/** host.describe 的返回（能力探测，只读）。 */
export interface DshHostDescribe {
  version: string;
  cwd: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  home: string;
  canOpenPath: boolean;
}
/** session.list 的返回（只读列会话）。 */
export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
}

/** 传输层异常（fetch/解析失败）：由调用方折叠为失败结果，不向上抛。 */
class DshTransportError extends Error {}

/** 只读探测：host.describe（供隔离验证脚本与启动连通性检查复用同一代码路径）。 */
export async function dshDescribe(
  baseUrl: string,
  signal?: AbortSignal
): Promise<DshRpcResult<DshHostDescribe>> {
  return rpc<DshHostDescribe>(baseUrl, "host.describe", {}, signal);
}

/** 只读探测：session.list。 */
export async function dshListSessions(
  baseUrl: string,
  signal?: AbortSignal
): Promise<DshRpcResult<{ items: DshSessionSummary[] }>> {
  return rpc<{ items: DshSessionSummary[] }>(baseUrl, "session.list", {}, signal);
}

/** Documented /api unary 调用：封套校验后返回业务 result（ok:false 也是正常返回）。 */
async function rpc<T>(
  baseUrl: string,
  method: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<DshRpcResult<T>> {
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload }),
    signal,
  });
  if (!res.ok) {
    throw new DshTransportError(`/api/${method} HTTP ${res.status}`);
  }
  const body = (await res.json()) as Partial<ServerResponseWire<T>>;
  if (body.type !== "server-response" || !body.result || typeof body.result !== "object") {
    throw new DshTransportError(
      `/api/${method} 响应封套非法：${JSON.stringify(body).slice(0, 200)}`
    );
  }
  return body.result;
}

/** 答复服务端请求帧（提问/审批）：POST /api/respond，rpcId 原样回显。 */
async function respond(
  baseUrl: string,
  rpcId: string,
  value: unknown,
  signal?: AbortSignal
): Promise<RpcReceipt | RpcRejected> {
  const res = await fetch(`${baseUrl}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-response",
      rpcId,
      result: { ok: true, value },
    }),
    signal,
  });
  if (!res.ok) {
    throw new DshTransportError(`/api/respond HTTP ${res.status}`);
  }
  return (await res.json()) as RpcReceipt | RpcRejected;
}

/** 从会话事件里尽力抽取文本（assistant/chunk 与 assistant/message 的内容块形态）。 */
function eventText(event: SessionEventWire): string | null {
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.text === "string") return d.text;
  for (const key of ["content", "blocks"]) {
    const arr = d[key];
    if (!Array.isArray(arr)) continue;
    const parts = arr
      .map((b) => {
        if (!b || typeof b !== "object") return null;
        const block = b as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") return block.text;
        return null;
      })
      .filter((t): t is string => typeof t === "string");
    if (parts.length > 0) return parts.join("");
  }
  const message = d.message;
  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      const parts = msg.content
        .map((b) => {
          if (!b || typeof b !== "object") return null;
          const block = b as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") return block.text;
          return null;
        })
        .filter((t): t is string => typeof t === "string");
      if (parts.length > 0) return parts.join("");
    }
  }
  return null;
}

/** turn/end 的失败判定白名单（见文件头限制说明）。 */
const FAILING_TURN_END_KINDS = new Set(["error", "aborted", "interrupted"]);

const FULL_CAPABILITIES: AdapterCapabilities = {
  sessions: true,
  listSessions: true,
  streaming: true,
  askUser: true,
};

/** 会话期输入 = 一条消息（与 fake-ai 同一表单契约）。 */
const inputSchema = z.object({
  message: z
    .string()
    .min(1)
    .max(2000)
    .describe("发给 DSH 会话的消息")
    .meta({
      multiline: true,
      placeholder: "对真实 Agent 说点什么…",
      help: "消息经文档化 /api 协议发送到 DSH 服务器；执行中可能向你提问或请求工具权限。",
    }),
});

function fail(message: string, stage: string, detail?: string): TurnResult {
  const error: TaskError = { message, stage };
  if (detail !== undefined) error.detail = detail;
  return { ok: false, error };
}

/** 最大断线重连次数（超过即告失败，不留无限重试）。 */
const MAX_RECONNECTS = 6;

function runTurn(req: TurnRequest, ctx: TurnContext): Promise<TurnResult> {
  const baseUrl = dshBaseUrl();
  if (!baseUrl) {
    return Promise.resolve(
      fail(
        "未配置 DSH 服务器地址：请设置环境变量 DSH_BASE_URL（回环，如 http://127.0.0.1:8877）",
        "dsh.config"
      )
    );
  }
  if (ctx.signal.aborted) {
    return Promise.resolve(fail("轮次在启动前已被关闭信号中止", "turn.aborted"));
  }
  return runTurnOn(baseUrl, req, ctx);
}

/**
 * 实际轮次执行（baseUrl 为参数而非闭包常量：TS 的控制流窄化不跨闭包，
 * 显式参数保证回环 URL 在执行器内不再是 string|null）。
 */
function runTurnOn(baseUrl: string, req: TurnRequest, ctx: TurnContext): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve) => {
    let settled = false;
    let ws: WebSocketLike | null = null;
    let lastSeq = -1;
    let reconnects = 0;
    let awaitingAnswer = false;
    const assistantTexts: string[] = [];
    let turnEndSeen = false;

    const settle = (outcome: TurnResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const cleanup = (): void => {
      ctx.signal.removeEventListener("abort", onAbort);
      closeWs();
    };

    const closeWs = (): void => {
      if (ws) {
        const socket = ws;
        ws = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          if (socket.readyState === WS_OPEN) socket.close(1000, "turn-done");
        } catch {
          // 二次关闭忽略
        }
      }
    };

    function onAbort(): void {
      settle(fail("轮次被关闭信号中止（服务退出）", "turn.aborted"));
    }
    ctx.signal.addEventListener("abort", onAbort);

    // ---- 会话事件到流式输出的映射（历史补齐与实时流共用，按 seq 去重） ----
    function handleEvent(event: SessionEventWire): void {
      if (event.seq <= lastSeq) return; // 去重：历史补齐与重放可能重叠
      lastSeq = event.seq;
      if (event.type === "turn/start") {
        ctx.emit({ type: "info", message: "DSH 端已开始本轮执行" });
      } else if (event.type === "turn/end") {
        turnEndSeen = true;
        const data = (event.data ?? {}) as Record<string, unknown>;
        const kind = typeof data.kind === "string" ? data.kind : "normal";
        if (FAILING_TURN_END_KINDS.has(kind)) {
          const errorPayload = data.error as { message?: string } | undefined;
          const message = errorPayload?.message
            ? `DSH 端本轮失败（${kind}）：${errorPayload.message}`
            : `DSH 端本轮失败（${kind}）`;
          settle(fail(message, "dsh.turn-end", JSON.stringify(data).slice(0, 400)));
        } else {
          settle({
            ok: true,
            result: {
              sessionId: req.sessionId,
              assistantText: assistantTexts.join("\n").slice(0, 4000),
              turnEndReason: kind,
              finalEventSeq: lastSeq,
            } as JsonValue,
          });
        }
      } else if (event.type === "assistant/chunk" || event.type === "assistant/message") {
        const text = eventText(event);
        if (text !== null && text !== "") {
          assistantTexts.push(text);
          ctx.emit({ type: "info", message: text.slice(0, 1900) });
        }
      }
      // 其余事件类型（user/message 回显、tool/*、compaction/* 等）按协议 ignorable 语义跳过。
    }

    // ---- 服务端请求帧（提问/审批）→ 底座 ask → /api/respond ----
    function handleAnswerable(frame: AnswerableMuxFrame, frameRpcId: string): void {
      if (settled) return;
      if (awaitingAnswer) {
        settle(
          fail(
            "DSH 端在等待上一个回答期间又发起新的提问/审批：底座会话协议一次只允许一个待答问题",
            "dsh.concurrent-ask"
          )
        );
        return;
      }
      awaitingAnswer = true;
      let prompt: string;
      let options: string[];
      let answerValue: (answer: string) => unknown;
      if (frame.type === "question/requested") {
        // 多题批次：底座一次只有一个待答问题。不悄悄只答首题丢掉其余——整轮显式失败并附全部问题文本。
        if (frame.questions.length > 1) {
          settle(
            fail(
              `DSH 端一次发来 ${frame.questions.length} 个问题，底座单题单选协议无法整体回答（拒绝只答首题而丢弃其余）：` +
                frame.questions.map((q) => q.question).join(" | "),
              "dsh.question-batch",
              JSON.stringify(frame.questions).slice(0, 400)
            )
          );
          return;
        }
        const question = frame.questions[0];
        if (!question) {
          settle(fail("DSH 端的提问批次为空", "dsh.question-empty"));
          return;
        }
        const labels = (question.options ?? []).map((o) => o.label);
        if (labels.length < 2) {
          // 无选项（自由文本）不在底座单选协议的表达范围内：如实失败，不伪造选项。
          settle(
            fail(
              `DSH 端的问题无法映射到底座单选协议（选项不足 2 个或需自由文本回答）：${question.question}`,
              "dsh.question-unrepresentable",
              JSON.stringify(question).slice(0, 400)
            )
          );
          return;
        }
        if (new Set(labels).size !== labels.length) {
          // 选项标签重复：手机单选按钮无法无歧义展示（同名的两个按钮用户无法区分），
          // 回答会产生歧义——显式失败，不提交可能失真的回答。
          settle(
            fail(
              `DSH 端的问题存在重复的选项标签，手机单选无法无歧义回答：${question.question}`,
              "dsh.question-duplicate-options",
              JSON.stringify(question).slice(0, 400)
            )
          );
          return;
        }
        if (question.multiSelect) {
          // 多选：不降级成单选回答（会让 DSH 端拿到失真的部分答案）——显式失败。
          settle(
            fail(
              `DSH 端要求多选回答，底座单选协议无法如实作答（不降级为单选）：${question.question}`,
              "dsh.question-multiselect",
              JSON.stringify(question).slice(0, 400)
            )
          );
          return;
        }
        prompt = question.detail
          ? `${question.question}\n（${question.detail}）`
          : question.question;
        options = labels;
        answerValue = (answer) => ({
          sessionId: frame.sessionId,
          answer: { answers: [{ id: question.id, selected: [answer] }] },
        });
      } else {
        // approval/requested：权限决策交给手机用户（绝不由适配器代批）。
        prompt = `权限请求：工具 ${frame.toolName} 请求执行${frame.reason ? `（${frame.reason}）` : ""}`;
        options = ["允许一次", "拒绝"];
        answerValue = (answer) => ({
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          outcome: answer === "允许一次" ? "allowed-once" : "rejected",
        });
      }

      void ctx.ask(prompt, options).then(
        async (answer) => {
          if (settled) return;
          try {
            const receipt = await respond(baseUrl, frameRpcId, answerValue(answer), ctx.signal);
            if (!receipt.accepted) {
              settle(
                fail(
                  `DSH 端未接受回答（reason=${receipt.reason}：可能已超时或重复）`,
                  "dsh.respond-rejected"
                )
              );
              return;
            }
            // answered 帧由后续 question/resolved 或执行续行确认；这里继续等流。
          } catch (e) {
            settle(
              fail(
                `提交回答失败：${e instanceof Error ? e.message : String(e)}`,
                "dsh.respond-transport"
              )
            );
          } finally {
            awaitingAnswer = false;
          }
        },
        (e: unknown) => {
          settle(
            fail(
              `提问被拒绝或中断：${e instanceof Error ? e.message : String(e)}`,
              "turn.ask"
            )
          );
        }
      );
    }

    function handleMuxMessage(data: string): void {
      if (settled) return;
      let msg: ServerRequestWire;
      try {
        msg = JSON.parse(data) as ServerRequestWire;
      } catch {
        return; // 非法 JSON 帧：忽略（协议文本帧由 WS 侧保证）
      }
      if (!msg || msg.type !== "server-request") return;
      const frame = msg.payload as MuxFrame | undefined;
      if (!frame || typeof frame !== "object") return;
      switch (frame.type) {
        case "session/subscribed":
          // 只认本会话的订阅水位：聚合流会对所有会话各发一帧 subscribed，
          // 若采纳他会的 lastSeq，会把本会话尚未到达的事件按 seq 误去重（含 turn/end），导致永不结算。
          if (frame.sessionId === req.sessionId) lastSeq = Math.max(lastSeq, frame.lastSeq);
          break;
        case "session/event":
          if (frame.sessionId === req.sessionId) handleEvent(frame.event);
          break;
        case "question/requested":
        case "approval/requested":
          if (frame.sessionId === req.sessionId) handleAnswerable(frame, msg.rpcId);
          break;
        case "stream/error":
          settle(
            fail(
              `DSH 实时流错误（${frame.error.code}）：${frame.error.message}`,
              "dsh.stream-error",
              JSON.stringify(frame.error.details ?? {}).slice(0, 400)
            )
          );
          break;
        default:
          // 其余 mux 帧与 host 帧不在本适配器范围内（项目协议的明确子集）。
          break;
      }
    }

    // ---- 断线恢复：重开流 + 拉历史（官方 v1 模型） ----
    async function reconnect(): Promise<void> {
      if (settled || ctx.signal.aborted) return;
      reconnects += 1;
      if (reconnects > MAX_RECONNECTS) {
        settle(fail("DSH 实时流反复断开，超过重连上限", "dsh.reconnect-limit"));
        return;
      }
      try {
        const history = await rpc<{ events: HistoryEntryWire[] }>(
          baseUrl,
          "session.history",
          { sessionId: req.sessionId },
          ctx.signal
        );
        if (!history.ok) {
          settle(
            fail(
              `断线补齐历史失败（${history.error.code}）：${history.error.message}`,
              "dsh.history"
            )
          );
          return;
        }
        for (const entry of history.value.events) {
          if (settled) return;
          handleEvent(entry.event);
        }
        if (settled || turnEndSeen) return;
        openMux(); // 历史里没有轮次终结：重开流继续等（重开秒回 subscribed + 待答问题重放）
      } catch (e) {
        settle(
          fail(
            `断线恢复失败：${e instanceof Error ? e.message : String(e)}`,
            "dsh.reconnect-transport",
            e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 3).join("\n") : undefined
          )
        );
      }
    }

    function openMux(): void {
      if (settled || ctx.signal.aborted) return;
      let socket: WebSocketLike;
      try {
        socket = new WebSocket(toWsUrl(baseUrl, "/api/events.mux"));
      } catch (e) {
        settle(
          fail(
            `打开实时流失败：${e instanceof Error ? e.message : String(e)}`,
            "dsh.ws-open"
          )
        );
        return;
      }
      ws = socket;
      socket.onopen = () => {
        if (settled) return;
        ctx.emit({ type: "info", message: "已连接 DSH 实时事件流" });
        if (reconnects === 0) {
          // 首次连接成功后才提交消息：避免 prompt 早于流就绪而漏掉首批事件。
          void submitPrompt();
        }
      };
      socket.onmessage = (ev) => handleMuxMessage(ev.data);
      socket.onerror = () => {
        // 传输错误随后会触发 onclose；不在缺少证据的情况下直接判定失败。
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (!settled && !ctx.signal.aborted && !turnEndSeen) void reconnect();
      };
    }

    async function submitPrompt(): Promise<void> {
      try {
        const outcome = await rpc<{ accepted: true }>(
          baseUrl,
          "session.prompt",
          {
            sessionId: req.sessionId,
            mode: "queue",
            content: [{ type: "text", text: req.message }],
          },
          ctx.signal
        );
        if (!outcome.ok) {
          settle(
            fail(
              `DSH 端拒绝消息（${outcome.error.code}）：${outcome.error.message}`,
              "dsh.prompt",
              JSON.stringify(outcome.error.details ?? {}).slice(0, 400)
            )
          );
          return;
        }
        ctx.emit({ type: "info", message: `消息已提交给 DSH 会话（第 ${req.history.length + 1} 轮）` });
      } catch (e) {
        settle(
          fail(
            `提交消息失败：${e instanceof Error ? e.message : String(e)}`,
            "dsh.prompt-transport"
          )
        );
      }
    }

    async function ensureSession(): Promise<boolean> {
      try {
        const created = await rpc<{ sessionId: string }>(
          baseUrl,
          "session.create",
          { sessionId: req.sessionId },
          ctx.signal
        );
        if (!created.ok) {
          settle(
            fail(
              `DSH 会话创建/复用失败（${created.error.code}）：${created.error.message}`,
              "dsh.create",
              JSON.stringify(created.error.details ?? {}).slice(0, 400)
            )
          );
          return false;
        }
        return true;
      } catch (e) {
        settle(
          fail(
            `DSH 会话创建/复用失败（传输）：${e instanceof Error ? e.message : String(e)}`,
            "dsh.create-transport"
          )
        );
        return false;
      }
    }

    void (async () => {
      const ok = await ensureSession();
      if (!ok || settled) return;
      openMux();
      // WS 未在合理时间内打开（连接被拒等）：reconnect 兜底（onclose/onerror 路径）。
    })();
  });
}

/** 第一层一次性任务入口：会话形态，显式拒绝。 */
function run(): Promise<TurnResult> {
  return Promise.resolve(
    fail(
      "本工具为会话形态（session）：DSH Agent 只能通过会话页发送消息，不支持一次性任务提交。",
      "mode"
    )
  );
}

/**
 * 不提供契约 examples：端依赖外部 DSH 服务器（DSH_BASE_URL），
 * 契约测试以 fake-dsh/server.js 的可控假协议端覆盖（见 tests/dsh-session.test.ts）；
 * 真实 DSH 的只读连通性验证见 scripts/verify-dsh-readonly.js（不依赖用户会话）。
 */
export const dshAgentAdapter: SessionAdapter = {
  manifest: {
    id: "dsh-agent",
    name: "DeepSeek Harness（远端真实 Agent）",
    description:
      "按 DSH 公开 /api 协议连接真实 dsh web 服务器：流式输出、提问/审批回答。仅支持单题、单选、选项无重复的提问；DSH 多题/多选/自由文本/重复选项会整轮显式失败（不降级、不自动回答）。需服务端已配置到本机 dsh web 的回环连接",
    mode: "session",
    capabilities: FULL_CAPABILITIES,
    timeoutMs: 300000,
    inputSchema,
    fields: fieldsFor(inputSchema),
  },
  run,
  runTurn,
};
