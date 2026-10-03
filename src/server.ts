// Express 应用装配：安全头 + API + 静态公共页面。
import express from "express";
import * as path from "node:path";
import { createApiRouter } from "./api";
import { createSessionRouter } from "./session-api";
import type { SessionRunner } from "./session-runner";
import type { SessionStreamHub } from "./session-stream";
import type { Store } from "./store";
import type { Limits } from "./types";
import type { Registry } from "./registry";

export interface ServerDeps {
  store: Store;
  onTaskCreated: (taskId: string) => void;
  sessionRunner: SessionRunner;
  /** 会话 SSE 推流中心：由装配层（index/tests）创建并传入；服务关闭时需 closeAll。 */
  turnHub?: SessionStreamHub;
  limits: Limits;
  token: string;
  /** 静态页面目录；默认为项目 public/。 */
  publicDir?: string;
  /** 适配器注册表视图：默认为产品端清单（defaultRegistry）；测试可注入含测试替身的注册表。 */
  registry?: Registry;
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // 只允许同源脚本与样式；工具输出一律走 textContent，不经 innerHTML。
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'"
    );
    next();
  });
  // 顺序很重要：任务路由先挂（/api/health 免鉴权在它的路由级处理），
  // 会话路由后挂；二者路径不重叠，健康检查不被会话鉴权拦截。
  app.use("/api", createApiRouter({ store: deps.store, onTaskCreated: deps.onTaskCreated, limits: deps.limits, token: deps.token, registry: deps.registry }));

  app.use(
    "/api",
    createSessionRouter({
      store: deps.store,
      sessionRunner: deps.sessionRunner,
      limits: deps.limits,
      token: deps.token,
      hub: deps.turnHub,
      registry: deps.registry,
    })
  );

  const publicDir = deps.publicDir ?? path.resolve(__dirname, "..", "..", "public");
  app.use(express.static(publicDir, { extensions: ["html"] }));

  // 兜底：非 /api 的未知路径回首页（单页式多页面的简单回退）。
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // 统一错误处理：不输出任何凭证或用户输入。
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // express.json() 解析失败带 status=400：属客户端错误，归类为 INVALID_INPUT 而非 INTERNAL，
    // 且绝不因此打垮进程（后续请求照常服务）。
    const status =
      err && typeof err === "object" && ("status" in err || "statusCode" in err)
        ? Number((err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode)
        : undefined;
    if (status !== undefined && Number.isFinite(status) && status >= 400 && status < 500) {
      loggerSafeError(err);
      res.status(status).json({ error: "INVALID_INPUT", message: "请求体不合法或不是有效 JSON" });
      return;
    }
    loggerSafeError(err);
    res.status(500).json({ error: "INTERNAL", message: "内部错误" });
  });

  return app;
}

function loggerSafeError(err: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { logger } = require("./logger");
  logger.error(`未处理异常：${err instanceof Error ? err.message : String(err)}`);
}
