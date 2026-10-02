// 会话变更总线（第二层推流的“已提交 → 通知”通道）。
//
// 设计要点：
// - 进程内同步总线，订阅者在持久层事务提交后被调用，据此重读已提交数据再推送；
//   总线本身不传任何业务负载，避免在多个订阅者面前重复派生同一份数据。
// - 作用域为单个服务实例（生产入口与每个测试环境各自创建），
//   持久层注入的是“发射器”，HTTP 层注入的是总线，二者由装配层（index/helpers）连接。
// - publish 时对订阅者异常做容错：某个订阅者失败不得影响持久化调用方。
import { logger } from "./logger";

export interface TurnChange {
  turnId: string;
  sessionId: string;
}

export type TurnChangeListener = (change: TurnChange) => void;

export class TurnBus {
  private readonly listeners = new Map<symbol, TurnChangeListener>();

  subscribe(listener: TurnChangeListener): () => void {
    const key = Symbol("turn-bus-listener");
    this.listeners.set(key, listener);
    return () => {
      this.listeners.delete(key);
    };
  }

  emit(change: TurnChange): void {
    for (const listener of this.listeners.values()) {
      try {
        listener(change);
      } catch (e) {
        logger.warn(`会话变更订阅异常（${change.turnId}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
