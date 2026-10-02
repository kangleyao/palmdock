// 会话层（第二层）真实测试：通过真实 HTTP 服务跑假 AI 的完整会话流程。
// 覆盖：能力声明、完整流程（流式→提问→回答→结果）、重复回答幂等、断线后状态恢复、
//      确定性（同一输入+回答结果稳定）、非法输入拒绝、每会话单活轮次、重启恢复 interrupted。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { startTestEnv, fetchJson, authed, waitFor, tempDataDir } from "./helpers";
import { Store } from "../src/store";
import { recoverInterruptedTurns } from "../src/session-runner";

const FAKE_AI_SCRIPT = path.resolve(__dirname, "..", "..", "fake-ai", "agent.js");

interface TurnJson {
  id: string;
  sessionId: string;
  status: string;
  message: string;
  answer: string | null;
  result: { summary?: string; choice?: string; echo?: string; turnIndex?: number } | null;
  error: { message?: string; stage?: string } | null;
  pendingQuestion: { prompt: string; options: string[] } | null;
}

interface SessionDetail {
  session: { id: string; toolId: string };
  liveTurn: (TurnJson & { events: Array<{ seq: number; type: string; message: string }> }) | null;
  lastTurn: (TurnJson & { events: Array<{ seq: number; type: string; message: string }> }) | null;

  turns: TurnJson[];
}

async function openSession(baseUrl: string, token: string): Promise<string> {
  const r = await fetchJson(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ toolId: "fake-ai" }),
  });


  assert.equal(r.status, 201);
  const body = r.body as { session: { id: string } };
  assert.ok(body.session?.id);
  return body.session.id;
}

async function sendMessage(baseUrl: string, token: string, sessionId: string, message: string, key: string): Promise<TurnJson> {
  const r = await fetchJson(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message, idempotencyKey: key }),
  });
  assert.equal(r.status, 201, `消息提交应为 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return (r.body as { turn: TurnJson }).turn;
}

async function answerTurn(baseUrl: string, token: string, sessionId: string, turnId: string, answer: string): Promise<{ status: number; body: unknown }> {
  return fetchJson(`${baseUrl}/api/sessions/${sessionId}/turns/${turnId}/answer`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  });
}

async function getSession(baseUrl: string, token: string, sessionId: string): Promise<SessionDetail> {
  const r = await fetchJson(`${baseUrl}/api/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200);
  return r.body as SessionDetail;
}

async function waitForStatus(baseUrl: string, token: string, sessionId: string, status: string, timeoutMs = 15000): Promise<TurnJson> {
  return waitFor(async () => {
    const s = await getSession(baseUrl, token, sessionId);
    // liveTurn 只在轮次未终结时存在；终结后用 lastTurn 观察最终状态
    const live = s.liveTurn ?? s.lastTurn;

    if (live && live.status === status) return live;
    return null;
  }, timeoutMs);
}

test("能力声明：fake-ai 声明全部会话能力，task 工具显式标记不支持", async () => {
  const env = await startTestEnv();
  try {
    const r = await fetchJson(`${env.baseUrl}/api/tools`, { headers: authed(env) });
    assert.equal(r.status, 200);
    const tools = (r.body as { tools: Array<{ id: string; mode: string; capabilities: Record<string, boolean> }> }).tools;
    const fake = tools.find((t) => t.id === "fake-ai");
    assert.ok(fake, "fake-ai 应在清单中");
    assert.equal(fake.mode, "session");
    assert.deepEqual(fake.capabilities, { sessions: true, listSessions: true, streaming: true, askUser: true });
    const text = tools.find((t) => t.id === "text-stats");
    assert.ok(text);
    assert.equal(text.mode, "task");
    assert.deepEqual(text.capabilities, { sessions: false, listSessions: false, streaming: false, askUser: false });
  } finally {
    await env.close();
  }
});

test("能力门控：不支持会话的工具被拒绝，且假 AI 不能走一次性任务通道", async () => {
  const env = await startTestEnv();
  try {
    const r1 = await fetchJson(`${env.baseUrl}/api/sessions`, {
      method: "POST",
      headers: authed(env, { "content-type": "application/json" }),
      body: JSON.stringify({ toolId: "text-stats" }),
    });
    assert.equal(r1.status, 409);
    assert.equal((r1.body as { error: string }).error, "SESSIONS_NOT_SUPPORTED");

    const r2 = await fetchJson(`${env.baseUrl}/api/tasks`, {
      method: "POST",
      headers: authed(env, { "content-type": "application/json" }),
      body: JSON.stringify({ toolId: "fake-ai", idempotencyKey: "k-mode-1", input: {} }),
    });
    assert.equal(r2.status, 400);
    assert.equal((r2.body as { error: string }).error, "TOOL_MODE_MISMATCH");
  } finally {
    await env.close();
  }
});

