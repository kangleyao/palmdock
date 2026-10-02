// HTTP 集成测试：所有断言都打真实的回环 HTTP 服务。
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestEnv, submitTask, getTask, fetchJson, authed, waitFor, type TestEnv } from "./helpers";
import type { TaskRecord, EventRecord } from "../src/types";

interface TaskPayload {
  task: TaskRecord;
  events: EventRecord[];
}

async function untilTerminal(env: TestEnv, id: string): Promise<TaskPayload> {
  return waitFor(async () => {
    const r = await getTask(env, id);
    if (r.status !== 200) return null;
    const p = r.body as TaskPayload;
    if (p.task.status === "pending" || p.task.status === "running") return null;
    return p;
  });
}

test("未授权请求一律 401（含工具清单），health 不需 token", async () => {
  const env = await startTestEnv();
  try {
    const noToken = await fetchJson(`${env.baseUrl}/api/tools`);
    assert.equal(noToken.status, 401);
    assert.match(JSON.stringify(noToken.body), /UNAUTHORIZED/);

    const wrong = await fetchJson(`${env.baseUrl}/api/tools`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(wrong.status, 401);

    const malformed = await fetchJson(`${env.baseUrl}/api/tools`, { headers: { authorization: "Basic abc" } });
    assert.equal(malformed.status, 401);

    const noTokenSubmit = await fetchJson(`${env.baseUrl}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ toolId: "text-stats", idempotencyKey: "k", input: {} }),
    });
    assert.equal(noTokenSubmit.status, 401);

    const health = await fetchJson(`${env.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual((health.body as { ok: boolean }).ok, true);
  } finally {
    await env.close();
  }
});

test("工具清单包含全部已注册工具及其字段（子集断言，允许新增）", async () => {
  const env = await startTestEnv();
  try {
    const r = await fetchJson(`${env.baseUrl}/api/tools`, { headers: authed(env) });
    assert.equal(r.status, 200);
    const tools = (r.body as { tools: Array<{ id: string; fields: Array<{ name: string; type: string; options?: string[] }> }> }).tools;
    // 子集断言：新增工具不得被迫修改本公共测试（曾硬编码全量清单导致新适配器必须改测试）
    const ids = tools.map((t) => t.id);
    assert.ok(["text-stats", "dir-listing"].every((id) => ids.includes(id)), `清单缺少内置工具：${ids.join(",")}`);

    const dirTool = tools.find((t) => t.id === "dir-listing")!;
    const sortBy = dirTool.fields.find((f) => f.name === "sortBy")!;
    assert.equal(sortBy.type, "select");
    assert.deepEqual(sortBy.options, ["name", "size"]);
  } finally {
    await env.close();
  }
});

test("合法任务端到端：提交→进度→成功，事件有序且 percent 合法", async () => {
  const env = await startTestEnv();
  try {
    const text = "a".repeat(5000) + "\n" + "中文".repeat(10);
    const submitted = await submitTask(env, { toolId: "text-stats", input: { text } });
    assert.equal(submitted.status, 201);
    const created = (submitted.body as { task: TaskRecord }).task;
    assert.match(created.status, /pending|running/);

    const payload = await untilTerminal(env, created.id);
    assert.equal(payload.task.status, "succeeded");
    const result = payload.task.result as { characters: number; lines: number; cjkChars: number };
    assert.equal(result.characters, 5000 + 1 + 20);
    assert.equal(result.lines, 2);
    assert.equal(result.cjkChars, 20);

    // 事件按 seq 递增；percent 落在 0..100
    const seqs = payload.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    for (const e of payload.events) {
      if (e.percent !== null) {
        assert.ok(e.percent >= 0 && e.percent <= 100, `percent 非法：${e.percent}`);
      }
    }
    const progress = payload.events.filter((e) => e.type === "progress");
    assert.ok(progress.length >= 5, "长文本应有多条进度事件");
    const lastProgress = progress[progress.length - 1];
    assert.ok(lastProgress, "应存在最后一条进度事件");
    assert.equal(lastProgress.percent, 100);
  } finally {
    await env.close();
  }
});

test("sinceSeq 增量查询只返回新事件", async () => {
  const env = await startTestEnv();
  try {
    const text = "b".repeat(5000);
    const submitted = await submitTask(env, { toolId: "text-stats", input: { text } });
    const id = (submitted.body as { task: TaskRecord }).task.id;
    const payload = await untilTerminal(env, id);
    const first = payload.events[0];
    assert.ok(first, "至少应有一条事件");
    const rest = await getTask(env, id, first.seq);
    const evs = (rest.body as TaskPayload).events;
    assert.ok(evs.length >= 1);
    assert.ok(evs.every((e) => e.seq > first.seq));
  } finally {
    await env.close();
  }
});

test("非法输入与未知工具被拒绝并给出字段级原因", async () => {
  const env = await startTestEnv();
  try {
    const missing = await submitTask(env, { toolId: "text-stats", input: {} });
    assert.equal(missing.status, 400);
    assert.match(JSON.stringify(missing.body), /INVALID_INPUT/);

    const badEnum = await submitTask(env, { toolId: "dir-listing", input: { sortBy: "bogus" } });
    assert.equal(badEnum.status, 400);
    assert.match(JSON.stringify(badEnum.body), /sortBy/);

    const badType = await submitTask(env, { toolId: "dir-listing", input: { limit: "many" } });
    assert.equal(badType.status, 400);

    const unknown = await submitTask(env, { toolId: "no-such-tool", input: {} });
    assert.equal(unknown.status, 404);
    assert.match(JSON.stringify(unknown.body), /UNKNOWN_TOOL/);

    const badBody = await fetchJson(`${env.baseUrl}/api/tasks`, {
      method: "POST",
      headers: authed(env),
      body: JSON.stringify({ toolId: "text-stats" }),
    });
    assert.equal(badBody.status, 400);
  } finally {
    await env.close();
  }
});

test("幂等重放：同 key 同参数返回同一任务，不重复执行", async () => {
  const env = await startTestEnv();
  try {
    const first = await submitTask(env, {
      toolId: "text-stats",
      input: { text: "idempotent check" },
      idempotencyKey: "key-same-1",
    });
    assert.equal(first.status, 201);
    const firstId = (first.body as { task: TaskRecord }).task.id;

    await untilTerminal(env, firstId);

    const second = await submitTask(env, {
      toolId: "text-stats",
      input: { text: "idempotent check" },
      idempotencyKey: "key-same-1",
    });
    assert.equal(second.status, 200);
    assert.equal((second.body as { task: TaskRecord }).task.id, firstId);

    // 数据库中该幂等键只有一个任务（没有第二次执行）
    const tasks = env.store.listTasks(100).filter((t) => t.idempotencyKey === "key-same-1");
    assert.equal(tasks.length, 1);
    const only = tasks[0];
    assert.ok(only, "应存在一条任务");
    assert.equal(only.status, "succeeded");
  } finally {
    await env.close();
  }
});

test("幂等键冲突：同 key 异参数返回 409 并给出已存在任务", async () => {
  const env = await startTestEnv();
  try {
    const first = await submitTask(env, {
      toolId: "text-stats",
      input: { text: "params-a" },
      idempotencyKey: "key-conflict-2",
    });
    assert.equal(first.status, 201);
    const firstId = (first.body as { task: TaskRecord }).task.id;

    const conflict = await submitTask(env, {
      toolId: "text-stats",
      input: { text: "params-b" },
      idempotencyKey: "key-conflict-2",
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { existingTaskId: string }).existingTaskId, firstId);

    const conflictOtherTool = await submitTask(env, {
      toolId: "dir-listing",
      input: { sortBy: "name" },
      idempotencyKey: "key-conflict-2",
    });
    assert.equal(conflictOtherTool.status, 409);
  } finally {
    await env.close();
  }
});

test("查询不存在的任务返回 404；任务列表可查", async () => {
  const env = await startTestEnv();
  try {
    const missing = await getTask(env, "00000000-0000-0000-0000-000000000000");
    assert.equal(missing.status, 404);

    await submitTask(env, { toolId: "text-stats", input: { text: "list check" } });
    const list = await fetchJson(`${env.baseUrl}/api/tasks?limit=10`, { headers: authed(env) });
    assert.equal(list.status, 200);
    assert.ok(((list.body as { tasks: TaskRecord[] }).tasks.length ?? 0) >= 1);
  } finally {
    await env.close();
  }
});

test("第二个适配器（接口不同）走同一公共链路成功：dir-listing", async () => {
  const env = await startTestEnv();
  try {
    const submitted = await submitTask(env, { toolId: "dir-listing", input: { sortBy: "name", limit: 3 } });
    assert.equal(submitted.status, 201);
    const payload = await untilTerminal(env, (submitted.body as { task: TaskRecord }).task.id);
    assert.equal(payload.task.status, "succeeded");
    const result = payload.task.result as { totalCount: number; entries: Array<{ name: string }>; truncated: boolean };
    assert.ok(result.entries.length <= 3);
    assert.ok(result.entries.some((e) => e.name === "README.txt"));

    // 消息流事件存在（无 percent）
    const info = payload.events.filter((e) => e.type === "info");
    assert.ok(info.length >= 2);

    // limit 触发截断标记
    assert.equal(result.truncated, true);
    const note = payload.events.find((e) => e.message.includes("返回"));
    assert.ok(note);
  } finally {
    await env.close();
  }
});

test("响应头包含安全头；静态主页可访问", async () => {
  const env = await startTestEnv();
  try {
    const res = await fetch(`${env.baseUrl}/api/tools`, { headers: authed(env) });
    assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(res.headers.get("content-security-policy")?.includes("script-src 'self'"));

    const home = await fetch(`${env.baseUrl}/`);
    const html = await home.text();
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /掌坞/);
  } finally {
    await env.close();
  }
});
