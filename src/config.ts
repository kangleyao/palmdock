// 配置加载：环境变量 > config.json > 内置默认值。token 绝不硬编码、绝不打印。
import * as fs from "node:fs";
import * as path from "node:path";

export type BindMode = "loopback" | "lan";

export interface AppConfig {
  port: number;
  bind: BindMode;
  dataDir: string;
  maxTasks: number;
  maxConcurrent: number;
  token: string;
}

export class ConfigError extends Error {}

const DEFAULTS = {
  port: 8787,
  bind: "loopback" as BindMode,
  dataDir: "data",
  maxTasks: 500,
  maxConcurrent: 4,
};

function readConfigFile(): Record<string, unknown> {
  const configPath = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    let raw = fs.readFileSync(configPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 容错：剥掉 UTF-8 BOM
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config.json 必须是 JSON 对象`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`config.json 解析失败：${(e as Error).message}`);
  }
}

function envString(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function envInt(name: string): number | undefined {
  const v = envString(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConfigError(`${name} 必须是整数：${v}`);
  return n;
}

/**
 * 加载配置。overrides 仅用于测试与显式注入，优先级最高。
 * token 来源：BASE_TOKEN 环境变量 > config.json 的 token 字段；都没有则抛错。
 */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const file = readConfigFile();

  const bind: BindMode = (() => {
    const raw = overrides?.bind ?? envString("BASE_BIND") ?? file.bind ?? DEFAULTS.bind;
    if (raw !== "loopback" && raw !== "lan") {
      throw new ConfigError(`bind 只能是 "loopback" 或 "lan"，当前为 ${JSON.stringify(raw)}`);
    }
    return raw;
  })();

  const token =
    overrides?.token ?? envString("BASE_TOKEN") ?? (typeof file.token === "string" ? file.token : undefined);
  if (token === undefined || token.length < 16) {
    throw new ConfigError(
      "未配置访问 token（要求至少 16 个字符）。运行 `npm run token` 生成并写入 config.json，或设置环境变量 BASE_TOKEN；token 不会出现在日志或 URL 中。"
    );
  }

  const port = overrides?.port ?? envInt("BASE_PORT") ?? (typeof file.port === "number" ? file.port : DEFAULTS.port);
  const dataDir = overrides?.dataDir ?? envString("BASE_DATA_DIR") ?? (typeof file.dataDir === "string" ? file.dataDir : DEFAULTS.dataDir);
  const maxTasks = overrides?.maxTasks ?? envInt("BASE_MAX_TASKS") ?? (typeof file.maxTasks === "number" ? file.maxTasks : DEFAULTS.maxTasks);
  const maxConcurrent = overrides?.maxConcurrent ?? envInt("BASE_MAX_CONCURRENT") ?? (typeof file.maxConcurrent === "number" ? file.maxConcurrent : DEFAULTS.maxConcurrent);

  if (port < 1 || port > 65535) throw new ConfigError(`port 非法：${port}`);
  if (maxTasks < 1) throw new ConfigError(`maxTasks 必须 >= 1`);
  if (maxConcurrent < 1) throw new ConfigError(`maxConcurrent 必须 >= 1`);

  return { port, bind, dataDir, maxTasks, maxConcurrent, token };
}

/** 服务监听地址：默认仅回环，最小网络暴露；lan 模式显式绑 0.0.0.0。 */
export function bindHost(bind: BindMode): string {
  return bind === "lan" ? "0.0.0.0" : "127.0.0.1";
}

/** 单机持久化数据库路径（绝对路径）。 */
export function resolveDbPath(dataDir: string): string {
  const abs = path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
  fs.mkdirSync(abs, { recursive: true });
  return path.join(abs, "base.db");
}