test("假 AI 完整流程：分段输出 → 二选一提问 → 回答 → 最终结果", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    const turn = await sendMessage(env.baseUrl, env.token, sid, "帮我整理一下思路", "flow-1");
    assert.equal(turn.status, "pending");

    const awaiting = await waitForStatus(env.baseUrl, env.token, sid, "awaiting_answer");
    assert.ok(awaiting.pendingQuestion, "应有待回答问题");
    assert.equal(awaiting.pendingQuestion.options.length, 2, "恰好两个选项");
    assert.deepEqual(awaiting.pendingQuestion.options, ["精简版", "详细版"]);

    const mid = await getSession(env.baseUrl, env.token, sid);
    const midEvents = mid.liveTurn?.events ?? [];
    assert.ok(midEvents.length >= 3, `至少应已收到 3 段输出，实际 ${midEvents.length}`);
    assert.ok(midEvents.some((e) => e.message.includes("帮我整理一下思路")), "事件应包含回显的消息");

    const ans = await answerTurn(env.baseUrl, env.token, sid, awaiting.id, "精简版");
    assert.equal(ans.status, 200);

    const done = await waitForStatus(env.baseUrl, env.token, sid, "succeeded");
    assert.equal(done.answer, "精简版");
    assert.ok(done.result, "应有最终结果");
    assert.equal(done.result.choice, "精简版");
    assert.equal(done.result.echo, "帮我整理一下思路");
    assert.equal(done.result.turnIndex, 0);
    assert.match(done.result.summary ?? "", /精简版/);

    const final = await getSession(env.baseUrl, env.token, sid);
    const events = final.liveTurn?.events ?? final.lastTurn?.events ?? [];

    assert.ok(events.some((e) => e.message.includes("已收到你的回答")), "应有“已收到回答”系统事件");
    assert.ok(events.some((e) => e.message.includes("结果已生成")), "应有收尾输出事件");
  } finally {
    await env.close();
  }
});

test("失败流程：消息为“失败”时端明确失败，轮次 failed 并带证据", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    const turn = await sendMessage(env.baseUrl, env.token, sid, "失败", "fail-1");
    assert.equal(turn.status, "pending");

    const failed = await waitForStatus(env.baseUrl, env.token, sid, "failed");
    assert.equal(failed.answer, null, "失败轮次不应有回答");
    assert.ok(failed.error, "失败轮次必须带 error 证据");
    assert.match(failed.error?.message ?? "", /模拟失败/);
    assert.equal(failed.error?.stage, "endpoint.fatal");
    assert.equal(failed.result, null, "失败轮次不应有结果");

    const s = await getSession(env.baseUrl, env.token, sid);
    const events = (s.liveTurn ?? s.lastTurn)?.events ?? [];
    assert.ok(events.some((e) => e.message.includes("已收到失败指令")), "应有失败指令的输出事件");

    // 列表视图也能看到失败状态与末轮消息（公共页面列表渲染依据）
    const list = await fetchJson(`${env.baseUrl}/api/sessions?limit=10`, { headers: authed(env) });
    const row = (list.body as { sessions: Array<{ id: string; lastTurnStatus: string | null; lastTurnMessage: string | null }> })
      .sessions.find((x) => x.id === sid);
    assert.ok(row, "会话应出现在列表中");
    assert.equal(row?.lastTurnStatus, "failed");
    assert.equal(row?.lastTurnMessage, "失败");
  } finally {
    await env.close();
  }
});

test("重复回答：同一回答重复提交不会触发第二次继续执行", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    await sendMessage(env.baseUrl, env.token, sid, "重复回答测试", "dup-1");
    const awaiting = await waitForStatus(env.baseUrl, env.token, sid, "awaiting_answer");

    const first = await answerTurn(env.baseUrl, env.token, sid, awaiting.id, "详细版");
    assert.equal(first.status, 200);

    // 第一次回答后立即再提交同一回答：应被幂等吸收（200 重放），不会二次 resolve
    const second = await answerTurn(env.baseUrl, env.token, sid, awaiting.id, "详细版");
    assert.equal(second.status, 200);
    assert.equal((second.body as { idempotentReplay?: boolean }).idempotentReplay, true);

    // 等待成功；统计“已收到回答”系统事件应恰好一次
    await waitForStatus(env.baseUrl, env.token, sid, "succeeded");
    const s = await getSession(env.baseUrl, env.token, sid);
    const answerEvents = ((s.liveTurn ?? s.lastTurn)?.events ?? []).filter((e) =>
      e.message.includes("已收到你的回答")
    );
    assert.equal(answerEvents.length, 1, `"已收到回答"事件应只有 1 次，实际 ${answerEvents.length}`);
    assert.equal((s.liveTurn ?? s.lastTurn)?.result?.choice, "详细版", "结果未被第二次回答改变");

  } finally {
    await env.close();
  }
});

