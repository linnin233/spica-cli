type EventHandler<T = unknown> = (payload: T) => void;

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  subscribe<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);

    return () => {
      this.handlers.get(event)?.delete(handler as EventHandler);
    };
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): void {
    const wrapper: EventHandler = payload => {
      this.handlers.get(event)?.delete(wrapper);
      (handler as EventHandler)(payload);
    };

    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(wrapper);
  }

  emit<T = unknown>(event: string, payload?: T): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      handler(payload);
    }
  }

  clear(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}
