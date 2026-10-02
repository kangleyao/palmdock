// 适配器 B：目录清单（确定性普通工具，无 AI）。
// 接口形态：选项类输入（枚举/数字）+ 只读文件系统访问；不接收任意路径，
// 只列出固定的白名单目录 data/listing-root 下（首次运行自动生成示例文件）。
// 进度只有消息流，没有 percent —— 与适配器 A 的接口形态刻意不同。
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Adapter, AdapterRunResult, JsonValue } from "../types";
import { fieldsFor } from "../schema-fields";

const inputSchema = z.object({
  sortBy: z.enum(["name", "size"]).describe("排序方式").default("name"),
  extension: z
    .string()
    .min(1)
    .max(16)
    .optional()
    .describe("按扩展名过滤（不含点，如 txt）")
    .meta({ placeholder: "如 txt" }),
  limit: z.number().int().min(1).max(500).default(50).describe("最多列出的条目数"),
});

/** 白名单根目录：只允许在 data/listing-root 下读取，输入不接受路径。 */
function rootDir(): string {
  return path.resolve(process.cwd(), "data", "listing-root");
}

/** 确定性示例数据：首次运行创建；已存在则不动。 */
async function ensureSampleData(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const samples: Array<[string, string]> = [
    ["README.txt", "这是目录清单工具的示例数据目录。\n禁止访问此目录之外的路径。\n"],
    ["sample-alpha.txt", "alpha\n".repeat(32)],
    ["sample-beta.md", "# Beta\n\n示例 markdown 文件。\n"],
    ["notes-中文.txt", "中文示例内容。\n"],
  ];
  for (const [name, content] of samples) {
    const p = path.join(root, name);
    if (!(await exists(p))) await fs.writeFile(p, content, "utf8");
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

interface Entry {
  name: string;
  sizeBytes: number;
  isDirectory: boolean;
}

async function run(input: unknown, ctx: import("../types").AdapterContext): Promise<AdapterRunResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        message: "输入不合法（sortBy/name|size；limit 1-500；extension 可选）",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        stage: "input.validate",
      },
    };
  }
  const { sortBy, extension, limit } = parsed.data;

  const root = rootDir();
  ctx.emit({ type: "info", message: `准备扫描白名单目录：${root}` });
  await ensureSampleData(root);

  let names = await fs.readdir(root, { withFileTypes: true });
  ctx.emit({ type: "info", message: `发现 ${names.length} 个条目` });

  const entries: Entry[] = [];
  for (const d of names) {
    const full = path.join(root, d.name);
    const stat = await fs.stat(full);
    entries.push({ name: d.name, sizeBytes: stat.size, isDirectory: d.isDirectory() });
  }

  let filtered = entries;
  if (extension) {
    const ext = extension.startsWith(".") ? extension.slice(1) : extension;
    filtered = entries.filter((e) => e.name.endsWith("." + ext));
    ctx.emit({ type: "info", message: `扩展名过滤 ${ext} 后剩余 ${filtered.length} 个` });
  }
  filtered.sort((a, b) =>
    sortBy === "size" ? b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)
  );

  const truncated = filtered.length > limit;
  const kept = filtered.slice(0, limit);
  const result: JsonValue = {
    directory: root,
    totalCount: filtered.length,
    limitApplied: limit,
    truncated,
    entries: kept.map((e) => ({ name: e.name, sizeBytes: e.sizeBytes, isDirectory: e.isDirectory })),
    ...(truncated ? { note: `结果被 limit=${limit} 截断` } : {}),
  };
  ctx.emit({ type: "info", message: `完成：返回 ${kept.length} 个条目` });
  return { ok: true, result };
}

export const dirListingAdapter: Adapter = {
  manifest: {
    id: "dir-listing",
    name: "目录清单",
    description: "列出固定白名单目录下的文件（只读，不接收任意路径）",
    timeoutMs: 20_000,
    inputSchema,
    fields: fieldsFor(inputSchema),
    examples: {
      valid: { sortBy: "name", limit: 50 },
      invalid: { sortBy: "bogus" },
    },
  },
  run,
};
