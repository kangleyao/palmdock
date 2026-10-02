// 会话 SSE 推流真实测试（第二层公共传输层）。
// 全部走真实 HTTP 连接：hello 快照 → change 推送增量事件与轮次状态 →
// 断线重连（sinceSeq 续传，不丢不重）→ 回答后继续 → 重复回答只继续一次 → 失败流程推流。
// 协议事件名仅有 hello/change 与注释心跳，不含任何具体端的方法名或私有字段。
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestEnv, fetchJson, authed, waitFor } from "./helpers";
import type { TestEnv } from "./helpers";

interface StreamSnapshot {
  session: { id: string; toolId: string };
  liveTurnId: string | null;
  lastTurnId: string | null;
  turns: Array<{
    id: string;
    status: string;
    message: string;
    answer: string | null;
    error: { message?: string; stage?: string } | null;
    pendingQuestion: { prompt: string; options: string[] } | null;
    result: { choice?: string; echo?: string } | null;
  }>;
  events: Array<{ seq: number; type: string; message: string }>;
}

/** 一条 SSE 连接：持续解析帧直到流关闭；frames 供断言，snapshots 是 hello/change 的解析结果。 */
class SseStream {
  readonly frames: Array<{ event: string; data: string }> = [];
  done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private readonly runPromise: Promise<void>;

  constructor(private readonly resp: Response) {
    this.reader = resp.body!.getReader();
    this.runPromise = this.run();
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        const parts = this.buffer.split("\n\n");
        this.buffer = parts.pop() ?? "";
        for (const frame of parts) this.parseFrame(frame);
      }
    } catch {
      // 读取错误视为流结束；断言由 frames/快照承载
    }
    this.done = true;
  }

  private parseFrame(frame: string): void {
    const lines = frame.split("\n");
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue; // 注释行（心跳）
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) this.frames.push({ event: eventName, data: dataLines.join("\n") });
  }

  snapshots(): StreamSnapshot[] {
    return this.frames
      .filter((f) => f.event === "hello" || f.event === "change")
      .map((f) => JSON.parse(f.data) as StreamSnapshot);
  }

  /** 合并所有快照的事件（服务端 lastSeq 保证每帧只含未推送事件，合并不应重复）。 */
  allEvents(): Array<{ seq: number; type: string; message: string }> {
    return this.snapshots().flatMap((s) => s.events);
  }

  close(): void {
    try {
      this.reader.cancel();
    } catch {
      // 忽略
    }
  }

  /** 等待流真正关闭（env.close 时 hub.closeAll 会结束流，验证不拽住服务关闭）。 */
  awaitClosed(timeoutMs = 5000): Promise<boolean> {
    return waitFor(() => (this.done ? true : null), timeoutMs, 20).then(
      () => true,
      () => false
    );
  }
}

async function openStream(env: TestEnv, sessionId: string, sinceSeq?: number): Promise<SseStream> {
  const q = sinceSeq === undefined ? "" : `?sinceSeq=${sinceSeq}`;
  const resp = await fetch(`${env.baseUrl}/api/sessions/${sessionId}/stream${q}`, {
    headers: { authorization: `Bearer ${env.token}` },
  });
  assert.equal(resp.status, 200, `流连接应为 200，实际 ${resp.status}`);
  assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/, "内容类型应为 text/event-stream");
  return new SseStream(resp);
}

function liveTurnOf(snap: StreamSnapshot) {
  return snap.turns.find((t) => t.id === snap.liveTurnId) ?? null;
}
function lastTurnOf(snap: StreamSnapshot) {
  return snap.turns.find((t) => t.id === snap.lastTurnId) ?? null;
}

async function waitSnapshot(stream: SseStream, predicate: (s: StreamSnapshot) => boolean, timeoutMs = 15000): Promise<StreamSnapshot> {
  return waitFor(() => {
    const snap = stream.snapshots().find(predicate);
    return snap ?? null;
  }, timeoutMs, 20);
}

async function openSessionOf(env: TestEnv): Promise<string> {
  const r = await fetchJson(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authed(env, { "content-type": "application/json" }),
    body: JSON.stringify({ toolId: "fake-ai" }),
  });
  assert.equal(r.status, 201);
  return (r.body as { session: { id: string } }).session.id;
}

