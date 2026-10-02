// 生成随机 token 写入 config.json（不打印到控制台、不写日志）。
// 用法：npm run token
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function main(): void {
  const configPath = path.resolve(process.cwd(), "config.json");
  const existing: Record<string, unknown> = fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};
  const token = crypto.randomBytes(32).toString("hex");
  const updated = { ...existing, token };
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  process.stdout.write(
    [
      `已生成 token 并写入 ${configPath}`,
      `（出于安全考虑不在此打印 token；请打开该文件复制，再分发到手机浏览器使用。）`,
      `config.json 已在 .gitignore 中，不会被提交到仓库。`,
      ``,
    ].join("\n")
  );
}

main();
