// 服务入口：加载配置 → 打开持久层 → 重启恢复 → 启动 HTTP 服务。
// 默认仅监听 127.0.0.1（最小网络暴露）；lan 模式显式绑 0.0.0.0 并告警。
import * as http from "node:http";
import { bindHost, loadConfig, resolveDbPath, ConfigError } from "./config";
import { logger } from "./logger";
import { Store } from "./store";
import { TaskRunner, recoverInterruptedTasks } from "./runner";
import { SessionRunner, recoverInterruptedTurns } from "./session-runner";
import { TurnBus } from "./turn-bus";
import { SessionStreamHub } from "./session-stream";

import * as registry from "./registry";
import { createApp } from "./server";
import { DEFAULT_LIMITS } from "./types";

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }

  const problems = registry.validateManifestFields();
  if (problems.length > 0) {
    fail("适配器清单自检失败：\n" + problems.map((p) => " - " + p).join("\n"));
  }

  // 第二层推流装配：总线连接持久层（提交即通知）与 SSE 中心（通知即推送）；
  // 作用域为本服务实例，不跨进程。
  const turnBus = new TurnBus();
  const store = new Store(resolveDbPath(config.dataDir), {
    maxTasks: config.maxTasks,
    maxEventsPerTask: DEFAULT_LIMITS.maxEventsPerTask,
    maxEventMessageChars: DEFAULT_LIMITS.maxEventMessageChars,
    onTurnChange: (change) => turnBus.emit(change),
  });
  const turnHub = new SessionStreamHub(store, turnBus);

  recoverInterruptedTasks(store);

  recoverInterruptedTurns(store);

  const sessionRunner = new SessionRunner({
    store,
    getSessionAdapter: registry.getSessionAdapter,
    limits: { ...DEFAULT_LIMITS, maxConcurrent: config.maxConcurrent },
  });

  const runner = new TaskRunner({
    store,
    getAdapter: registry.getAdapter,
    limits: { ...DEFAULT_LIMITS, maxConcurrent: config.maxConcurrent },
  });

  const app = createApp({
    store,
    onTaskCreated: (taskId) => runner.enqueue(taskId),
    limits: { ...DEFAULT_LIMITS, maxConcurrent: config.maxConcurrent },
    sessionRunner,
    turnHub,
    token: config.token,
  });

  const host = bindHost(config.bind);
  const server = http.createServer(app);
  server.listen(config.port, host, () => {
    logger.info(`服务已启动：http://${host}:${config.port}`);
    if (config.bind === "lan") {
      logger.warn("bind=lan：服务监听 0.0.0.0，同局域网设备可访问；请确认网络可信，并确保 token 已安全分发。");
    } else {
      logger.info("bind=loopback：仅本机可访问。手机测试请在 config.json 设置 bind=lan（同 Wi-Fi）或参见 docs/CLOUDFLARE-TUNNEL.md（跨网）。");
    }
  });

  const shutdown = (signal: string): void => {
    logger.info(`收到 ${signal}，正在关闭…`);
    // 先终止在途会话的端资源（子进程等）与推流连接，避免关闭时被拽住事件循环
    turnHub.closeAll();
    sessionRunner.dispose();

    server.close(() => {
      try {
        store.close();
      } catch (e) {
        logger.error(`关闭持久层失败：${String(e)}`);
      }
      process.exit(0);
    });
    // 兜底：5 秒内未优雅退出则强制退出。
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // 进程级兜底：未捕获异常/未处理拒绝先写明日志再优雅关闭，避免“无日志静默退出”。
  // 注意：被外部强杀（命令会话树终止/任务管理器）时进程无法记录自身——那是启动机制问题，
 // 请用 scripts/serve.ps1（WMI 启动，脱离命令会话树）保证常驻。
  process.on("uncaughtException", (e) => {
    logger.error(`未捕获异常（写日志后优雅退出）：${e instanceof Error ? e.stack || e.message : String(e)}`);
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`未处理的 Promise 拒绝（写日志后优雅退出）：${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
    shutdown("unhandledRejection");
  });
  process.on("exit", (code) => {
    logger.info(`进程退出，exit=${code}`);
  });
}

main();
