import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAN_LOCATOR_CUSTOM_TYPE, scanPlanBranchLocators, validatePlanBranchLocator,
} from "../plan/locator.js";

const roots: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "plan-locator-")); roots.push(value); return value; }
function locator(base: string, version = 1) {
  return { schemaVersion: 1, sessionId: "session-1", artifactPath: resolve(base, "session-1"), status: "ready", stateVersion: version, documentRevision: 1, stateSha256: "a".repeat(64), committedAt: "2026-07-10T12:00:00.000Z" };
}

describe("plan branch locators", () => {
  it("scans only supplied branch entries newest first", async () => {
    const base = await root(); const older = locator(base, 1); const newer = locator(base, 2);
    const scan = scanPlanBranchLocators([
      { type: "custom", customType: PLAN_LOCATOR_CUSTOM_TYPE, data: older },
      { type: "message" },
      { type: "custom", customType: "other", data: locator(base, 99) },
      { type: "custom", customType: PLAN_LOCATOR_CUSTOM_TYPE, data: newer },
    ], base);
    expect(scan.locators.map((entry) => entry.stateVersion)).toEqual([2, 1]); expect(scan.invalidEntries).toBe(0);
  });

  it("accepts awaiting-clarification locators for durable recovery", async () => {
    const base = await root();
    expect(validatePlanBranchLocator({ ...locator(base), status: "awaiting-clarification" }, base)).toMatchObject({ status: "awaiting-clarification" });
  });

  it("rejects missing, extra, traversal, unsafe hashes and timestamps", async () => {
    const base = await root();
    expect(validatePlanBranchLocator({ ...locator(base), extra: true }, base)).toBeNull();
    const { status: _status, ...missing } = locator(base); expect(validatePlanBranchLocator(missing, base)).toBeNull();
    expect(validatePlanBranchLocator({ ...locator(base), sessionId: "../escape", artifactPath: resolve(base, "../escape") }, base)).toBeNull();
    expect(validatePlanBranchLocator({ ...locator(base), stateSha256: "A".repeat(64) }, base)).toBeNull();
    expect(validatePlanBranchLocator({ ...locator(base), committedAt: "2026-07-10" }, base)).toBeNull();
    expect(validatePlanBranchLocator({ ...locator(base), artifactPath: `${resolve(base, "session-1")}/` }, base)).toBeNull();
  });

  it("rejects an artifact symlink escaping the injected root", async () => {
    const base = await root(); const outside = await root(); await mkdir(join(outside, "target"));
    await symlink(join(outside, "target"), join(base, "session-1"));
    expect(validatePlanBranchLocator(locator(base), base)).toBeNull();
  });
});
