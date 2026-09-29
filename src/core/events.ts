type Handler<T> = (payload: T) => void;

/** Minimal typed event bus. Handlers are called synchronously in subscription order. */
export class EventBus<Events extends object> {
  private handlers = new Map<keyof Events, Handler<never>[]>();

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as Handler<never>);
    this.handlers.set(type, list);
    return () => this.off(type, handler);
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(handler as Handler<never>);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const list = this.handlers.get(type);
    if (!list) return;
    for (const h of [...list]) (h as Handler<Events[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
