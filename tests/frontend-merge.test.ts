// 事件多来源去重/合并的单元测试（回归：缓存与竞态导致历史事件被丢弃）。
// 场景：GET /api/sessions/:id 只带焦点轮次事件（字段名 taskId），SSE hello/change 带
// 会话级事件（字段名 turnId，值与 taskId 相同）。合并必须不重不漏、按 seq 有序。
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

function loadFrontendSandbox(): Record<string, unknown> {
  const code = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "app.js"), "utf8");
  const stubDoc = {
    addEventListener: () => {},
    documentElement: { setAttribute: () => {}, getAttribute: () => "auto" },
    body: { getAttribute: () => null },
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const sandbox: Record<string, unknown> = {
    window: { isSecureContext: true },
    document: stubDoc,
    localStorage: { getItem: () => null, setItem: () => {} },
    console: { warn: () => {} },
    crypto: { getRandomValues: (buf: Uint8Array) => buf },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 5000 });
  return sandbox;
}

const sandbox = loadFrontendSandbox();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = sandbox as any;

// 真实形状的对照数据（按一次真实会话直连 SSE 读到的事件分布等比例缩写）：
// T1=3 条（seq 1..3）、T2=4 条（seq 4..7，其中 seq 7 是 T2 的 AI 回答正文）、T3=6 条（seq 8..13）
interface EvShape {
  seq: number; type: string; message: string; percent: null; createdAt: string;
  turnId?: string; taskId?: string;
}
function ev(seq: number, turnId: string, message: string, asRest = false): EvShape {
  const e: EvShape = { seq, type: "info", message, percent: null, createdAt: "2026-10-01T08:00:00Z" };
  // REST 详情路径字段名是 taskId；SSE 快照字段名是 turnId（同一 store 行的两种序列化名）
  if (asRest) e.taskId = turnId;
  else e.turnId = turnId;
  return e;
}

const T1 = "t1", T2 = "t2", T3 = "t3";
// SSE 全会话重放（hello）：13 条，字段 turnId
const sseFull: EvShape[] = [
  ev(1, T1, "已连接"), ev(2, T1, "已提交"), ev(3, T1, "开始执行"),
  ev(4, T2, "已连接"), ev(5, T2, "已提交"), ev(6, T2, "开始执行"),
  ev(7, T2, "你好！我是 AI 助手。"), // T2 的 AI 回答正文（缺陷中消失的那条）
  ev(8, T3, "已连接"), ev(9, T3, "已提交"), ev(10, T3, "开始执行"),
  ev(11, T3, "进度 50"), ev(12, T3, "进度 90"), ev(13, T3, "完成"),
];
// REST 详情（refresh）：只含末轮 T3 的 6 条，字段 taskId
const restFocus: EvShape[] = sseFull.filter((e) => e.seq >= 8).map((e) => ev(e.seq, T3, e.message, true));

// vm 沙箱返回的数组是跨 realm 的：deepStrictEqual 比较原型，先在测试 realm 重建
function seqsOf(merged: EvShape[]): number[] {
  return Array.from(merged.map((e) => e.seq));
}

test("eventDedupeKey：两来源同一事件同 key；不同轮次同 seq 不同 key", () => {
  assert.equal(fn.eventDedupeKey({ seq: 7, turnId: T2 }), fn.eventDedupeKey({ seq: 7, taskId: T2 }));
  assert.notEqual(fn.eventDedupeKey({ seq: 7, turnId: T1 }), fn.eventDedupeKey({ seq: 7, turnId: T2 }));
  assert.equal(fn.eventDedupeKey(null), "?|?");
  assert.equal(fn.eventDedupeKey({ seq: 1 }), "?|1"); // 无轮次归属的事件也去重
});

test("mergeEventLists：REST 先到（只 6 条）与 SSE 全量（13 条）合并 = 13 条不重不漏", () => {
  // 缺陷复现口径：REST 先到 6 条，SSE hello 后到 13 条
  const merged = fn.mergeEventLists([restFocus, sseFull]);
  assert.equal(merged.length, 13, "合并后应等于全量 13 条（REST 的 6 条是 SSE 13 条的子集）");
  assert.deepEqual(seqsOf(merged), Array.from({ length: 13 }, (_, i) => i + 1), "seq 1..13 升序齐全");
  // T2 的 AI 回答正文明细必须在（缺陷中它整条消失）
  assert.ok(merged.some((e: { message: unknown }) => e.message === "你好！我是 AI 助手。"));
});

test("mergeEventLists：SSE 先到（13 条）与 REST 后到（6 条）合并 = 同样 13 条（顺序无关）", () => {
  const merged = fn.mergeEventLists([sseFull, restFocus]);
  assert.equal(merged.length, 13);
  assert.deepEqual(seqsOf(merged), Array.from({ length: 13 }, (_, i) => i + 1));
});

test("mergeEventLists：重复清单份不膨胀；空/null 安全", () => {
  const once = fn.mergeEventLists([sseFull]);
  const twice = fn.mergeEventLists([sseFull, sseFull, sseFull]);
  assert.equal(once.length, 13);
  assert.equal(twice.length, 13, "同一份列表重复传入不得膨胀");
  assert.equal(fn.mergeEventLists([]).length, 0);
  assert.equal(fn.mergeEventLists([null, undefined, []]).length, 0);
  // 缺 seq 的事件排到末尾且不丢失
  const weird = fn.mergeEventLists([[{ turnId: T1, message: "no-seq" }, ...sseFull]]);
  assert.equal(weird.length, 14);
  assert.equal(weird[13].message, "no-seq");
});

test("maxEventSeq：最大 seq；非数字 seq 不计；空列表为 0", () => {
  assert.equal(fn.maxEventSeq(sseFull), 13);
  assert.equal(fn.maxEventSeq(restFocus), 13, "REST 6 条虽不全但其 maxSeq=13——这正是不能用单调水位去重的原因");
  assert.equal(fn.maxEventSeq([]), 0);
  assert.equal(fn.maxEventSeq(null), 0);
  assert.equal(fn.maxEventSeq([{ seq: "x" }, { nope: 1 }]), 0);
});