async function sendMessageOf(env: TestEnv, sessionId: string, message: string, key: string): Promise<void> {
  const r = await fetchJson(`${env.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: authed(env, { "content-type": "application/json" }),
    body: JSON.stringify({ message, idempotencyKey: key }),
  });
  assert.equal(r.status, 201, `消息提交应为 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
}

async function answerOf(env: TestEnv, sessionId: string, turnId: string, answer: string): Promise<{ status: number; body: unknown }> {
  return fetchJson(`${env.baseUrl}/api/sessions/${sessionId}/turns/${turnId}/answer`, {
    method: "POST",
    headers: authed(env, { "content-type": "application/json" }),
    body: JSON.stringify({ answer }),
  });
}

async function waitForHttpStatus(env: TestEnv, sessionId: string, status: string, timeoutMs = 15000): Promise<string> {
  return waitFor(async () => {
    const r = await fetchJson(`${env.baseUrl}/api/sessions/${sessionId}`, { headers: authed(env) });
    const body = r.body as { liveTurn?: { id: string; status: string }; lastTurn?: { id: string; status: string } };
    const t = body.liveTurn ?? body.lastTurn;
    return t && t.status === status ? t.id : null;
  }, timeoutMs, 50);
}

test("SSE 完整流程：hello → 流式事件 → awaiting_answer → 回答 → succeeded（事件 seq 单调无重复）", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSessionOf(env);
    const stream = await openStream(env, sid);

    // hello 立即到达：空会话快照
    const hello = await waitSnapshot(stream, (s) => s.session.id === sid && s.turns.length === 0);
    assert.equal(hello.liveTurnId, null);

    await sendMessageOf(env, sid, "流式推送测试", "sse-full-1");

    const asking = await waitSnapshot(stream, (s) => {
      const live = liveTurnOf(s);
      return live?.status === "awaiting_answer" && !!live.pendingQuestion;
    });
    const live = liveTurnOf(asking)!;
    assert.deepEqual(live.pendingQuestion!.options, ["精简版", "详细版"]);

    // 合并事件：seq 唯一且递增（重放与订阅的去重有效）
    const events = stream.allEvents();
    const seqs = events.map((e) => e.seq);
    assert.ok(events.length >= 4, `至少应有 4 条事件（启动+3 段输出），实际 ${events.length}`);
    assert.equal(new Set(seqs).size, seqs.length, "同一事件不应被推两次");
    assert.deepEqual(seqs.slice().sort((a, b) => a - b), seqs, "seq 应单调递增");
    assert.ok(events.some((e) => e.message.includes("流式推送测试")), "事件应包含回显消息");

    const ans = await answerOf(env, sid, live.id, "精简版");
    assert.equal(ans.status, 200);

    const done = await waitSnapshot(stream, (s) => lastTurnOf(s)?.status === "succeeded");
    assert.equal(lastTurnOf(done)!.result!.choice, "精简版");
    assert.ok(stream.allEvents().some((e) => e.message.includes("结果已生成")), "回答后应有收尾输出事件");

    stream.close();
    // 客户端取消即应结束流；服务端关闭结束流的能力由最后一个测试独立验证
    assert.ok(await stream.awaitClosed(), "客户端取消应结束 SSE 流（读取循环退出）");
  } finally {
    await env.close();
  }
});

