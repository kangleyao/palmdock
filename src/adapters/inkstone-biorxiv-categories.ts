// 适配器：书生·端砚（Inkstone）科研 MCP 工具调用——bioRxiv 公开学科类目。
// 这是 inkstone 接入从"列工具"推进到"调用一个明确只读工具"的最小可控一步：
//   - server 与 tool 名均为代码常量，输入只有一个可选的条数上限，
//     不构成"任意工具名 + 任意参数"的通用执行入口；
//   - 调用参数固定为空对象（get_categories 本身无参数），不接受任何用户文本注入；
//   - 调用前在同一会话内校验：工具存在、readOnlyHint=true、无必填参数，
//     任一不满足即中止调用（防上游版本漂移）；
//   - 调用为只读查询（bioRxiv 公开学科分类元数据），不上传用户文件/数据/凭据，无写入与费用；
//   - 上游返回 HTTP 错误页等非约定负载时按 ok:false 上报，不猜测补齐。
// 共享会话实现（路径解析、JSON-RPC 对话、子进程生命周期管控）见 ./inkstone-mcp-stdio。
import { z } from "zod";
import type { Adapter, AdapterRunResult, AdapterContext, JsonValue } from "../types";
import { fieldsFor } from "../schema-fields";
import { mcpSession, type McpToolMeta } from "./inkstone-mcp-stdio";

/** 固定调用目标：端砚 catalog 中的 mcp_biorxiv 服务器 get_categories 工具。 */
const SERVER = "mcp_biorxiv";
const TOOL = "get_categories";

/** 调用前校验失败专用错误，用于把失败归因到 tool.check 阶段。 */
class ToolCheckError extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
    this.name = "ToolCheckError";
  }
}

const inputSchema = z.object({
  maxCategories: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe("返回类目条数上限（可选）")
    .meta({ help: "bioRxiv 公开学科类目约 27 条；留空返回全部（上限 30 条）" }),
});

/** 同一会话内、tools/list 之后 tools/call 之前的调用前校验。 */
function checkTool(tools: McpToolMeta[]): Error | null {
  const tool = tools.find((t) => t.name === TOOL);
  if (!tool) {
    return new ToolCheckError(
      `服务器 ${SERVER} 的工具清单中不存在 ${TOOL}（上游可能已更新，拒绝盲调用）`,
      `tools=${tools.map((t) => t.name).join(",")}`
    );
  }
  if (tool.readOnly !== true) {
    return new ToolCheckError(
      `工具 ${TOOL} 未被标记为只读（readOnlyHint=${tool.readOnly}），按安全策略拒绝调用`
    );
  }
  const schema = tool.inputSchema as { required?: unknown; properties?: Record<string, unknown> } | null;
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]) : [];
  if (required.length > 0) {
    return new ToolCheckError(
      `工具 ${TOOL} 声明了必填参数 ${required.join(",")}（预期无参数），拒绝调用`,
      JSON.stringify(schema)
    );
  }
  return null;
}

/** 防御性规范化上游类目条目：只保留含字符串 name 的条目。 */
function normalizeCategory(entry: unknown): { name: string; api_format?: string; description?: string } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as { name?: unknown; api_format?: unknown; description?: unknown };
  if (typeof e.name !== "string") return null;
  return {
    name: e.name,
    ...(typeof e.api_format === "string" ? { api_format: e.api_format } : {}),
    ...(typeof e.description === "string" ? { description: e.description } : {}),
  };
}

async function run(input: unknown, ctx: AdapterContext): Promise<AdapterRunResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        message: "输入不合法（maxCategories 可选，须为 1..30 的整数）",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        stage: "input.validate",
      },
    };
  }
  const maxCategories = parsed.data.maxCategories ?? 30;

  const startedAt = Date.now();
  try {
    ctx.emit({ type: "info", message: `定位 ${SERVER} 并准备调用 ${TOOL}（空参数）` });
    const session = await mcpSession({
      server: SERVER,
      call: { name: TOOL, arguments: {} },
      preCall: (tools) => checkTool(tools),
      emit: (m) => ctx.emit({ type: "info", message: m }),
    });

    const call = session.call;
    if (!call) {
      return {
        ok: false,
        error: { message: "会话未发生工具调用（内部错误）", stage: "tool.result" },
      };
    }

    const text = call.content.map((c) => c.text ?? "").join("\n").trim();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // 上游协议成功但负载不是约定 JSON（例如 "Error: HTTP 403 ..." 错误页文本）
      return {
        ok: false,
        error: {
          message: `${TOOL} 上游返回非约定 JSON 负载（可能是外部服务错误页），原始文本前 200 字符：${text.slice(0, 200)}`,
          stage: "tool.result",
          detail: `isError=${call.isError} bytes=${Buffer.byteLength(text, "utf8")}`,
        },
      };
    }
    const p = payload as { success?: unknown; categories?: unknown };
    if (p.success !== true || !Array.isArray(p.categories)) {
      return {
        ok: false,
        error: {
          message: `${TOOL} 上游返回缺少 success:true / categories 数组`,
          stage: "tool.result",
          detail: text.slice(0, 200),
        },
      };
    }

    const all = p.categories.map(normalizeCategory).filter((c): c is NonNullable<typeof c> => c !== null);
    const total = all.length;
    const kept = all.slice(0, maxCategories);
    const result: JsonValue = {
      server: SERVER,
      serverInfo: session.serverInfo,
      tool: TOOL,
      isError: call.isError,
      durationMs: Date.now() - startedAt,
      rawBytes: Buffer.byteLength(text, "utf8"),
      totalCategories: total,
      categories: kept,
      returnedCategories: kept.length,
      truncated: total > kept.length,
      note: "只读调用 bioRxiv 公开学科类目元数据（get_categories，空参数）；不上传用户数据、无账号、无写入副作用",
    };
    ctx.emit({ type: "info", message: `获得 ${total} 条类目，返回 ${kept.length} 条` });
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        stage: e instanceof ToolCheckError ? "tool.check" : "mcp.call",
        detail:
          e instanceof ToolCheckError
            ? e.detail
            : e instanceof Error && e.stack
              ? e.stack.split("\n").slice(0, 4).join("\n")
              : undefined,
      },
    };
  }
}

/**
 * 不提供契约 examples：本适配器依赖外部安装（端砚 + 密封 Python）与外部只读服务，
 * 自动测试不注入外部依赖；联通性以"真实提交一次任务"验证（见 docs/ADAPTATION-WORKFLOW.md）。
 */
export const inkstoneBiorxivCategoriesAdapter: Adapter = {
  manifest: {
    id: "inkstone-biorxiv-categories",
    name: "端砚科研 MCP 调用：bioRxiv 类目",
    description: "调用书生·端砚 mcp_biorxiv 的 get_categories 工具，列出 bioRxiv 公开学科类目（只读、无参数）",
    timeoutMs: 60_000,
    inputSchema,
    fields: fieldsFor(inputSchema),
  },
  run,
};
