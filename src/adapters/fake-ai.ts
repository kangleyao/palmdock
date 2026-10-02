// 适配器：假 AI（第二层演示端）。
// 端形态：纯本地 Node 脚本 fake-ai/agent.js（不联网、无密钥、行为固定）。
// 该适配器只做协议翻译：把底座的“流式输出 + 提问等待”协议映射为脚本的 stdio JSON 行。
// 声明全部四种会话能力，供公共页面渲染会话入口；一次性任务（第一层）显式拒绝。
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type {
  AdapterCapabilities,
  JsonValue,
  SessionAdapter,
  TaskError,
  TurnContext,
  TurnRequest,
  TurnResult,
} from "../types";
import { fieldsFor } from "../schema-fields";

/** 假 AI 脚本位置：项目根 fake-ai/agent.js。从适配器目录向上找到 package.json 所在根，兼容 src/ 与 dist/ 布局。 */
function agentScriptPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return path.join(dir, "fake-ai", "agent.js");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(__dirname, "..", "..", "..", "fake-ai", "agent.js");
}

const FULL_CAPABILITIES: AdapterCapabilities = {
  sessions: true,
  listSessions: true,
  streaming: true,
  askUser: true,
};

/** 会话期输入 = 一条消息（非空、有界），由会话 API 校验；这里提供契约与表单描述。 */
const inputSchema = z.object({
  message: z
    .string()
    .min(1)
    .max(2000)
    .describe("发给假 AI 的消息")
    .meta({ multiline: true, placeholder: "随便说点什么…", help: "假 AI 会分段回复，并提一个二选一的问题" }),
});

interface AgentLine {
  type: "output" | "ask" | "done" | "fatal";
  text?: string;
  prompt?: string;
  options?: string[];
  result?: unknown;
  message?: string;
}

function parseLine(line: string): AgentLine | null {
  try {
    const msg = JSON.parse(line) as AgentLine;
    if (msg && typeof msg.type === "string") return msg;
  } catch {
    // 非 JSON 行（脚本不可能产生；忽略）
  }
  return null;
}

function fail(message: string, stage: string, detail?: string): TurnResult {
  const error: TaskError = { message, stage };
  if (detail !== undefined) error.detail = detail;
  return { ok: false, error };
}

function runTurn(req: TurnRequest, ctx: TurnContext): Promise<TurnResult> {
  const script = agentScriptPath();
  if (!fs.existsSync(script)) {
    return Promise.resolve(fail(`假 AI 脚本缺失：${script}`, "endpoint.missing"));
  }
  // 已被关闭信号中止（服务正在退出）：不再启动新进程
  if (ctx.signal.aborted) {
    return Promise.resolve(fail("轮次在启动前已被关闭信号中止", "turn.aborted"));
  }

  return new Promise<TurnResult>((resolve) => {
    const child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // unref + 关闭信号双保险：服务退出时立即杀掉脚本进程，不拽住事件循环。
    child.unref();
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // 忽略二次 kill
      }
    };
    ctx.signal.addEventListener("abort", onAbort);

    let buffer = "";
    let settled = false;
    let stdoutText = "";
    let stderrText = "";

    const settle = (outcome: TurnResult): void => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);
      try {
        child.kill();
      } catch {
        // 忽略二次 kill
      }
      resolve(outcome);
    };

    child.on("error", (e) => settle(fail(`启动假 AI 失败：${e.message}`, "endpoint.spawn")));

    child.on("exit", (code, signal) => {
      // 正常退出（done 已处理）时 settled=true；否则按失败处理并保留证据。
      if (!settled) {
        settle(
          fail(
            `假 AI 进程提前退出（code=${code} signal=${signal}）`,
            "endpoint.exit",
            (stdoutText + (stderrText ? `\n[stderr]\n${stderrText}` : "")).slice(0, 500)
          )
        );
      }
    });

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        stdoutText += line + "\n";
        const msg = parseLine(line);
        if (!msg) continue;
        if (msg.type === "output" && typeof msg.text === "string") {
          ctx.emit({ type: "info", message: msg.text });
        } else if (msg.type === "ask" && typeof msg.prompt === "string" && Array.isArray(msg.options)) {
          // 把提问交给公共协议：轮次进入 awaiting_answer，手机回答后在此恢复。
          void ctx.ask(msg.prompt, msg.options).then(
            (answer) => {
              try {
                child.stdin?.write(JSON.stringify({ type: "answer", answer }) + "\n");
              } catch (e) {
                settle(fail(`回写回答失败：${e instanceof Error ? e.message : String(e)}`, "endpoint.write"));
              }
            },
            (e: unknown) => {
              settle(
                fail(
                  `提问被拒绝或中断：${e instanceof Error ? e.message : String(e)}`,
                  "turn.ask",
                  stderrText.slice(0, 500)
                )
              );
            }
          );
        } else if (msg.type === "done") {
          settle({ ok: true, result: (msg.result ?? null) as JsonValue });
        } else if (msg.type === "fatal") {
          settle(fail(`假 AI 协议失败：${msg.message ?? "未知原因"}`, "endpoint.fatal", stdoutText.slice(0, 500)));
        }
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      // 脚本不应输出 stderr；若有，留作失败证据（不展示给用户）。
      stderrText += chunk;
    });

  ctx.emit({ type: "info", message: `演示助手已启动（本地运行，第 ${req.history.length + 1} 轮）` });

    // 启动协议：写入 start 行（消息 + 轮序）
    try {
      child.stdin?.write(
        JSON.stringify({ type: "start", message: req.message, turnIndex: req.history.length }) + "\n"
      );
    } catch (e) {
      settle(fail(`写入启动消息失败：${e instanceof Error ? e.message : String(e)}`, "endpoint.write"));
    }
  });
}

/** 第一层一次性任务入口：本工具是会话形态，显式拒绝（公共 API 也会先拦截）。 */
function run(): Promise<TurnResult> {
  return Promise.resolve(
    fail("本工具为会话形态（session），不支持一次性任务提交；请通过会话页发送消息。", "mode")
  );
}

/**
 * 不提供契约 examples：作为端依赖外部脚本文件（fake-ai/agent.js），
 * 契约测试不注入端依赖；联通性以“真实提交一次会话任务”验证（见 docs/ADAPTATION-WORKFLOW.md）。
 */
export const fakeAiAdapter: SessionAdapter = {
  manifest: {
    id: "fake-ai",
    name: "演示助手",
    description: "体验完整会话流程的演示端：分段输出、向你提问、按回答生成结果（纯本地运行，不联网、无密钥）",
    mode: "session",
    capabilities: FULL_CAPABILITIES,
    inputSchema,
    fields: fieldsFor(inputSchema),
  },
  run,
  runTurn,
};