test("断线后状态查询：重开页面能看到已产生的事件与当前等待状态", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    await sendMessage(env.baseUrl, env.token, sid, "断线测试消息", "recon-1");

    // 模拟手机断线：只是不再轮询，服务端状态持续存在
    await waitForStatus(env.baseUrl, env.token, sid, "awaiting_answer");

    // “重新打开页面”：GET 会话详情
    const body = await getSession(env.baseUrl, env.token, sid);
    assert.equal(body.liveTurn?.status, "awaiting_answer");
    assert.ok(body.liveTurn?.pendingQuestion, "重连后能看到当前问题");
    assert.ok((body.liveTurn?.events ?? []).length >= 3, "重连后能看到已产生的全部事件");
    assert.equal(body.turns.length, 1);
  } finally {
    await env.close();
  }
});

test("确定性：同一输入加同一回答，假 AI 两次输出逐行一致", { timeout: 30000 }, async () => {
  const first = await runScriptOnce("确定性问题一", "精简版");
  const second = await runScriptOnce("确定性问题一", "精简版");
  assert.ok(first.length >= 5, `输出行数应 >= 5（output×3 + ask + done），实际 ${first.length}`);
  assert.deepEqual(first, second, "同一输入加同一回答，两次输出应逐行一致");
  assert.ok(first.some((l) => l.type === "ask"), "应出现提问");
  assert.ok(first.some((l) => l.type === "done"), "应以 done 结束");
  const done = first.find((l) => l.type === "done") as { result: { summary: string; choice: string } };
  assert.equal(done.result.choice, "精简版");
  assert.match(done.result.summary, /精简版/);
});

test("每会话单活轮次：进行中再发消息被拒绝（409 SESSION_BUSY）", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    await sendMessage(env.baseUrl, env.token, sid, "第一轮", "busy-1");
    await waitForStatus(env.baseUrl, env.token, sid, "awaiting_answer");
    const r = await fetchJson(`${env.baseUrl}/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: authed(env, { "content-type": "application/json" }),
      body: JSON.stringify({ message: "第二轮", idempotencyKey: "busy-2" }),
    });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, "SESSION_BUSY");
  } finally {
    await env.close();
  }
});

test("非法回答与消息输入被拒绝", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    await sendMessage(env.baseUrl, env.token, sid, "校验测试", "valid-1");
    const awaiting = await waitForStatus(env.baseUrl, env.token, sid, "awaiting_answer");

    // 不在选项中的回答 → 400 INVALID_ANSWER，且仍在等待
    const bad = await answerTurn(env.baseUrl, env.token, sid, awaiting.id, "不存在的选项");
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: string }).error, "INVALID_ANSWER");
    const still = await getSession(env.baseUrl, env.token, sid);
    assert.equal(still.liveTurn?.status, "awaiting_answer");

    // 空消息 → 400
    const empty = await fetchJson(`${env.baseUrl}/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: authed(env, { "content-type": "application/json" }),
      body: JSON.stringify({ message: "", idempotencyKey: "valid-2" }),
    });
    assert.equal(empty.status, 400);

    // 未知会话 → 404
    const missing = await fetchJson(`${env.baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000`, { headers: authed(env) });
    assert.equal(missing.status, 404);
  } finally {
    await env.close();
  }
});

