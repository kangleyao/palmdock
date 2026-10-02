// 端砚 MCP stdio 会话公共设施：两个 inkstone 适配器共用的路径解析、JSON-RPC 对话与子进程管控。
// 入口性质：目标自带的 stdio MCP（resources\science-mcp\run_server.py），
//   由目标自带密封 Python（resources\science-pack\python\python.exe）运行。
// 安全要点：
//   - 子进程生命周期全程管控：完成或超时立即 kill，不留孤儿进程；
//   - -I -B 隔离模式，避免在目标安装目录生成 pyc 缓存（不修改端砚安装文件）；
//   - 外部安装路径经环境变量注入（INKSTONE_HOME，必须由环境变量指定）。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 目标安装根。必须由环境变量 INKSTONE_HOME 指定（例：set INKSTONE_HOME=D:\path\to\inkstone）。 */
export function inkstoneHome(): string {
  const home = process.env.INKSTONE_HOME;
  if (!home) {
    throw new Error("未设置 INKSTONE_HOME：请指向端砚安装根目录（例：set INKSTONE_HOME=D:\\path\\to\\inkstone）");
  }
  return home;
}

/** 解析并校验 MCP 相关路径；缺失立即抛错（适配器映射为 ok:false）。 */
export interface InkstonePaths {
  mcpRoot: string;
  pythonExe: string;
  runner: string;
  catalogPath: string;
}

export function resolveInkstonePaths(): InkstonePaths {
  const home = inkstoneHome();
  const mcpRoot = path.join(home, "resources", "science-mcp");
  const pythonExe = path.join(home, "resources", "science-pack", "python", "python.exe");
  const runner = path.join(mcpRoot, "run_server.py");
  const catalogPath = path.join(mcpRoot, "catalog.json");
  for (const p of [runner, pythonExe]) {
    if (!fs.existsSync(p)) {
      throw new Error(`端砚安装路径缺失：${p}（可用 INKSTONE_HOME 环境变量指定安装根）`);
    }
  }
  return { mcpRoot, pythonExe, runner, catalogPath };
}

/** 读取 catalog.json 并返回全部 server 名（供运行时校验枚举快照）。 */
export function readCatalogServers(catalogPath: string): string[] {
  const catalog: unknown = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
  return (Array.isArray(catalog) ? (catalog as Array<{ server?: unknown }>) : [])
    .map((item) => item?.server)
    .filter((s): s is string => typeof s === "string");
}

export interface McpToolMeta {
  name: string;
  readOnly: boolean | null;
  description: string | null;
  /** 工具的输入 schema（JSON Schema 形态），供调用前校验。 */
  inputSchema: unknown;
}

export interface McpCallResult {
  isError: boolean;
  error?: { code?: number; message?: string };
  content: Array<{ type: string; text?: string }>;
}

export interface McpSessionResult {
  server: string;
  serverInfo: { name?: string; version?: string };
  tools: McpToolMeta[];
  /** 仅当请求了 call 时存在。 */
  call?: McpCallResult;
}

