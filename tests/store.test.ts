// 持久化与重启恢复测试：状态机、上限、截断、中断语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, StoreError } from "../src/store";
import { recoverInterruptedTasks } from "../src/runner";
import { tempDataDir } from "./helpers";
import * as path from "node:path";

function newStore(opts?: { maxTasks?: number; maxEventsPerTask?: number; maxEventMessageChars?: number }) {
  return new Store(path.join(tempDataDir(), "base.db"), {
    maxTasks: opts?.maxTasks ?? 500,
    maxEventsPerTask: opts?.maxEventsPerTask ?? 200,
    maxEventMessageChars: opts?.maxEventMessageChars ?? 2000,
  });
}

test("重启恢复：pending 与 running 任务标记为 interrupted，写系统事件，不重跑", () => {
  const store = newStore();
  try {
    const pending = store.createTask({
      id: "t-pending",
      toolId: "text-stats",
      input: { text: "x" },
      idempotencyKey: "k-p",
      paramsHash: "h-p",
    });
    const running = store.createTask({
      id: "t-running",
      toolId: "text-stats",
      input: { text: "x" },
      idempotencyKey: "k-r",
      paramsHash: "h-r",
    });
    store.markRunning(running.id);
    store.appendEvent(running.id, "progress", "执行中", 10);

    const { interrupted } = recoverInterruptedTasks(store);
    assert.equal(interrupted, 2);

    const pAfter = store.getTask(pending.id)!;
    const rAfter = store.getTask(running.id)!;
    assert.equal(pAfter.status, "interrupted");
    assert.equal(rAfter.status, "interrupted");

    const eventsP = store.getEvents(pending.id);
    assert.ok(eventsP.some((e) => e.type === "system" && e.message.includes("处于 pending")));
    const eventsR = store.getEvents(running.id);
    assert.ok(eventsR.some((e) => e.type === "system" && e.message.includes("处于 running")));

    // 再次恢复：无新增
    const again = recoverInterruptedTasks(store);
    assert.equal(again.interrupted, 0);
  } finally {
    store.close();
  }
});

test("记录上限：终态任务超出 maxTasks 后裁剪最旧记录（连同事件）", () => {
  const store = newStore({ maxTasks: 3 });
  try {
    for (let i = 0; i < 5; i++) {
      const t = store.createTask({
        id: `cap-${i}`,
        toolId: "text-stats",
        input: { text: "x" },
        idempotencyKey: `ck-${i}`,
        paramsHash: `ch-${i}`,
      });
      store.markRunning(t.id);
      store.appendEvent(t.id, "progress", "done", 100);
      store.markSucceeded(t.id, { ok: true });
    }
    const kept = store.listTasks(100);
    assert.equal(kept.length, 3);
    assert.deepEqual(
      kept.map((t) => t.id),
      ["cap-4", "cap-3", "cap-2"]
    );
    // 旧任务的事件已清
    assert.equal(store.getEvents("cap-0").length, 0);
  } finally {
    store.close();
  }
});

test("事件上限：达到上限后丢弃并写一条系统标记事件", () => {
  const store = newStore({ maxEventsPerTask: 3 });
  try {
    const t = store.createTask({
      id: "ev-cap",
      toolId: "text-stats",
      input: { text: "x" },
      idempotencyKey: "ek",
      paramsHash: "eh",
    });
    for (let i = 0; i < 10; i++) {
      store.appendEvent(t.id, "progress", `第 ${i} 条`, i * 10);
    }
    const events = store.getEvents(t.id);
    // 3 条原始 + 1 条上限标记
    assert.equal(events.length, 4);
    const marker = events.find((e) => e.type === "system");
    assert.ok(marker && marker.message.includes("上限"));
    assert.ok(store.getTask(t.id)!.eventsCapped);
    // 再写：静默丢弃（返回 null，条数不变）
    const ret = store.appendEvent(t.id, "progress", "should drop", 1);
    assert.equal(ret, null);
    assert.equal(store.getEvents(t.id).length, 4);
  } finally {
    store.close();
  }
});

test("事件消息超长被截断并标注", () => {
  const store = newStore({ maxEventMessageChars: 50 });
  try {
    const t = store.createTask({
      id: "ev-trunc",
      toolId: "text-stats",
      input: { text: "x" },
      idempotencyKey: "ek2",
      paramsHash: "eh2",
    });
    const long = "字".repeat(300);
    const ev = store.appendEvent(t.id, "info", long, null)!;
    assert.ok(ev.message.length < long.length);
    assert.match(ev.message, /已截断/);
  } finally {
    store.close();
  }
});

test("状态机：非法迁移抛错，合法迁移可串行执行", () => {
  const store = newStore();
  try {
    const t = store.createTask({
      id: "sm",
      toolId: "text-stats",
      input: { text: "x" },
      idempotencyKey: "sm-k",
      paramsHash: "sm-h",
    });
    // pending → succeeded 非法
    assert.throws(() => store.markSucceeded(t.id, { ok: 1 }), StoreError);
    // pending → failed 非法
    assert.throws(() => store.markFailed(t.id, { message: "x" }), StoreError);
    // 同 key 重复创建 → 唯一约束
    assert.throws(
      () =>
        store.createTask({
          id: "sm2",
          toolId: "text-stats",
          input: { text: "x" },
          idempotencyKey: "sm-k",
          paramsHash: "sm-h",
        }),
      Error
    );
    // 合法序列
    store.markRunning(t.id);
    store.markTimeoutExceeded(t.id); // 只打标记，不改状态
    const running = store.getTask(t.id)!;
    assert.equal(running.status, "running");
    assert.ok(running.timeoutMarkedAt !== null);
    store.markSucceeded(t.id, { ok: true });
    // succeeded → running 非法
    assert.throws(() => store.markRunning(t.id), StoreError);
    // 超时标记写入对终态任务无效
    const done = store.getTask(t.id)!;
    store.markTimeoutExceeded(t.id);
    assert.equal(store.getTask(t.id)!.timeoutMarkedAt, done.timeoutMarkedAt);
  } finally {
    store.close();
  }
});