test("消息幂等：同 key + 同消息重放返回同一轮次", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    const t1 = await sendMessage(env.baseUrl, env.token, sid, "幂等消息", "idem-1");
    const r2 = await fetchJson(`${env.baseUrl}/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: authed(env, { "content-type": "application/json" }),
      body: JSON.stringify({ message: "幂等消息", idempotencyKey: "idem-1" }),
    });
    assert.equal(r2.status, 200);
    assert.equal((r2.body as { turn: TurnJson }).turn.id, t1.id);
  } finally {
    await env.close();
  }
});

test("重启恢复：未终结轮次标记 interrupted，不重跑、不伪称", async () => {
  // 直接在存储层验证恢复语义（不启动第二个进程）
  const dbPath = path.join(tempDataDir(), "base.db");
  const store = new Store(dbPath, { maxTasks: 500, maxEventsPerTask: 200, maxEventMessageChars: 2000 });
  try {
    const session = store.createSession("sess-recover-1", "fake-ai");
    const turn = store.createTurn({
      id: "turn-recover-1",
      sessionId: session.id,
      message: "恢复测试",
      idempotencyKey: "recover-1",
    });
    store.markTurnStreaming(turn.id);
    store.markTurnAwaiting(turn.id, { prompt: "在吗？", options: ["A", "B"], askedAt: new Date().toISOString() });

    const result = recoverInterruptedTurns(store);
    assert.equal(result.interrupted, 1);
    const after = store.getTurn(turn.id);
    assert.equal(after?.status, "interrupted");
    assert.equal(after?.pendingQuestion, null, "中断后应清空待回答问题（结果未知，不保留过期问题）");
    const events = store.getEvents(turn.id);
    assert.ok(events.some((e) => e.message.includes("中断")), "应有中断系统事件");
  } finally {
    store.close();
  }
});

test("端到端第二轮：会话上下文延续（turnIndex 递增）", async () => {
  const env = await startTestEnv();
  try {
    const sid = await openSession(env.baseUrl, env.token);
    await sendMessage(env.baseUrl, env.token, sid, "第一轮消息", "multi-1");
    const a1 = await waitForStatus(env.baseUrl, env.token, sid, "awaiting_answer");
    await answerTurn(env.baseUrl, env.token, sid, a1.id, "精简版");
    const d1 = await waitForStatus(env.baseUrl, env.token, sid, "succeeded");
    assert.equal(d1.result?.turnIndex, 0);

    // 第二轮：同一会话新消息
    await sendMessage(env.baseUrl, env.token, sid, "第二轮消息", "multi-2");
    const a2 = await waitForStatus(env.baseUrl, env.token, sid, "awaiting_answer");
    await answerTurn(env.baseUrl, env.token, sid, a2.id, "详细版");
    const d2 = await waitForStatus(env.baseUrl, env.token, sid, "succeeded");
    assert.equal(d2.result?.turnIndex, 1, "第二轮 turnIndex 应为 1（会话上下文延续）");

    const s = await getSession(env.baseUrl, env.token, sid);
    assert.equal(s.turns.length, 2, "会话应有两轮历史");
  } finally {
    await env.close();
  }
});

/** 直接以子进程驱动假 AI 脚本一次，返回其全部输出行（用于确定性校验）。 */
function runScriptOnce(message: string, answer: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE_AI_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    const lines: Array<Record<string, unknown>> = [];
    let buf = "";
    let answered = false;
    let settled = false;
    const finish = (err: unknown, value?: Array<Record<string, unknown>>) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // 忽略
      }
      if (err) reject(err);
      else resolve(value ?? []);
    };
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          lines.push(msg);
          if (msg.type === "ask" && !answered) {
            answered = true;
            child.stdin.write(JSON.stringify({ type: "answer", answer }) + "\n");
          }
        } catch {
          finish(new Error("脚本输出非 JSON 行：" + line.slice(0, 200)));
        }
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        finish(new Error(`脚本应正常退出，实际 code=${code}`));
        return;
      }
      finish(null, lines);
    });
    child.on("error", finish);
    child.stdin.write(JSON.stringify({ type: "start", message, turnIndex: 0 }) + "\n");
  });
}

test("畸形 JSON 请求体被拒绝（400）且进程继续服务", async () => {
  const env = await startTestEnv();
  try {
    const bad = await fetchJson(`${env.baseUrl}/api/sessions`, {
      method: "POST",
      headers: authed(env, { "content-type": "application/json" }),
      body: "{not-json",
    });
    assert.ok(bad.status === 400 || bad.status === 500, `畸形 JSON 应被拒绝，实际 ${bad.status}`);

    // 关键断言：进程没被打垮——同一路径的合法请求立即成功
    const ok = await fetchJson(`${env.baseUrl}/api/sessions`, {
      method: "POST",
      headers: authed(env, { "content-type": "application/json" }),
      body: JSON.stringify({ toolId: "fake-ai" }),
    });
    assert.equal(ok.status, 201);
  } finally {
    await env.close();
  }
});
