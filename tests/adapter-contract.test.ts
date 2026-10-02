// 适配器契约测试：所有已注册适配器必须通过的一致性检查。
// 这就是“一致性检查器”本体：新增适配器后跑 `npm test` 即自检。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAllAdapters, validateManifestFields } from "../src/registry";
import { fieldsFor } from "../src/schema-fields";
import { DEFAULT_LIMITS } from "../src/types";
import type { Adapter, AdapterContext, FieldDef } from "../src/types";

const adapters: Adapter[] = getAllAdapters();

if (adapters.length === 0) {
  test("至少存在一个已注册适配器", () => {
    assert.fail("注册表为空");
  });
}

for (const adapter of adapters) {
  const { manifest } = adapter;
  const ctx: AdapterContext = {
    taskId: "contract-test",
    emit: () => {},
  };

  test(`[${manifest.id}] 清单结构合法且字段与 schema 一致`, () => {
    assert.ok(typeof manifest.id === "string" && manifest.id.length >= 1);
    assert.ok(typeof manifest.name === "string" && manifest.name.length >= 1);
    assert.ok(typeof manifest.description === "string" && manifest.description.length >= 1);
    const ids = adapters.map((a) => a.manifest.id);
    assert.equal(ids.indexOf(manifest.id), ids.lastIndexOf(manifest.id), "工具 id 唯一");

    const derived: FieldDef[] = fieldsFor(manifest.inputSchema);
    assert.deepEqual(
      manifest.fields.map((f) => f.name).sort(),
      derived.map((f) => f.name).sort(),
      "manifest.fields 与 inputSchema 派生字段一致"
    );
    const names = manifest.fields.map((f) => f.name);
    assert.equal(names.length, new Set(names).size, "字段名不重复");
    for (const f of manifest.fields) {
      assert.ok(["text", "textarea", "number", "boolean", "select"].includes(f.type), `字段类型合法：${f.type}`);
      if (f.type === "select") {
        assert.ok(Array.isArray(f.options) && f.options.length >= 1, "select 字段须有 options");
      }
      assert.equal(typeof f.required, "boolean");
    }
    const problems = validateManifestFields();
    assert.deepEqual(problems, [], "全部适配器清单自检通过");
  });

  test(`[${manifest.id}] examples 合法样本可解析、非法样本被拒绝`, { skip: !manifest.examples }, () => {
    if (!manifest.examples) return;
    assert.ok(manifest.inputSchema.safeParse(manifest.examples.valid).success, "合法样本应通过 schema");
    assert.equal(manifest.inputSchema.safeParse(manifest.examples.invalid).success, false, "非法样本应被 schema 拒绝");
  });

  test(`[${manifest.id}] 合法输入运行成功；结果可序列化且在体积上限内`, { skip: !manifest.examples }, async () => {
    if (!manifest.examples) return;
    const parsed = manifest.inputSchema.safeParse(manifest.examples.valid);
    if (!parsed.success) return;
    const outcome = await adapter.run(parsed.data, ctx);
    assert.equal(outcome.ok, true, `应成功，但得到：${JSON.stringify(outcome)}`);
    if (outcome.ok) {
      const serialized = JSON.stringify(outcome.result);
      assert.ok(serialized.length <= DEFAULT_LIMITS.maxResultBytes, `结果体积 ${serialized.length} 超上限`);
    }
  });

  test(`[${manifest.id}] 同一输入两次运行结果相同（确定性）`, { skip: !manifest.examples }, async () => {
    if (!manifest.examples) return;
    const parsed = manifest.inputSchema.safeParse(manifest.examples.valid);
    if (!parsed.success) return;
    const a1 = await adapter.run(parsed.data, ctx);
    const a2 = await adapter.run(parsed.data, ctx);
    assert.equal(a1.ok, a2.ok);
    if (a1.ok && a2.ok) {
      assert.deepEqual(a1.result, a2.result, "确定性工具两次结果应一致");
    }
  });

  test(`[${manifest.id}] 非法输入由适配器自身以 ok:false 拒绝（不抛异常）`, { skip: !manifest.examples }, async () => {
    if (!manifest.examples) return;
    const outcome = await adapter.run(manifest.examples.invalid, ctx);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(typeof outcome.error.message === "string" && outcome.error.message.length >= 1, "失败须有错误证据");
    }
  });

  test(`[${manifest.id}] 运行中产出的事件字段合法（percent 0..100）`, { skip: !manifest.examples }, async () => {
    if (!manifest.examples) return;
    const parsed = manifest.inputSchema.safeParse(manifest.examples.valid);
    if (!parsed.success) return;
    const events: Array<{ percent?: number; message: string; type: string }> = [];
    const collectCtx: AdapterContext = {
      taskId: "contract-events",
      emit: (e) => events.push(e),
    };
    await adapter.run(parsed.data, collectCtx);
    for (const e of events) {
      assert.ok(typeof e.message === "string");
      if (e.percent !== undefined) {
        assert.ok(e.percent >= 0 && e.percent <= 100, `percent 非法：${e.percent}`);
      }
      assert.ok(["progress", "info", "warning"].includes(e.type));
    }
  });
}
