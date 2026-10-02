// 固定 token 鉴权中间件。token 走 Authorization 头（不出现在 URL/日志），
// 用 sha256 + timingSafeEqual 比较，避免时序泄漏。
import * as crypto from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "./logger";

export function bearerAuth(token: string): RequestHandler {
  const expectedDigest = crypto.createHash("sha256").update(token, "utf8").digest();
  return (req, res, next) => {
    const header = req.headers.authorization;
    const denied = (reason: string): void => {
      // 只记录“被拒”这一事实与客户端类别，不记录任何凭证内容。
      logger.warn(`鉴权拒绝 ${req.method} ${req.path}：${reason}`);
      res.status(401).json({ error: "UNAUTHORIZED", message: "缺少或无效的访问 token（需要 Authorization: Bearer <token>）" });
    };
    if (!header || typeof header !== "string") {
      denied("缺少 Authorization 头");
      return;
    }
    if (!header.startsWith("Bearer ")) {
      denied("Authorization 头格式错误");
      return;
    }
    const got = header.slice("Bearer ".length);
    const gotDigest = crypto.createHash("sha256").update(got, "utf8").digest();
    if (gotDigest.length !== expectedDigest.length || !crypto.timingSafeEqual(gotDigest, expectedDigest)) {
      denied("token 不匹配");
      return;
    }
    next();
  };
}
