import type { PublicEvent } from "./protocol.js";

export type EventReadResult =
  | { readonly kind: "events"; readonly events: readonly PublicEvent[]; readonly currentSequence: number }
  | { readonly kind: "reset"; readonly currentSequence: number; readonly snapshot: "/api/v1/snapshot" }
  | { readonly kind: "future"; readonly currentSequence: number };

interface Waiter { readonly after: number; readonly resolve: (value: EventReadResult) => void; readonly timer: NodeJS.Timeout; readonly signal?: AbortSignal; readonly abort?: () => void }

/** Metadata-only, monotonic, bounded event history with bounded long-poll waiters. */
export class EventLedger {
  readonly #events: PublicEvent[] = [];
  readonly #waiters = new Set<Waiter>();
  #sequence = 0;
  #closed = false;
  constructor(readonly capacity = 256, readonly maximumWaitMs = 20_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 1 || maximumWaitMs > 20_000) throw new Error("invalid-event-ledger-options");
  }

  publish(event: Omit<PublicEvent, "sequence">): PublicEvent {
    if (this.#closed) throw new Error("event-ledger-closed");
    const entry = Object.freeze({ sequence: ++this.#sequence, ...event });
    this.#events.push(entry);
    if (this.#events.length > this.capacity) this.#events.splice(0, this.#events.length - this.capacity);
    this.#wake();
    return entry;
  }

  read(after: number): EventReadResult {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.#sequence) return { kind: "future", currentSequence: this.#sequence };
    const oldest = this.#events[0]?.sequence ?? this.#sequence + 1;
    if (after < oldest - 1) return { kind: "reset", currentSequence: this.#sequence, snapshot: "/api/v1/snapshot" };
    return { kind: "events", events: Object.freeze(this.#events.filter((event) => event.sequence > after)), currentSequence: this.#sequence };
  }

  wait(after: number, waitMs = this.maximumWaitMs, signal?: AbortSignal): Promise<EventReadResult> {
    const immediate = this.read(after);
    if (immediate.kind !== "events" || immediate.events.length > 0 || this.#closed || waitMs <= 0) return Promise.resolve(immediate);
    const bounded = Math.min(this.maximumWaitMs, Math.max(1, waitMs));
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#finish(waiter, this.read(after)), bounded);
      timer.unref();
      const abort = signal ? () => this.#finish(waiter, this.read(after)) : undefined;
      const waiter: Waiter = { after, resolve, timer, ...(signal ? { signal } : {}), ...(abort ? { abort } : {}) };
      this.#waiters.add(waiter);
      signal?.addEventListener("abort", abort!, { once: true });
      if (signal?.aborted) abort?.();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of [...this.#waiters]) this.#finish(waiter, this.read(waiter.after));
  }
  get sequence(): number { return this.#sequence; }
  get waiterCount(): number { return this.#waiters.size; }

  #wake(): void { for (const waiter of [...this.#waiters]) { const result = this.read(waiter.after); if (result.kind !== "events" || result.events.length > 0) this.#finish(waiter, result); } }
  #finish(waiter: Waiter, value: EventReadResult): void { if (!this.#waiters.delete(waiter)) return; clearTimeout(waiter.timer); if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort); waiter.resolve(value); }
}
