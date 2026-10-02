// DSH 适配器（dsh-agent）契约测试：在可控假协议端（fake-dsh/server.js）上跑通
// 会话型适配器契约的完整面向。
// 隔离：测试环境用临时数据目录 + 临时端口 + 临时假协议端（端口 0），
// 不触碰 8811 的局域网服务、不依赖任何真实 DSH 进程或用户数据。
// 覆盖（对应任务步骤 2 的全部要求）：
//   能力声明与配置守卫、会话列表语义（1:1 会话映射）、发消息、增量（流式）输出、
//   提问/审批与回答、不可表示提问形态（多题/多选/自由文本）整轮显式失败不降级、
//   重复回答幂等不重放、失败（端侧 turn/end error 与流 stream/error）、
//   断线恢复（重开流 + 历史补齐 + seq 去重）、rpc 业务错误映射、只读探测与协议栅栏。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import { startTestEnv, fetchJson, authed, waitFor } from "./helpers";
import { dshAgentAdapter, dshDescribe } from "../src/adapters/dsh-agent";
import type { TestEnv } from "./helpers";

const fakeDshPath = path.resolve(__dirname, "..", "..", "fake-dsh", "server.js");
// 纯 JS 测试替身不在 tsconfig include 内（不进 dist），按运行时绝对路径 require；
// 类型以下面的 FakeDsh 接口约束，避免隐式 any。
const { startFakeDsh } = require(fakeDshPath) as {
  startFakeDsh: (opts?: { port?: number; cwd?: string }) => Promise<FakeDsh>;
};

interface FakeDsh {
  baseUrl: string;
  state: {
    sessions: Map<string, { sessionId: string; prompts: number; events: Array<{ type: string; seq: number }> }>;
    responds: number;
    prompts: number;
  };
  setFailCreate(v: boolean): void;
  close(): void;
}

let fake: FakeDsh;
let env: TestEnv;

test.before(async () => {
  fake = (await startFakeDsh({ port: 0 })) as FakeDsh;
  process.env.DSH_BASE_URL = fake.baseUrl;
  env = await startTestEnv();
});

test.after(async () => {
  await env.close();
  fake.close();
  delete process.env.DSH_BASE_URL;
});

interface TurnJson {
  id: string;
  sessionId: string;
  status: string;
  message: string;
  answer: string | null;
  result: { sessionId?: string; assistantText?: string; turnEndReason?: string } | null;
  error: { message?: string; stage?: string } | null;
  pendingQuestion: { prompt: string; options: string[] } | null;
}

interface SessionDetail {
  session: { id: string; toolId: string };
  liveTurn: (TurnJson & { events: Array<{ seq: number; type: string; message: string }> }) | null;
  lastTurn: (TurnJson & { events: Array<{ seq: number; type: string; message: string }> }) | null;
  turns: TurnJson[];
}

