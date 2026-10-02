// 测试公共工具：临时数据目录 + 真实 Express 服务（端口 0，浏览器不可达，仅本进程访问）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { Express } from "express";
import { Store } from "../src/store";
import { TaskRunner } from "../src/runner";
import * as registry from "../src/registry";
import { SessionRunner } from "../src/session-runner";
import { TurnBus } from "../src/turn-bus";
import { SessionStreamHub } from "../src/session-stream";

import { createApp } from "../src/server";
import { DEFAULT_LIMITS, Limits } from "../src/types";

import type { Adapter } from "../src/types";

export interface TestEnv {
  store: Store;
  runner: TaskRunner;
  app: Express;
  server: http.Server;
  baseUrl: string;
  token: string;
  limits: Limits;
  close(): Promise<void>;
}

export function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "palmdock-"));
}

export function testLimits(overrides?: Partial<Limits>): Limits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/** 启动真实 HTTP 服务（回环 + 临时端口 + 临时数据目录）。getAdapter 可注入伪适配器。 */
export async function startTestEnv(opts?: {
  token?: string;
  limits?: Partial<Limits>;
  getAdapter?: (toolId: string) => Adapter | undefined;
}): Promise<TestEnv> {
  const token = opts?.token ?? "test-token-0123456789abcdef";
  const dbPath = path.join(tempDataDir(), "base.db");
  // 与生产装配一致：总线让持久层的轮次提交即时通知 SSE 中心（第二层推流）
  const turnBus = new TurnBus();
  const store = new Store(dbPath, {
    maxTasks: opts?.limits?.maxTasks ?? DEFAULT_LIMITS.maxTasks,
    maxEventsPerTask: opts?.limits?.maxEventsPerTask ?? DEFAULT_LIMITS.maxEventsPerTask,
    maxEventMessageChars: opts?.limits?.maxEventMessageChars ?? DEFAULT_LIMITS.maxEventMessageChars,
    onTurnChange: (change) => turnBus.emit(change),
  });
  const limits = testLimits(opts?.limits);
  const runner = new TaskRunner({
    store,
    getAdapter: opts?.getAdapter ?? registry.getAdapter,
    limits,
  });
  const sessionRunner = new SessionRunner({
    store,
    getSessionAdapter: registry.getSessionAdapter,
    limits,
  });
  const turnHub = new SessionStreamHub(store, turnBus);
  const app = createApp({ store, onTaskCreated: (id) => runner.enqueue(id), sessionRunner, turnHub, limits, token });


  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        store,
        runner,
        app,
        server,
        token,
        limits,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: async () => {
          // 先关闭推流连接，否则挂起的 SSE 会让 server.close() 无法返回
          turnHub.closeAll();
          sessionRunner.dispose();


          await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
          store.close();
          fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
        },
      });
    });
  });
}

/** 轮询断言：等条件成立或超时（回调可为 async）。 */
export async function waitFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 15000, intervalMs = 50): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

export async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    // 保持原始文本
  }
  return { status: res.status, body };
}

export function authed(env: TestEnv, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${env.token}`, ...extra };
}

/** 提交一个任务（返回状态与响应体）。 */
export async function submitTask(
  env: TestEnv,
  body: { toolId: string; input: Record<string, unknown>; idempotencyKey?: string }
): Promise<{ status: number; body: unknown }> {
  return fetchJson(`${env.baseUrl}/api/tasks`, {
    method: "POST",
    headers: authed(env),
    body: JSON.stringify({ toolId: body.toolId, idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(), input: body.input }),
  });
}

export async function getTask(env: TestEnv, id: string, sinceSeq?: number): Promise<{ status: number; body: unknown }> {
  const q = sinceSeq === undefined ? "" : `?sinceSeq=${sinceSeq}`;
  return fetchJson(`${env.baseUrl}/api/tasks/${id}${q}`, { headers: authed(env) });
}
