// 适配器注册表：显式注册，不做自动扫描/插件市场（安全与可审计优先）。
import type { Adapter, AdapterCapabilities, FieldDef, SessionAdapter, ToolMode } from "./types";
import { fieldsFor } from "./schema-fields";
import { textStatsAdapter } from "./adapters/text-stats";

import { dirListingAdapter } from "./adapters/dir-listing";
import { inkstoneMcpAdapter } from "./adapters/inkstone-mcp";
import { inkstoneBiorxivCategoriesAdapter } from "./adapters/inkstone-biorxiv-categories";
import { dshAgentAdapter } from "./adapters/dsh-agent";

/**
 * 产品端清单：新增工具 = 新适配器文件 + 在此数组加一行。
 * 演示助手（fake-ai）不在此列：它是内部测试替身与适配参照样例，
 * 由测试环境显式注册进自己的注册表（见 tests/helpers.ts）。
 */
const ADAPTERS: Adapter[] = [
  textStatsAdapter,
  dirListingAdapter,
  inkstoneMcpAdapter,
  inkstoneBiorxivCategoriesAdapter,
  dshAgentAdapter,
];

export interface PublicManifest {
  id: string;
  name: string;
  description: string;
  timeoutMs?: number;
  fields: FieldDef[];
  /** 工具形态：task=一次性任务；session=仅会话；both=两者皆可。 */
  mode: ToolMode;
  /** 规范化后的能力声明（公共页面据此决定渲染哪些入口，不支持的不留空按钮）。 */
  capabilities: AdapterCapabilities;
}

/**
 * 注册表视图：按显式清单构造。
 * 生产用默认清单（defaultRegistry）；测试可追加测试替身构造自己的注册表，
 * 与产品端清单互不影响。
 */
export interface Registry {
  getAllAdapters(): Adapter[];
  getAdapter(toolId: string): Adapter | undefined;
  getSessionAdapter(toolId: string): SessionAdapter | undefined;
  publicManifests(): PublicManifest[];
}

export function createRegistry(adapters: Adapter[]): Registry {
  const byId = new Map<string, Adapter>(adapters.map((a) => [a.manifest.id, a]));
  const getSessionAdapter = (toolId: string): SessionAdapter | undefined => {
    const adapter = byId.get(toolId);
    if (!adapter) return undefined;
    if (capabilitiesOf(adapter).sessions !== true) return undefined;
    if (typeof (adapter as SessionAdapter).runTurn !== "function") return undefined;
    return adapter as SessionAdapter;
  };
  return {
    getAllAdapters: () => adapters,
    getAdapter: (toolId) => byId.get(toolId),
    getSessionAdapter,
    publicManifests: () =>
      adapters.map((a) => ({
        id: a.manifest.id,
        name: a.manifest.name,
        description: a.manifest.description,
        ...(a.manifest.timeoutMs !== undefined ? { timeoutMs: a.manifest.timeoutMs } : {}),
        fields: a.manifest.fields,
        mode: (a.manifest.mode ?? "task") as ToolMode,
        capabilities: capabilitiesOf(a),
      })),
  };
}

/** 生产装配的默认注册表：仅含产品端清单（ADAPTERS）。 */
export const defaultRegistry: Registry = createRegistry(ADAPTERS);

// 具名导出：默认注册表的薄委托，保持既有调用方（src/index.ts、契约测试等）不变。
export function getAllAdapters(): Adapter[] {
  return defaultRegistry.getAllAdapters();
}

export function getAdapter(toolId: string): Adapter | undefined {
  return defaultRegistry.getAdapter(toolId);
}

/** 会话型适配器发现：声明 sessions 能力且实现了 runTurn，才被视为第二层端。 */
export function getSessionAdapter(toolId: string): SessionAdapter | undefined {
  return defaultRegistry.getSessionAdapter(toolId);
}

export function publicManifests(): PublicManifest[] {
  return defaultRegistry.publicManifests();
}

/** 规范化能力声明：缺省项一律 false（不支持即明确标记为不支持）。 */
export function capabilitiesOf(adapter: Adapter): AdapterCapabilities {
  const c = adapter.manifest.capabilities;
  return {
    sessions: c?.sessions === true,
    listSessions: c?.listSessions === true,
    streaming: c?.streaming === true,
    askUser: c?.askUser === true,
  };
}

/** 供契约测试与启动自检：字段与 schema 一致性、形态与能力声明一致性预检。 */
export function validateManifestFields(adapters: Adapter[] = ADAPTERS): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  for (const adapter of adapters) {
    const { manifest } = adapter;
    if (seenIds.has(manifest.id)) problems.push(`工具 id 重复：${manifest.id}`);
    seenIds.add(manifest.id);
    try {
      const derived = fieldsFor(manifest.inputSchema);
      const declared = manifest.fields;
      const derivedKeys = derived.map((f) => f.name).sort().join(",");
      const declaredKeys = declared.map((f) => f.name).sort().join(",");
      if (derivedKeys !== declaredKeys) {
        problems.push(`${manifest.id}: manifest.fields 与 inputSchema 派生字段不一致（${declaredKeys} vs ${derivedKeys}）`);
      }
    } catch (e) {
      problems.push(`${manifest.id}: inputSchema 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    // 形态与能力一致性：能力声明必须与形态匹配，避免页面渲染出无法兑现的入口。
    const mode = (manifest.mode ?? "task") as ToolMode;
    const caps = capabilitiesOf(adapter);
    if (mode !== "task" && mode !== "session" && mode !== "both") {
      problems.push(`${manifest.id}: mode 非法（${mode}），只能是 task / session / both`);
    }
    if (caps.sessions && mode === "task") {
      problems.push(`${manifest.id}: 声明了会话能力却声明 mode=task（页面会渲染出不存在的会话入口）`);
    }
    if (mode !== "task" && !caps.sessions) {
      problems.push(`${manifest.id}: 声明了会话形态（mode=${mode}）却未声明 capabilities.sessions`);
    }
    if (mode !== "task" && typeof (adapter as SessionAdapter).runTurn !== "function") {
      problems.push(`${manifest.id}: 声明了会话形态但未实现 runTurn`);
    }
  }
  return problems;
}
