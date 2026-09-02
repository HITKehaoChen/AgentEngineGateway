import type { GatewayEvent } from "../model/types.js";

export type EventSubscriber = (event: GatewayEvent) => boolean | void;

export class EventHub {
  private readonly subscribers = new Set<EventSubscriber>();
  constructor(readonly heartbeatMs = 15_000) {}

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  emit(event: GatewayEvent): void {
    for (const subscriber of [...this.subscribers]) {
      try { if (subscriber(event) === false) this.subscribers.delete(subscriber); }
      catch { this.subscribers.delete(subscriber); }
    }
  }
}
