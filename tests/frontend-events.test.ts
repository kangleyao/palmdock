// 前端事件分类与相对时间的单元测试：把 public/app.js 加载进 vm 沙箱，
// 只取纯函数，不依赖真实 DOM。
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

/** 加载 app.js 到最小桩环境，返回沙箱全局（纯函数在顶层声明，挂在沙箱上）。 */
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

test("classifyEvent：过程事件（连接/提交/开始/启动回执）收进抽屉", () => {
  assert.equal(fn.classifyEvent({ type: "info", message: "已连接 DSH 实时事件流", createdAt: "2026-10-01T08:00:00Z" }), "process");
  assert.equal(fn.classifyEvent({ type: "info", message: "消息已提交给 DSH 会话（第 3 轮）", createdAt: "2026-10-01T08:00:00Z" }), "process");
  assert.equal(fn.classifyEvent({ type: "info", message: "DSH 端已开始本轮执行", createdAt: "2026-10-01T08:00:00Z" }), "process");
  assert.equal(fn.classifyEvent({ type: "info", message: "演示助手已启动（本地运行，第 2 轮）", createdAt: "2026-10-01T08:00:00Z" }), "process");
  assert.equal(fn.classifyEvent({ type: "progress", message: "正在处理…", percent: 42, createdAt: "2026-10-01T08:00:00Z" }), "process");
  assert.equal(fn.classifyEvent({ type: "info", message: "【等待你的回答】选哪个？（选项：A / B）", createdAt: "2026-10-01T08:00:00Z" }), "process");
  assert.equal(fn.classifyEvent({ type: "system", message: "已收到你的回答：“方案 A”，继续执行。", createdAt: "2026-10-01T08:00:00Z" }), "process");
});

test("classifyEvent：回答正文默认可见；未知端的 info 一律当正文（安全默认，不漏内容）", () => {
  assert.equal(fn.classifyEvent({ type: "info", message: "你好！我是 DeepSeek Harness 上的助手", createdAt: "2026-10-01T08:00:00Z" }), "answer");
  assert.equal(fn.classifyEvent({ type: "info", message: "某个未知端输出的任意内容", createdAt: "2026-10-01T08:00:00Z" }), "answer");
});

test("classifyEvent：提醒与系统注意项绝不藏（默认可见）", () => {
  assert.equal(fn.classifyEvent({ type: "warning", message: " something off", createdAt: "2026-10-01T08:00:00Z" }), "attention");
  assert.equal(
    fn.classifyEvent({ type: "system", message: "服务重启时本轮处于 streaming 状态：执行被中断，结果未知。", createdAt: "2026-10-01T08:00:00Z" }),
    "attention"
  );
  assert.equal(
    fn.classifyEvent({ type: "system", message: "已超过建议等待时间（300000ms），仍未确认执行结束。", createdAt: "2026-10-01T08:00:00Z" }),
    "attention"
  );
});

test("trayLabel：收起一目了然、可展开", () => {
  assert.equal(fn.trayLabel(3, false), "过程 · 3 条");
  assert.equal(fn.trayLabel(3, true), "收起过程 · 3 条");
});

test("relTime：相对时间各档", () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(fn.relTime(iso(20 * 1000)), "刚刚");
  assert.equal(fn.relTime(iso(5 * 60 * 1000)), "5 分钟前");
  assert.equal(fn.relTime(iso(3 * 60 * 60 * 1000)), "3 小时前");
  assert.equal(fn.relTime(iso(3 * 24 * 60 * 60 * 1000)), "3 天前");
  const old = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const label = fn.relTime(old.toISOString());
  assert.match(label, /^\d{1,2}-\d{1,2}$/);
  assert.equal(fn.relTime(null), "");
  assert.equal(fn.relTime("not-a-date"), "");
});

test("makeRemindLedger：同一 key 只提醒一次（断线重连重放不重复）", () => {
  const ledger = fn.makeRemindLedger();
  assert.equal(ledger.take("q|turn1|选哪个"), true);
  assert.equal(ledger.take("q|turn1|选哪个"), false); // 同一次提问重放：不再响
  assert.equal(ledger.take("e|turn1|succeeded"), true);
  assert.equal(ledger.take("e|turn1|failed"), true); // 同一轮不同终态仍各自提醒
  assert.equal(ledger.size(), 3);
});

test("detectRemindCapabilities：无 WebAudio/无振动/无通知 API 时逐项降级", () => {
  // 沙箱：window 无 AudioContext、无 navigator、无 Notification
  const caps = fn.detectRemindCapabilities();
  assert.equal(caps.sound, false);
  assert.equal(caps.vibrate, false);
  assert.equal(caps.notif, "unavailable");
  assert.equal(caps.secure, true); // 沙箱桩默认安全上下文
});

test("detectRemindCapabilities：有 WebAudio 与振动时如实识别（挂在 window 上）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = sandbox as any;
  const restore: Array<() => void> = [];
  w.window.AudioContext = function AudioContext() {};
  restore.push(() => { delete w.window.AudioContext; });
  w.navigator = { vibrate: () => true };
  restore.push(() => { delete w.navigator; });
  try {
    const caps = fn.detectRemindCapabilities();
    assert.equal(caps.sound, true);
    assert.equal(caps.vibrate, true);
    assert.equal(caps.notif, "unavailable"); // 仍无 Notification API
  } finally {
    restore.forEach((r) => r());
  }
});

test("remindStatusText：各项能力的如实文案", () => {
  assert.equal(
    fn.remindStatusText({ sound: true, vibrate: true, notif: "granted", secure: true }),
    "提醒能力：声音 ✓ · 振动 ✓ · 系统通知 ✓"
  );
  assert.equal(
    fn.remindStatusText({ sound: true, vibrate: false, notif: "unavailable", secure: false }),
    "提醒能力：声音 ✓ · 振动 ✗（设备/浏览器不支持） · 系统通知 ✗（要在锁屏弹通知需要加密连接 HTTPS，当前只在打开的页面里提醒）"
  );
  assert.equal(
    fn.remindStatusText({ sound: false, vibrate: false, notif: "denied", secure: true }),
    "提醒能力：声音 ✗（浏览器不支持 WebAudio） · 振动 ✗（设备/浏览器不支持） · 系统通知 ✗（权限被拒）"
  );
});
