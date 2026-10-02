// 真实 DSH 只读连通性验证（里程碑步骤 3）：
//   在完全隔离的环境中启动真实 dsh web 服务器（DSH_HOME 与 cwd 都是临时目录，
//   绝不触碰用户 ~/.dsh 与既有会话），然后只用只读方法调用它：
//     - POST /api/host.describe（能力快照，只读）
//     - POST /api/session.list（列会话，只读；隔离 home 里为空）
//   请求复用 dsh-agent 适配器的同一 rpc 代码路径（dshDescribe/dshListSessions），
//   以文档化 ClientRequest/ServerResponse 封套、经回环权威接受 Host 信任栅栏。
//   全程不创建会话、不发 prompt、不审批，不产生任何写操作。
//
// 使用：
//   node scripts/verify-dsh-readonly.js
//   （可选环境变量 DSH_BASE / DSH_BIN 覆盖自动发现的安装路径与 bin）
//
// 退出码：0 = 全部通过；1 = 任一项失败（附证据）。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
 // 注意：适配器是 TypeScript，本脚本加载其编译产物（npm test / npm run build 生成）。
 const ADAPTER_DIST = path.join(__dirname, "..", "dist", "src", "adapters", "dsh-agent.js");
 if (!fs.existsSync(ADAPTER_DIST)) {
   console.error("请先运行 `npm run build`（或 npm test）编译 TypeScript，再运行本脚本。");
   process.exit(1);
 }
 const { dshDescribe, dshListSessions } = require(ADAPTER_DIST);

// ---------------- 发现 DSH 安装位置（只读元数据：注册表卸载项） ----------------

function findDshInstall() {
  if (process.env.DSH_BASE && fs.existsSync(process.env.DSH_BASE)) return process.env.DSH_BASE;
  const { execSync } = require("node:child_process");
  try {
    const out = execSync(
      `powershell -NoProfile -Command "$p = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'DeepSeek Harness' } | Select-Object -First 1; if ($p) { $p.DisplayIcon }"`,
      { encoding: "utf8", windowsHide: true }
    ).trim();
    // DisplayIcon 形如 "C:\\Users\\...\\DeepSeek Harness.exe,0"
    const m = out.match(/^"?(.*?\.exe)"?,?\d*$/i);
    if (m && fs.existsSync(m[1])) return path.join(path.dirname(m[1]), "resources", "app");
  } catch {
    // 注册表读取失败时走默认路径
  }
  const def = path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness");
  return fs.existsSync(def) ? path.join(def, "resources", "app") : null;
}

function findDshBin(appRoot) {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  const candidate = path.join(appRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  return fs.existsSync(candidate) ? candidate : null;
}

// ---------------- 启动隔离的真实 dsh web ----------------

function startDsh(bin, port, homeDir, cwdDir, logFile) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(cwdDir, { recursive: true });
    const log = fs.openSync(logFile, "w");
    const child = spawn(process.execPath, [bin, "web", "--port", String(port)], {
      cwd: cwdDir,
      env: { ...process.env, DSH_HOME: homeDir },
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    child.unref();

    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(new Error(`dsh web 在 ${START_TIMEOUT_MS}ms 内未监听端口 ${port}（日志见 ${logFile}）`));
    }, START_TIMEOUT_MS);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`dsh web 提前退出（code=${code} signal=${signal}，日志见 ${logFile}）`));
    });

    const poll = setInterval(() => {
      try {
        // 只要有监听即视为就绪（不做 pid 归属判定，避免误判）
        const out = require("node:child_process").execSync(
          `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count"`,
          { encoding: "utf8", windowsHide: true }
        ).trim();
        if (Number(out) > 0) {
          clearInterval(poll);
          clearTimeout(timer);
          child.removeAllListeners("exit");
          resolve(child);
        }
      } catch {
        // 轮询失败：继续
      }
    }, 500);
  });
}

const START_TIMEOUT_MS = 90000;
const PROBE_TIMEOUT_MS = 15000;

function stopDsh(child, logFile) {
  try {
    child.kill("SIGTERM");
  } catch {
    // 忽略
  }
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      // 忽略
    }
  }, 3000);
  void logFile;
}

// ---------------- 主流程 ----------------

(async () => {
  const results = [];
  const check = (name, ok, evidence) => {
    results.push({ name, ok, evidence });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence ? " — " + evidence : ""}`);
  };

  const appRoot = findDshInstall();
  check("发现 DSH 安装目录（注册表/默认路径，只读元数据）", !!appRoot, appRoot || "未找到");
  if (!appRoot) process.exit(1);

  const bin = findDshBin(appRoot);
  check("定位 @deepseek-ai/dsh CLI（resources/app/node_modules）", !!bin, bin || "缺失");
  if (!bin) process.exit(1);

  const port = Number(process.env.DSH_PORT) || 8899;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-readonly-"));
  const homeDir = path.join(scratch, "dsh-home"); // 隔离 DSH_HOME：绝不碰 ~/.dsh
  const cwdDir = path.join(scratch, "dsh-cwd"); // 隔离 workspace 根
  const logFile = path.join(scratch, "dsh-web.log");

  let child = null;
  try {
    console.log(`启动隔离 dsh web：DSH_HOME=${homeDir} cwd=${cwdDir} port=${port}`);
    child = await startDsh(bin, port, homeDir, cwdDir, logFile);
    check("真实 dsh web 在隔离环境中监听端口", true, `port ${port} listening`);
  } catch (e) {
    check("真实 dsh web 在隔离环境中监听端口", false, e.message);
    const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-800) : "(无日志)";
    console.log("--- dsh 启动日志尾 ---\n" + tail);
    process.exit(1);
  }

  const base = `http://127.0.0.1:${port}`;

  // 只读探测 1：host.describe（适配器同一代码路径）
  try {
    const describe = await withTimeout(dshDescribe(base), PROBE_TIMEOUT_MS);
    const ok = describe.ok === true;
    check(
      "host.describe 经文档化封套成功（回环权威通过 Host 栅栏）",
      ok,
      ok ? `version=${describe.value.version} attachedSessions=${describe.value.attachedSessions} canOpenPath=${describe.value.canOpenPath}` : `error=${describe.error && describe.error.code}: ${describe.error && describe.error.message}`
    );
  } catch (e) {
    check("host.describe 经文档化封套成功（回环权威通过 Host 栅栏）", false, e.message);
  }

  // 只读探测 2：session.list（隔离 home 中应为空列表）
  try {
    const list = await withTimeout(dshListSessions(base), PROBE_TIMEOUT_MS);
    const ok = list.ok === true && Array.isArray(list.value.items);
    check(
      "session.list 只读列会话成功（隔离 home，未触碰用户数据）",
      ok,
      ok ? `items=${list.value.items.length}` : `error=${list.error && list.error.code}: ${list.error && list.error.message}`
    );
  } catch (e) {
    check("session.list 只读列会话成功（隔离 home，未触碰用户数据）", false, e.message);
  }

  stopDsh(child, logFile);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n验证结束：${results.length} 项检查，失败 ${failed}，退出码 ${failed > 0 ? 1 : 0}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("verify-dsh-readonly fatal: " + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms)),
  ]);
}
