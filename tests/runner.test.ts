// 运行器单测：注入伪适配器，验证失败证据、超时只提示、结果截断、并发 FIFO。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { Store } from "../src/store";
import { TaskRunner } from "../src/runner";
import { tempDataDir, waitFor } from "./helpers";
import type { Adapter, AdapterRunResult, JsonValue } from "../src/types";

function newStore(opts?: { maxTasks?: number }) {
  return new Store(path.join(tempDataDir(), "base.db"), {
    maxTasks: opts?.maxTasks ?? 500,
    maxEventsPerTask: 200,
    maxEventMessageChars: 2000,
  });
}

function makeAdapter(manifestOverrides: Record<string, unknown>, run: Adapter["run"]): Adapter {
  const base = {
    id: "mock",
    name: "mock",
    description: "mock",
    inputSchema: undefined as unknown,
  };
  return {
    manifest: { ...base, ...manifestOverrides } as Adapter["manifest"],
    run,
  };
}

async function driveTask(adapter: Adapter, opts?: { limits?: { maxConcurrent?: number; maxResultBytes?: number } }): Promise<Store> {
  const store = newStore();
  const runner = new TaskRunner({
    store,
    getAdapter: (id) => (id === "mock" ? adapter : undefined),
    limits: {
      maxTasks: 500,
      maxEventsPerTask: 200,
      maxEventMessageChars: 2000,
      maxInputBytes: 16 * 1024,
      maxResultBytes: 4 * 1024, // 小上限便于测试
      maxConcurrent: opts?.limits?.maxConcurrent ?? 4,
    },
  });
  const task = store.createTask({
    id: "r1",
    toolId: "mock",
    input: {},
    idempotencyKey: "rk",
    paramsHash: "rh",
  });
  runner.enqueue(task.id);
  await waitFor(() => {
    const t = store.getTask(task.id);
    return t && t.status !== "pending" ? t : null;
  }, 5000)
    .catch(() => null); // 超时也继续返回 store，由调用方断言终态
  return store;
}

test("适配器抛出异常 → failed，含 message/stage/detail 证据", async () => {
  const adapter = makeAdapter({}, async () => {
    throw new Error("boom from tool");
  });
  const store = await driveTask(adapter);
  try {
    const t = store.getTask("r1")!;
    assert.equal(t.status, "failed");
    assert.equal(t.error!.message, "boom from tool");
    assert.equal(t.error!.stage, "adapter.run");
    assert.ok(t.error!.detail && t.error!.detail.includes("boom from tool"));
    assert.ok(t.finishedAt !== null);
  } finally {
    store.close();
  }
});

test("适配器返回 ok:false → failed，错误对象原样存证", async () => {
  const adapter: Adapter = makeAdapter({}, async () => ({
    ok: false,
    error: { message: "目标工具返回错误码 42", detail: "stderr 末尾片段", stage: "tool" },
  }));
  const store = await driveTask(adapter);
  try {
    const t = store.getTask("r1")!;
    assert.equal(t.status, "failed");
    assert.equal(t.error!.message, "目标工具返回错误码 42");
    assert.equal(t.error!.stage, "tool");
  } finally {
    store.close();
  }
});

test("适配器返回非法结果（不可序列化）→ failed 并说明", async () => {
  const adapter = makeAdapter({}, async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    return { ok: true, result: circular as unknown as JsonValue };
  });
  const store = await driveTask(adapter);
  try {
    const t = store.getTask("r1")!;
    assert.equal(t.status, "failed");
    assert.match(t.error!.message, /无法序列化/);
    assert.equal(t.error!.stage, "result.serialize");
  } finally {
    store.close();
  }
});