export interface McpSessionOptions {
  server: string;
  /** tools/call 请求；arguments 由调用方构造，会话本身不提供任意参数入口。 */
  call?: { name: string; arguments: Record<string, unknown> };
  /**
   * 在 tools/list 之后、tools/call 之前执行（同一会话内真正的调用前校验）。
   * 返回 Error 则中止调用并以此错误结束会话（用于只读标记/必填参数前置校验）。
   */
  preCall?: (tools: McpToolMeta[]) => Error | null;
  /** 会话整体超时（默认 30 秒）。 */
  timeoutMs?: number;
  emit?: (message: string) => void;
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 与一台 MCP 服务器完成一次 initialize → tools/list → [tools/call] 对话；全程管控子进程。 */
export function mcpSession(opts: McpSessionOptions): Promise<McpSessionResult> {
  return new Promise((resolve, reject) => {
    const { pythonExe, runner } = resolveInkstonePaths();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const emit = opts.emit ?? (() => {});

    const child = spawn(pythonExe, ["-I", "-B", runner, opts.server], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let buffer = "";
    const responses = new Map<number, RpcResponse>();
    let settled = false;

    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // 忽略二次 kill
      }
      if (err) reject(err);
      else resolve(value as never);
    };


    const timer = setTimeout(() => {
      finish(new Error(`MCP 对话超时（${timeoutMs}ms 内未完成：server=${opts.server}）`));
    }, timeoutMs);
    child.on("error", (e) => finish(new Error(`启动密封 Python 失败：${e.message}`)));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(`MCP 服务器进程提前退出（code=${code} signal=${signal}），可能是 server 名无效或运行时损坏`)
        );
      }
    });

    const send = (m: unknown): void => {
      child.stdin.write(JSON.stringify(m) + "\n");
    };

    const tryComplete = (): void => {
      // 阶段 1：initialize + tools/list 都已收齐
      if (responses.has(1) && responses.has(2) && !sessionParsed) {
        sessionParsed = true;
        const init = responses.get(1)!;
        const list = responses.get(2)!;
        if (init.error) return finish(new Error(`initialize 失败：${init.error.message ?? JSON.stringify(init.error)}`));
        if (list.error) return finish(new Error(`tools/list 失败：${list.error.message ?? JSON.stringify(list.error)}`));
        const toolsRaw = (list.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? [];
        const info = ((init.result as { serverInfo?: Record<string, unknown> } | undefined)?.serverInfo ?? {}) as {
          name?: string;
          version?: string;
        };
        tools = toolsRaw.map((t) => {
          const desc = typeof t.description === "string" ? t.description.trim() : null;
          return {
            name: String(t.name ?? "?"),
            readOnly: (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint ?? null,
            description: desc ? (desc.length > 300 ? desc.slice(0, 300) + "…[已截断]" : desc) : null,
            inputSchema: t.inputSchema ?? null,
          };
        });
        serverInfo = info;
        emit(`收到 ${tools.length} 个工具元数据`);
        // 阶段 2：调用前校验（如有）
        if (opts.preCall) {
          const abort = opts.preCall(tools);
          if (abort) return finish(abort);
        }
        // 阶段 3：发起 tools/call（如有）
        if (opts.call) {
          emit(`调用工具：${opts.call.name}（参数键：${Object.keys(opts.call.arguments).join(",") || "（空）"}）`);
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: opts.call.name, arguments: opts.call.arguments } });
          return;
        }
        return finish(null, { server: opts.server, serverInfo, tools });
      }
      // 阶段 4：tools/call 响应收齐
      if (sessionParsed && opts.call && responses.has(3)) {
        const callResp = responses.get(3)!;
        if (callResp.error) {
          return finish(
            new Error(`tools/call 失败：${callResp.error.message ?? JSON.stringify(callResp.error)}`)
          );
        }
        const cr = callResp.result as
          | { isError?: boolean; content?: Array<Record<string, unknown>> }
          | undefined;
        const call: McpCallResult = {
          isError: !!cr?.isError,
          content: (cr?.content ?? []).map((c) => ({
            type: typeof c.type === "string" ? c.type : "?",
            text: typeof c.text === "string" ? c.text : undefined,
          })),
        };
        emit(`工具调用返回（isError=${call.isError}，内容块 ${call.content.length} 个）`);
        finish(null, { server: opts.server, serverInfo, tools, call });
      }
    };

    let tools: McpToolMeta[] = [];
    let serverInfo: { name?: string; version?: string } = {};
    let sessionParsed = false;

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as RpcResponse;
          if (typeof msg.id === "number") {
            responses.set(msg.id, msg);
            tryComplete();
          }
        } catch {
          // 非 JSON 行忽略（服务器可能输出其他日志）
        }
      }
    });

    emit(`启动密封 Python 并运行 run_server.py ${opts.server}`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "palmdock", version: "0.1.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}
