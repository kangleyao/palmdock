// 适配器 A：文本统计（确定性普通工具，无 AI）。
// 接口形态：自由多行文本输入 + 有 percent 的进度。同一输入结果确定。
import { z } from "zod";
import type { Adapter, AdapterRunResult, JsonValue } from "../types";
import { fieldsFor } from "../schema-fields";

const inputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(20000)
    .describe("要统计的文本")
    .meta({ multiline: true, placeholder: "粘贴或输入文本（最多 2 万字符）" }),
});

interface Stats {
  characters: number;
  charactersNoSpaces: number;
  lines: number;
  words: number;
  cjkChars: number;
  longestLineChars: number;
}

function computeStats(text: string): Stats {
  const lineList = text.split("\n");
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, "").length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const longestLineChars = lineList.reduce((max, l) => Math.max(max, l.length), 0);
  return {
    characters,
    charactersNoSpaces,
    lines: lineList.length,
    words,
    cjkChars,
    longestLineChars,
  };
}

async function run(input: unknown, ctx: import("../types").AdapterContext): Promise<AdapterRunResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        message: "输入不合法（text 必须是 1-20000 字符的字符串）",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        stage: "input.validate",
      },
    };
  }
  const { text } = parsed.data;

  // 分块扫描并报进度：同一输入的进度序列也是确定的（按字符数，不依赖时间）。
  const chunkSize = Math.max(500, Math.ceil(text.length / 10));
  let processed = 0;
  for (let start = 0; start < text.length; start += chunkSize) {
    const end = Math.min(text.length, start + chunkSize);
    processed = end;
    if (start > 0) {
      await Promise.resolve();
    }
    ctx.emit({
      type: "progress",
      message: `已扫描 ${processed}/${text.length} 字符`,
      percent: Math.round((processed / text.length) * 100),
    });
  }

  const stats: Stats = computeStats(text);
  const result: JsonValue = {
    ...stats,
    note: `共 ${stats.lines} 行、${stats.characters} 字符`,
  };
  return { ok: true, result };
}

export const textStatsAdapter: Adapter = {
  manifest: {
    id: "text-stats",
    name: "文本统计",
    description: "统计文本的字符数、行数、词数与最长行（确定性，无网络调用）",
    timeoutMs: 30_000,
    inputSchema,
    fields: fieldsFor(inputSchema),
    examples: {
      valid: { text: "hello world\n第二行 中文" },
      invalid: {},
    },
  },
  run,
};