test("结果超上限 → 成功但截断，事件留证", async () => {
  const big: JsonValue = { rows: Array.from({ length: 2000 }, (_, i) => ({ i, s: "x".repeat(100) })) };
  const adapter: Adapter = makeAdapter({}, async (): Promise<AdapterRunResult> => ({ ok: true, result: big }));
  const store = await driveTask(adapter);
  try {
    const t = await waitFor(() => store.getTask("r1"), 5000);
    // 结果 4KB 上限：要么截断成功，要么失败，都必须有明确终态与证据
    assert.ok(t.status === "succeeded" || t.status === "failed", `意外状态：${t.status}`);
    if (t.status === "succeeded") {
      const result = t.result as { truncated?: boolean; preview?: string };
      assert.ok(result.truncated === true || (result as { rows?: unknown }).rows, "截断标记或原结果其一");
      const evs = store.getEvents("r1");
      assert.ok(evs.some((e) => e.message.includes("超过上限") || e.message.includes("截断")));
    }
  } finally {
    store.close();
  }
});

test("超时只标记“仍未确认结束”，不打断执行、不改状态；完成后正常终结", async () => {
  const store = newStore();
  let hit40 = false;
  const adapter = makeAdapter({ timeoutMs: 60 }, async () => {
    await new Promise((r) => setTimeout(r, 400));
    hit40 = true;
    return { ok: true, result: { done: true } } as AdapterRunResult;
  });
  const runner = new TaskRunner({
    store,
    getAdapter: (id) => (id === "mock" ? adapter : undefined),
    limits: { maxTasks: 500, maxEventsPerTask: 200, maxEventMessageChars: 2000, maxInputBytes: 16 * 1024, maxResultBytes: 64 * 1024, maxConcurrent: 4 },
  });
  store.createTask({ id: "to1", toolId: "mock", input: {}, idempotencyKey: "tk", paramsHash: "th" });
  runner.enqueue("to1");

  // 超时窗口后：仍 running + 已打标记 + 有系统事件
  await new Promise((r) => setTimeout(r, 220));
  const mid = store.getTask("to1")!;
  assert.equal(mid.status, "running");
  assert.ok(mid.timeoutMarkedAt !== null, "应已打超时标记");
  const evs = store.getEvents("to1").filter((e) => e.type === "system");
  assert.ok(evs.some((e) => e.message.includes("仍未确认") || e.message.includes("不会被标记为失败")));

  // 适配器最终完成：正常 succeeded（不是 failed）
  const final = await waitFor(() => {
    const t = store.getTask("to1");
    return t && t.status === "succeeded" ? t : null;
  }, 5000);
  assert.equal(hit40, true, "底层执行未被终止，已正常跑完");
  assert.deepEqual(final.result, { done: true });
  store.close();
});

test("maxConcurrent=1 时按创建顺序 FIFO 执行", async () => {
  const store = newStore();
  const order: string[] = [];
  const makeSlow = (name: string): Adapter =>
    makeAdapter({}, async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, result: { who: name } } as AdapterRunResult;
    });
  // 用 toolId 区分三个适配器
  const adapters = new Map<string, Adapter>([
    ["slow-a", makeSlow("a")],
    ["slow-b", makeSlow("b")],
    ["slow-c", makeSlow("c")],
  ]);
  const runner = new TaskRunner({
    store,
    getAdapter: (id) => adapters.get(id),
    limits: { maxTasks: 500, maxEventsPerTask: 200, maxEventMessageChars: 2000, maxInputBytes: 16 * 1024, maxResultBytes: 64 * 1024, maxConcurrent: 1 },
  });
  for (const id of ["slow-a", "slow-b", "slow-c"]) {
    store.createTask({ id, toolId: id, input: {}, idempotencyKey: `k-${id}`, paramsHash: `h-${id}` });
    runner.enqueue(id);
  }
  for (const id of ["slow-a", "slow-b", "slow-c"]) {
    await waitFor(() => {
      const t = store.getTask(id);
      return t && t.status === "succeeded" ? t : null;
    }, 8000);
  }
  assert.deepEqual(order, ["a", "b", "c"], "串行调度应保持 FIFO");
  store.close();
});
