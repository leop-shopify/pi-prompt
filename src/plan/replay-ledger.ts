export interface ReplayConflict { readonly kind: "conflict" }
export interface ReplayOverloaded { readonly kind: "overloaded" }
export interface ReplayShared<T> { readonly kind: "shared"; readonly result: Promise<T> }
export interface ReplayStarted<T> { readonly kind: "started"; readonly result: Promise<T> }
export type ReplayDecision<T> = ReplayConflict | ReplayOverloaded | ReplayShared<T> | ReplayStarted<T>;

interface Entry<T> { readonly fingerprint: string; readonly result: Promise<T>; settled: boolean; weight: number }
export interface ReplayLedgerOptions<T> {
  readonly capacity?: number;
  readonly maximumInFlight?: number;
  readonly maximumSettledWeight?: number;
  readonly weight?: (value: T) => number;
}

/** Bounded idempotency ledger. In-flight entries are never evicted. */
export class ReplayLedger<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly capacity: number;
  readonly #maximumInFlight: number;
  readonly #maximumSettledWeight: number;
  readonly #weight: (value: T) => number;
  #inFlight = 0;
  #settledWeight = 0;

  constructor(options: number | ReplayLedgerOptions<T> = 512) {
    const normalized = typeof options === "number" ? { capacity: options } : options;
    this.capacity = normalized.capacity ?? 512;
    this.#maximumInFlight = normalized.maximumInFlight ?? this.capacity;
    this.#maximumSettledWeight = normalized.maximumSettledWeight ?? this.capacity;
    this.#weight = normalized.weight ?? (() => 1);
    if (![this.capacity, this.#maximumInFlight, this.#maximumSettledWeight].every((value) => Number.isSafeInteger(value) && value >= 1)) {
      throw new Error("invalid-replay-capacity");
    }
  }

  run(requestId: string, fingerprint: string, operation: () => Promise<T>): ReplayDecision<T> {
    const existing = this.#entries.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      this.#touch(requestId, existing);
      return { kind: "shared", result: existing.result };
    }
    if (this.#inFlight >= this.#maximumInFlight) return { kind: "overloaded" };
    const entry: Entry<T> = { fingerprint, result: Promise.resolve().then(operation), settled: false, weight: 0 };
    this.#entries.set(requestId, entry);
    this.#inFlight += 1;
    void entry.result.then(
      (value) => this.#settle(entry, value),
      () => this.#settle(entry),
    );
    this.#trim();
    return { kind: "started", result: entry.result };
  }

  get size(): number { return this.#entries.size; }
  get inFlight(): number { return this.#inFlight; }
  get settledWeight(): number { return this.#settledWeight; }
  clear(): void { this.#entries.clear(); this.#inFlight = 0; this.#settledWeight = 0; }

  #settle(entry: Entry<T>, value?: T): void {
    if (entry.settled) return;
    entry.settled = true;
    this.#inFlight -= 1;
    if (value !== undefined) {
      let weight = this.#maximumSettledWeight;
      try { weight = this.#weight(value); } catch { /* retain with the configured maximum */ }
      entry.weight = Number.isSafeInteger(weight) && weight >= 0 ? weight : this.#maximumSettledWeight + 1;
      this.#settledWeight += entry.weight;
    }
    this.#trim();
  }
  #touch(key: string, entry: Entry<T>): void { this.#entries.delete(key); this.#entries.set(key, entry); }
  #trim(): void {
    if (this.#entries.size <= this.capacity && this.#settledWeight <= this.#maximumSettledWeight) return;
    for (const [key, entry] of this.#entries) {
      if (!entry.settled) continue;
      this.#entries.delete(key);
      this.#settledWeight -= entry.weight;
      if (this.#entries.size <= this.capacity && this.#settledWeight <= this.#maximumSettledWeight) return;
    }
  }
}
