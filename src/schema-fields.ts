// 从 zod schema 派生前端表单字段定义（单一来源：适配器只声明 zod schema）。
import { z } from "zod";
import type { FieldDef, FieldType } from "./types";

interface FieldMeta {
  multiline?: boolean;
  placeholder?: string;
  help?: string;
}

function getMeta(schema: z.ZodType<unknown>): FieldMeta {
  const m = (schema as unknown as { meta?: () => unknown }).meta?.();
  if (m && typeof m === "object") return m as FieldMeta;
  return {};
}

/** 解包 optional / default，返回内层 schema 与 required 标记。 */
function unwrap(schema: z.ZodType<unknown>): { inner: z.ZodType<unknown>; required: boolean } {
  if (schema instanceof z.ZodOptional) {
    const inner = (schema as z.ZodOptional<z.ZodType<unknown>>).unwrap();
    return { inner: unwrap(inner).inner, required: false };
  }
  if (schema instanceof z.ZodDefault) {
    const inner = (schema as z.ZodDefault<z.ZodType<unknown>>).unwrap();
    return { inner: unwrap(inner).inner, required: false };
  }
  return { inner: schema, required: true };
}

function fieldTypeOf(schema: z.ZodType<unknown>): { type: FieldType; options?: string[] } {
  if (schema instanceof z.ZodString) return { type: "text" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) {
    const rawOptions = (schema as unknown as { options: readonly (string | number)[] }).options;
    return { type: "select", options: rawOptions.map(String) };
  }
  throw new Error(
    `暂不支持的输入字段类型：${schema.constructor.name}（仅支持 string/number/boolean/enum 及其 optional/default）`
  );
}

/**
 * 从 zod object schema 生成字段定义。
 * 只支持一层的普通对象（输入应当是有限、明确的简单字段）。
 */
export function fieldsFor(schema: z.ZodType<unknown>): FieldDef[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("inputSchema 必须是 z.object(...)");
  }
  const shape = (schema as z.ZodObject<Record<string, z.ZodType<unknown>>>).shape;
  return Object.entries(shape).map(([name, raw]) => {
    const { inner, required } = unwrap(raw);
    const { type, options } = fieldTypeOf(inner);
    const meta = getMeta(raw);
    const description = (raw as { description?: string }).description ?? (inner as { description?: string }).description ?? name;
    if (type === "text" && meta.multiline) {
      return {
        name,
        label: description,
        type: "textarea" as FieldType,
        required,
        placeholder: meta.placeholder,
        help: meta.help,
      };
    }
    if (type === "select") {
      return {
        name,
        label: description,
        type: "select" as FieldType,
        options,
        required,
        placeholder: meta.placeholder,
        help: meta.help,
      };
    }
    return { name, label: description, type, required, placeholder: meta.placeholder, help: meta.help };
  });
}