test("断线重连：sinceSeq 续传不丢不重（重放历史零事件、后续事件继续到达）", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSessionOf(env);
    await sendMessageOf(env, sid, "断线重连测试", "sse-recon-1");
    await waitForHttpStatus(env, sid, "awaiting_answer");

    // 先以 sinceSeq=0 重连：hello 应重放全部已提交事件
    const s0 = await openStream(env, sid, 0);
    const replayed = await waitSnapshot(s0, (s) => s.events.length >= 4);
    const seqs0 = replayed.events.map((e) => e.seq);
    const lastSeq = seqs0[seqs0.length - 1]!;
    s0.close();

    // 模拟“重新打开页面”：从 lastSeq 续传——已收到的事件不应再重放
    const s1 = await openStream(env, sid, lastSeq);
    // fetch 响应头先到、帧体随后：等 hello 帧解析后再断言
    const hello1 = await waitSnapshot(s1, (s) => s.session.id === sid);
    assert.deepEqual(hello1.events, [], `续传不应重放已确认事件，实际 ${JSON.stringify(hello1.events.map((e) => e.seq))}`);
    assert.equal(liveTurnOf(hello1)?.status, "awaiting_answer", "重连后应能看到当前等待状态");

    // 在重连的流上回答：后续事件应只到达一次
    const turnId = hello1.liveTurnId!;
    await answerOf(env, sid, turnId, "详细版");
    await waitSnapshot(s1, (s) => lastTurnOf(s)?.status === "succeeded");
    const answerEvents = s1.allEvents().filter((e) => e.message.includes("已收到你的回答"));
    assert.equal(answerEvents.length, 1, `"已收到回答"事件应只到达 1 次，实际 ${answerEvents.length}`);
    const tailEvents = s1.allEvents().filter((e) => e.message.includes("结果已生成"));
    assert.equal(tailEvents.length, 1, `收尾输出应只到达 1 次，实际 ${tailEvents.length}`);
    s1.close();
  } finally {
    await env.close();
  }
});

test("重复回答在 SSE 下同样幂等：结果不被第二次回答改变", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSessionOf(env);
    const stream = await openStream(env, sid);
    await sendMessageOf(env, sid, "重复回答推流测试", "sse-dup-1");
    const asking = await waitSnapshot(stream, (s) => liveTurnOf(s)?.status === "awaiting_answer");
    const turnId = asking.liveTurnId!;

    const first = await answerOf(env, sid, turnId, "精简版");
    assert.equal(first.status, 200);
    await waitForHttpStatus(env, sid, "answered");
    const second = await answerOf(env, sid, turnId, "精简版");
    assert.equal(second.status, 200);
    assert.equal((second.body as { idempotentReplay?: boolean }).idempotentReplay, true, "重复回答应为幂等重放");

    const done = await waitSnapshot(stream, (s) => lastTurnOf(s)?.status === "succeeded");
    assert.equal(lastTurnOf(done)!.result!.choice, "精简版");
    assert.equal(
      stream.allEvents().filter((e) => e.message.includes("已收到你的回答")).length,
      1,
      "重复回答不应触发第二次继续执行"
    );
    stream.close();
  } finally {
    await env.close();
  }
});

test("失败流程经 SSE 推送：failed 状态与 error 证据实时到达", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSessionOf(env);
    const stream = await openStream(env, sid);
    await sendMessageOf(env, sid, "失败", "sse-fail-1");

    const failed = await waitSnapshot(stream, (s) => lastTurnOf(s)?.status === "failed");
    const turn = lastTurnOf(failed)!;
    assert.match(turn.error?.message ?? "", /模拟失败/);
    assert.equal(turn.error?.stage, "endpoint.fatal");
    assert.equal(turn.result, null);
    assert.ok(stream.allEvents().some((e) => e.message.includes("已收到失败指令")), "失败前的一段输出应已推送");

    stream.close();
  } finally {
    await env.close();
  }
});

test("SSE 鉴权与会话存在性：无 token 拒 401，未知会话拒 404", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSessionOf(env);
    const r1 = await fetch(`${env.baseUrl}/api/sessions/${sid}/stream`);
    assert.equal(r1.status, 401, "无 token 应拒绝");
    const r2 = await fetch(`${env.baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000/stream`, {
      headers: { authorization: `Bearer ${env.token}` },
    });
    assert.equal(r2.status, 404, "未知会话应 404");
    await r1.body?.cancel();
    await r2.body?.cancel();
  } finally {
    await env.close();
  }
});

test("服务关闭（hub.closeAll）结束 SSE 流，不拽住进程退出", async () => {
  const env = await startTestEnv();
  let stream: SseStream | null = null;
  try {
    const sid = await openSessionOf(env);
    stream = await openStream(env, sid);
    await waitSnapshot(stream, (s) => s.session.id === sid);
  } finally {
    await env.close();
  }
  assert.ok(stream, "流应已建立");
  assert.ok(await stream.awaitClosed(), "env.close 应经 hub.closeAll() 结束所有 SSE 流");
});
