// 启动器辅助：打印配置中的端口（或 BASE_PORT 覆盖）。只输出数字端口本身，不含 token。
// 解析规则与 src/config.ts 一致：环境变量 > config.json > 默认值。
const fs = require("node:fs");

function main() {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node read-config.js <config.json> port|token\n");
    process.exit(2);
  }
  const field = process.argv[3] || "port";
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    process.stderr.write("config.json 解析失败：" + (e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(2);
  }
  if (field === "port") {
    const port = Number(process.env.BASE_PORT || cfg.port || 8787);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      process.stderr.write("port 非法：" + port + "\n");
      process.exit(2);
    }
    process.stdout.write(String(Math.floor(port)));
    return;
  }
  if (field === "token") {
    const token = process.env.BASE_TOKEN || (typeof cfg.token === "string" ? cfg.token : "");
    // 只写进程 stdout 供启动器取用，不回显到可见输出
    process.stdout.write(token);
    return;
  }
  process.stderr.write("未知字段：" + field + "\n");
  process.exit(2);
}

main();
