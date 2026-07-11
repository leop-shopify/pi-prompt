import { describe, expect, it, vi } from "vitest";
import { EventLedger } from "../plan/event-ledger.js";
import { ReplayLedger } from "../plan/replay-ledger.js";

const metadata = (stateVersion: number) => ({ kind: "state-changed", status: "ready" as const, stateVersion, documentRevision: 1 });

describe("ReplayLedger", () => {
  it("shares in-flight work, replays the exact result, and rejects ID mismatches", async () => {
    let finish!: (value: { status: number }) => void;
    const operation = vi.fn(() => new Promise<{ status: number }>((resolve) => { finish = resolve; }));
    const ledger = new ReplayLedger<{ status: number }>(2);
    const first = ledger.run("one", "fingerprint", operation);
    const duplicate = ledger.run("one", "fingerprint", operation);
    expect(first.kind).toBe("started"); expect(duplicate.kind).toBe("shared"); expect(operation).toHaveBeenCalledTimes(0);
    await Promise.resolve(); expect(operation).toHaveBeenCalledTimes(1);
    expect(ledger.run("one", "different", operation).kind).toBe("conflict");
    finish({ status: 202 });
    const [a, b] = await Promise.all(["result" in first ? first.result : Promise.reject(), "result" in duplicate ? duplicate.result : Promise.reject()]);
    expect(a).toBe(b);
    const replay = ledger.run("one", "fingerprint", operation);
    await expect("result" in replay ? replay.result : Promise.reject()).resolves.toBe(a);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("bounds in-flight work and settled response weight without evicting active entries", async () => {
    let finish!: (value: string) => void;
    const ledger = new ReplayLedger<string>({ capacity: 4, maximumInFlight: 1, maximumSettledWeight: 5, weight: (value) => value.length });
    const pending = ledger.run("pending", "p", () => new Promise<string>((resolve) => { finish = resolve; }));
    expect(ledger.run("overload", "o", async () => "other").kind).toBe("overloaded");
    expect(ledger.run("pending", "p", async () => "duplicate").kind).toBe("shared");
    await Promise.resolve(); finish("12345"); await (pending as any).result;
    expect(ledger.inFlight).toBe(0); expect(ledger.settledWeight).toBe(5);
    await (ledger.run("new", "n", async () => "67890") as any).result;
    expect(ledger.settledWeight).toBeLessThanOrEqual(5);
    expect(ledger.size).toBe(1);
  });

  it("never evicts in-flight entries while trimming settled results", async () => {
    let finish!: () => void;
    const ledger = new ReplayLedger<number>(1);
    const pending = ledger.run("pending", "p", () => new Promise<number>((resolve) => { finish = () => resolve(1); }));
    await Promise.resolve();
    await (ledger.run("settled", "s", async () => 2) as any).result;
    expect(ledger.run("pending", "p", async () => 3).kind).toBe("shared");
    finish(); await (pending as any).result;
  });
});

describe("EventLedger", () => {
  it("wakes long polls only after publish and returns metadata-only events", async () => {
    vi.useFakeTimers();
    const ledger = new EventLedger(2, 20_000);
    const waiting = ledger.wait(0);
    expect(ledger.waiterCount).toBe(1);
    ledger.publish(metadata(1));
    await expect(waiting).resolves.toMatchObject({ kind: "events", events: [{ sequence: 1, stateVersion: 1 }] });
    expect(ledger.waiterCount).toBe(0);
    ledger.close(); vi.useRealTimers();
  });

  it("times out, resets too-old cursors, rejects future cursors, and disconnects without mutation", async () => {
    vi.useFakeTimers();
    const ledger = new EventLedger(2, 20_000);
    ledger.publish(metadata(1)); ledger.publish(metadata(2)); ledger.publish(metadata(3));
    expect(ledger.read(0)).toEqual({ kind: "reset", currentSequence: 3, snapshot: "/api/v1/snapshot" });
    expect(ledger.read(4)).toEqual({ kind: "future", currentSequence: 3 });
    const abort = new AbortController(); const wait = ledger.wait(3, 20_000, abort.signal); abort.abort();
    await expect(wait).resolves.toMatchObject({ kind: "events", events: [] });
    const timeout = ledger.wait(3, 20_000); await vi.advanceTimersByTimeAsync(20_000);
    await expect(timeout).resolves.toMatchObject({ kind: "events", events: [] });
    expect(ledger.sequence).toBe(3);
    ledger.close(); vi.useRealTimers();
  });
});
