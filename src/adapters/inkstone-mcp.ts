// 适配器：书生·端砚（Inkstone）科研 MCP 只读元数据。
// 入口性质：目标自带的 stdio MCP（resources\science-mcp\run_server.py），
//   由目标自带密封 Python（resources\science-pack\python\python.exe）运行。
// 本适配器只做 tools/list 级别的元数据调用，不执行任何科研工具（零工具调用）。
// 共享会话实现（路径解析、JSON-RPC 对话、子进程生命周期管控）见 ./inkstone-mcp-stdio。
import { z } from "zod";
import type { Adapter, AdapterRunResult, AdapterContext, JsonValue } from "../types";
import { fieldsFor } from "../schema-fields";
import { mcpSession, readCatalogServers, resolveInkstonePaths } from "./inkstone-mcp-stdio";

/** catalog.json 中 server 名的静态快照（供表单枚举）；运行时再对 catalog 动态校验，防快照过期。 */
const CATALOG_SERVERS = [
  "mcp_biomart",
  "mcp_biorxiv",
  "mcp_cancer_models",
  "mcp_cellguide",
  "mcp_chembl",
  "mcp_chemistry",
  "mcp_clinical_genomics",
  "mcp_clinical_trials",
  "mcp_drug_regulatory",
  "mcp_expression",
  "mcp_genes_ontologies",
  "mcp_genomes",
  "mcp_human_genetics",
  "mcp_literature",
  "mcp_omics_archives",
  "mcp_protein_annotation",
  "mcp_pubmed",
  "mcp_regulation",
  "mcp_research_resources",
  "mcp_rna",
  "mcp_structures_interactions",
  "mcp_variants",
  "mcp_zinc",
] as const;

const inputSchema = z.object({
  server: z
    .enum(CATALOG_SERVERS)
    .describe("端砚科研 MCP 服务器（快照自 catalog.json）")
    .meta({ help: "23 个内置科研数据服务器之一，枚举为安装时快照" }),
});

async function run(input: unknown, ctx: AdapterContext): Promise<AdapterRunResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        message: "输入不合法（server 必填，且须为 catalog.json 快照中的枚举值）",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        stage: "input.validate",
      },
    };
  }
  const { server } = parsed.data;

  // 运行时对 catalog 二次校验（枚举是静态快照，防目录更新漂移）
  let servers: string[];
  try {
    servers = readCatalogServers(resolveInkstonePaths().catalogPath);
  } catch (e) {
    return {
      ok: false,
      error: {
        message: `读取端砚 catalog.json 失败：${e instanceof Error ? e.message : String(e)}`,
        stage: "catalog.read",
      },
    };
  }
  if (!servers.includes(server)) {
    return {
      ok: false,
      error: {
        message: `server ${server} 不在当前 catalog.json 中（枚举快照可能已过期，请核对 catalog 后更新适配器枚举）`,
        stage: "catalog.validate",
        detail: `catalog servers=${servers.length}`,
      },
    };
  }

  try {
    const { serverInfo, tools } = await mcpSession({
      server,
      emit: (m) => ctx.emit({ type: "info", message: m }),
    });
    const result: JsonValue = {
      server,
      serverInfo,
      toolCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, readOnly: t.readOnly, description: t.description })),
      note: "只读元数据级别（tools/list），未调用任何工具",
    };
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        stage: "mcp.list",
        detail: e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : undefined,
      },
    };
  }
}

/**
 * 不提供契约 examples：本适配器依赖外部安装（端砚 + 密封 Python），自动测试不注入外部依赖。
 * 其联通性以"真实提交一次任务"验证（见 docs/ADAPTATION-WORKFLOW.md）。
 */
export const inkstoneMcpAdapter: Adapter = {
  manifest: {
    id: "inkstone-mcp",
    name: "端砚科研 MCP 清单",
    description: "列出书生·端砚内置科研 MCP 服务器的工具元数据（只读，不执行任何工具）",
    timeoutMs: 45_000,
    inputSchema,
    fields: fieldsFor(inputSchema),
  },
  run,
};