async function openSession(): Promise<string> {
  const r = await fetchJson(`${env.baseUrl}/api/sessions`, {
    method: "POST",
    headers: authed(env, { "content-type": "application/json" }),
    body: JSON.stringify({ toolId: "dsh-agent" }),
  });
  assert.equal(r.status, 201, `创建 dsh-agent 会话应为 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return (r.body as { session: { id: string } }).session.id;
}

async function sendMessage(sessionId: string, message: string): Promise<TurnJson> {
  const r = await fetchJson(`${env.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: authed(env, { "content-type": "application/json" }),
    body: JSON.stringify({ message, idempotencyKey: `dsh-${sessionId}-${message}-${Date.now()}` }),
  });
  assert.equal(r.status, 201, `消息提交应为 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return (r.body as { turn: TurnJson }).turn;
}

async function answerTurn(sessionId: string, turnId: string, answer: string): Promise<{ status: number; body: unknown }> {
  return fetchJson(`${env.baseUrl}/api/sessions/${sessionId}/turns/${turnId}/answer`, {
    method: "POST",
    headers: authed(env, { "content-type": "application/json" }),
    body: JSON.stringify({ answer }),
  });
}

async function getDetail(sessionId: string): Promise<SessionDetail> {
  const r = await fetchJson(`${env.baseUrl}/api/sessions/${sessionId}`, { headers: authed(env) });
  assert.equal(r.status, 200);
  return r.body as SessionDetail;
}

async function waitForStatus(sessionId: string, status: string, timeoutMs = 15000): Promise<TurnJson & { events: Array<{ seq: number; type: string; message: string }> }> {
  return waitFor(async () => {
    const s = await getDetail(sessionId);
    const live = s.liveTurn ?? s.lastTurn;
    if (live && live.status === status) return live;
    return null;
  }, timeoutMs);
}

/** 用原始 http 发一个带伪造 Host 头的请求（fetch 不允许改 Host，避免被误判为绕栅栏工具）。 */
function rawPost(host: string, port: number, hostHeader: string, pathname: string, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host, port, path: pathname, method: "POST", headers: { host: hostHeader, "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

test("能力声明：dsh-agent 为会话形态、声明全部会话能力、依赖外部端故不提供 examples", () => {
  const m = dshAgentAdapter.manifest;
  assert.equal(m.mode, "session");
  assert.deepEqual(m.capabilities, { sessions: true, listSessions: true, streaming: true, askUser: true });
  assert.equal(m.examples, undefined, "端依赖外部 DSH 服务器（DSH_BASE_URL），契约由假协议端覆盖");
  assert.ok(typeof (dshAgentAdapter as { runTurn: unknown }).runTurn === "function");
  assert.ok(fakeDshPath.length > 0, "假协议端脚本路径必须存在且非空");
});

test("未配置 DSH_BASE_URL 时 runTurn 明确失败（stage=dsh.config，不静默）", async () => {
  const saved = process.env.DSH_BASE_URL;
  delete process.env.DSH_BASE_URL;
  try {
    const out = await dshAgentAdapter.runTurn(
      { sessionId: "offline-session", message: "你好", history: [] },
      { turnId: "t-offline", emit: () => {}, ask: async () => "", signal: new AbortController().signal }
    );
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error.stage, "dsh.config");
      assert.match(out.error.message, /DSH_BASE_URL/);
    }
  } finally {
    process.env.DSH_BASE_URL = saved;
  }
});

test("完整会话流：发消息→流式分段→提问二选一→回答→succeeded，且 1:1 映射到同一 DSH 会话", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "你好，请整理一下这段说明");
  // 不在提交瞬间断言状态：调度器以 setImmediate 异步认领轮次（pending 是合法瞬态）；
  // 状态推进由后续 waitFor 覆盖。

  const awaiting = await waitForStatus(sessionId, "awaiting_answer");
  assert.equal(awaiting.pendingQuestion?.options.length, 2);
  assert.deepEqual(awaiting.pendingQuestion?.options, ["精简版", "详细版"]);
  assert.ok(awaiting.pendingQuestion?.prompt.includes("生成结果"));

  const ans = await answerTurn(sessionId, awaiting.id, "详细版");
  assert.equal(ans.status, 200);

  const done = await waitForStatus(sessionId, "succeeded");
  assert.equal(done.result?.sessionId, sessionId, "结果里的 sessionId 必须是底座会话 id（1:1 映射）");
  assert.ok(done.result?.assistantText?.includes("默认流程完成"));
  assert.equal(done.result?.turnEndReason, "normal");

  // 流式证据：事件里既有流式分段也有收尾消息
  const messages = done.events.map((e) => e.message);
  assert.ok(messages.includes("正在汇总你的请求…"));
  assert.ok(messages.includes("已按所选形式继续"));

  // 假协议端证据：恰好一次 prompt、一次 respond；会话落在同一 id 上
  assert.equal(fake.state.prompts, 1);
  assert.equal(fake.state.responds, 1);
  assert.ok(fake.state.sessions.has(sessionId));
});

test("重复回答幂等：同回答再提交返回 idempotentReplay，DSH 侧不重复扣回答", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "再来一遍完整流程");
  const awaiting = await waitForStatus(sessionId, "awaiting_answer");
  await answerTurn(sessionId, awaiting.id, "精简版");
  const done = await waitForStatus(sessionId, "succeeded");
  const respondsBefore = fake.state.responds;

  const again = await answerTurn(sessionId, done.id, "精简版");
  assert.equal(again.status, 200);
  assert.equal((again.body as { idempotentReplay?: boolean }).idempotentReplay, true);
  assert.equal(fake.state.responds, respondsBefore, "幂等重放不得再次向 DSH 提交回答");
});

test("多轮上下文延续：同一会话第二轮消息仍落到同一 DSH 会话", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "第一轮：看一下");
  const a1 = await waitForStatus(sessionId, "awaiting_answer");
  await answerTurn(sessionId, a1.id, "精简版");
  await waitForStatus(sessionId, "succeeded");

  await sendMessage(sessionId, "第二轮：继续");
  const a2 = await waitForStatus(sessionId, "awaiting_answer");
  await answerTurn(sessionId, a2.id, "详细版");
  const t2 = await waitForStatus(sessionId, "succeeded");
  assert.equal(t2.result?.sessionId, sessionId);

  const dshSession = fake.state.sessions.get(sessionId);
  assert.equal(dshSession?.prompts, 2, "DSH 侧同一会话恰好两次 prompt（上下文由服务端日志保持）");
});

test("无提问流程：无提问直抵 succeeded，全程不出现 awaiting_answer", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "无提问模式");
  const done = await waitForStatus(sessionId, "succeeded");
  assert.equal(done.result?.turnEndReason, "normal");
  const statuses = (await getDetail(sessionId)).turns.map((t) => t.status);
  assert.ok(!statuses.includes("awaiting_answer"));
});

test("失败流程：端侧 turn/end(kind=error) 映射为 failed 且带错误证据", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "这次模拟失败");
  const failed = await waitForStatus(sessionId, "failed");
  assert.equal(failed.error === null, false);
  assert.match(failed.error?.message ?? "", /模拟失败/);
  assert.equal(failed.result, null);
});

test("流错误流程：stream/error 帧映射为 failed 且带 code 证据", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "演示流错误");
  const failed = await waitForStatus(sessionId, "failed");
  assert.match(failed.error?.message ?? "", /internal|模拟实时流错误/);
});
 
 test("多题批次：不悄悄只答首题丢掉其余，整轮显式失败（stage=dsh.question-batch）", async () => {
   const respondsBefore = fake.state.responds;
   const sessionId = await openSession();
   await sendMessage(sessionId, "多题场景：一次索取两个回答");
   const failed = await waitForStatus(sessionId, "failed");
   assert.equal(failed.error?.stage, "dsh.question-batch");
   assert.match(failed.error?.message ?? "", /2 个问题/);
   assert.match(failed.error?.message ?? "", /第一问|第二问/, "缺口说明须列出被丢弃的问题文本");
   // 未把首题降级成二选一：全程不出现待答状态
   const statuses = (await getDetail(sessionId)).turns.map((t) => t.status);
   assert.ok(!statuses.includes("awaiting_answer"), "多题批次不得退化为单题提问");
   // 未自动回答：fake 端 responds 计数不变
   assert.equal(fake.state.responds, respondsBefore, "多题批次不得向 DSH 提交任何回答");
 });
 
 test("多选提问：不降级成单选，整轮显式失败（stage=dsh.question-multiselect）", async () => {
   const respondsBefore = fake.state.responds;
   const sessionId = await openSession();
   await sendMessage(sessionId, "多选场景：需要勾选多项");
   const failed = await waitForStatus(sessionId, "failed");
   assert.equal(failed.error?.stage, "dsh.question-multiselect");
   assert.match(failed.error?.message ?? "", /多选/);
   const statuses = (await getDetail(sessionId)).turns.map((t) => t.status);
   assert.ok(!statuses.includes("awaiting_answer"), "多选提问不得退化为单选");
   assert.equal(fake.state.responds, respondsBefore, "多选提问不得提交失真的单选回答");
 });
 
 test("自由文本提问：不伪造选项，整轮显式失败（stage=dsh.question-unrepresentable）", async () => {
   const respondsBefore = fake.state.responds;
   const sessionId = await openSession();
   await sendMessage(sessionId, "自由文本场景：请输入任意内容");
   const failed = await waitForStatus(sessionId, "failed");
   assert.equal(failed.error?.stage, "dsh.question-unrepresentable");
   assert.match(failed.error?.message ?? "", /自由文本|无法映射/);
  const statuses = (await getDetail(sessionId)).turns.map((t) => t.status);
  assert.ok(!statuses.includes("awaiting_answer"), "自由文本不得伪造选项按钮");
  assert.equal(fake.state.responds, respondsBefore, "自由文本提问不得自动回答");
});

test("重复选项标签：不产生歧义回答，整轮显式失败（stage=dsh.question-duplicate-options）", async () => {
  const respondsBefore = fake.state.responds;
  const sessionId = await openSession();
  await sendMessage(sessionId, "重复选项场景：两个选项同名");
  const failed = await waitForStatus(sessionId, "failed");
  assert.equal(failed.error?.stage, "dsh.question-duplicate-options");
  assert.match(failed.error?.message ?? "", /重复的选项标签/);
  const statuses2 = (await getDetail(sessionId)).turns.map((t) => t.status);
  assert.ok(!statuses2.includes("awaiting_answer"), "重复选项不得生成有歧义的单选按钮");
  assert.equal(fake.state.responds, respondsBefore, "重复选项提问不得提交任何回答");
});

test("审批流程：approval/requested 映射为二选一提问，由手机批准后继续", async () => {
  const respondsBefore = fake.state.responds;
  const sessionId = await openSession();
  await sendMessage(sessionId, "需要审批才能继续");
  const awaiting = await waitForStatus(sessionId, "awaiting_answer");
  assert.deepEqual(awaiting.pendingQuestion?.options, ["允许一次", "拒绝"]);
  assert.match(awaiting.pendingQuestion?.prompt ?? "", /权限请求/);

  const ans = await answerTurn(sessionId, awaiting.id, "允许一次");
  assert.equal(ans.status, 200);
  const done = await waitForStatus(sessionId, "succeeded");
  assert.equal(done.result?.turnEndReason, "normal");
  // 全局 responds 计数跨测试累加：用相对差断言（本测试恰好一次审批提交）
  assert.equal(fake.state.responds, respondsBefore + 1, "审批结果恰好提交一次");
});

test("断线恢复：mux 意外断开 → 拉历史 + 重开流，事件按 seq 去重不丢失不重复", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "断线重连演示");
  // 全程只回答一次（提问发生在重连之后）
  const awaiting = await waitForStatus(sessionId, "awaiting_answer");
  assert.deepEqual(awaiting.pendingQuestion?.options, ["精简版", "详细版"]);
  await answerTurn(sessionId, awaiting.id, "详细版");
  const done = await waitForStatus(sessionId, "succeeded", 20000);
  assert.equal(done.result?.turnEndReason, "normal");

  const messages = done.events.map((e) => e.message);
  const count = (needle: string) => messages.filter((m) => m === needle).length;
  // 关键去重证据：三段各只出现一次（第一/二段来自断线前，第三段来自历史补齐或重连后实时帧）
  assert.equal(count("断线场景：第一段"), 1);
  assert.equal(count("断线场景：第二段"), 1);
  assert.equal(count("断线恢复后：第三段"), 1, "第三段不得丢失也不得重复");
  assert.ok(done.result?.assistantText?.includes("断线恢复完成"));
});

test("rpc 业务错误映射：session.create 被 DSH 拒绝时轮次 failed 且携带 code", async () => {
  fake.setFailCreate(true);
  try {
    const sessionId = await openSession();
    await sendMessage(sessionId, "create 被拒绝的场景");
    const failed = await waitForStatus(sessionId, "failed");
    assert.match(failed.error?.message ?? "", /agent-preset-invalid|模拟会话组合失败/);
    assert.equal(failed.error?.stage, "dsh.create");
  } finally {
    fake.setFailCreate(false);
  }
});

test("协议层只读探测与栅栏镜像：dshDescribe 走适配器同一代码路径；GET 事件路径 426；非回环 Host 403", async () => {
  const describe = await dshDescribe(fake.baseUrl);
  assert.equal(describe.ok, true);
  if (describe.ok) {
    assert.ok(typeof describe.value.version === "string");
    assert.ok(typeof describe.value.attachedSessions === "number");
  }

  const pollGet = await fetchJson(`${fake.baseUrl}/api/events.mux`);
  assert.equal(pollGet.status, 426, "普通 GET 事件路径必须 426（官方明确不保留 SSE 回退）");

  const fence = await rawPost("127.0.0.1", Number(new URL(fake.baseUrl).port), "evil.example", "/api/host.describe", {
    type: "client-request",
    rpcId: "fence-test",
    method: "host.describe",
    payload: {},
  });
  assert.equal(fence.status, 403, "Host 非回环必须 403（适配器只以回环调用，从不绕栅栏）");
});

test("非法回答被拒绝（400 INVALID_ANSWER），与其它会话端一致", async () => {
  const sessionId = await openSession();
  await sendMessage(sessionId, "非法回答演示");
  const awaiting = await waitForStatus(sessionId, "awaiting_answer");
  const bad = await answerTurn(sessionId, awaiting.id, "不存在的选项");
  assert.equal(bad.status, 400);
  // 回合仍可正确回答
  await answerTurn(sessionId, awaiting.id, "精简版");
  await waitForStatus(sessionId, "succeeded");
});
