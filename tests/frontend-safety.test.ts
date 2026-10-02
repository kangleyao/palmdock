// 前端安全静态检查：公共页面不得把工具输出注入为 HTML。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const publicDir = path.resolve(__dirname, "..", "..", "public");

test("public/app.js 不使用 innerHTML / eval / document.write 等动态 HTML 注入", () => {
  const file = path.join(publicDir, "app.js");
  const src = fs.readFileSync(file, "utf8");
  const forbidden = [/\.innerHTML\s*=/, /insertAdjacentHTML\s*\(/, /document\.write\s*\(/, /\beval\s*\(/, /new Function\s*\(/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(src), `app.js 不允许动态 HTML/代码注入：${pattern}`);
  }
  assert.ok(src.length > 500, "app.js 应有实质内容");
});

test("public/*.html 引用外部脚本而内联脚本块", () => {
  for (const name of ["index.html", "form.html", "task.html", "session.html", "tools.html"]) {
    const html = fs.readFileSync(path.join(publicDir, name), "utf8");

    assert.ok(!/<script(?![^>]*src=)/i.test(html.replace(/<script[^>]*src=[^>]*>[\s\S]*?<\/script>/gi, "")), `${name} 不应有非外链 script`);
  }
});
