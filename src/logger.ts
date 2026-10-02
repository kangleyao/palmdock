// 极简日志。策略：永远不记录 token、Authorization 头、用户输入内容、工具输出内容。

export const logger = {
  info(message: string): void {
    console.log(`[info] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[warn] ${message}`);
  },
  error(message: string): void {
    console.error(`[error] ${message}`);
  },
};
