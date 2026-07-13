import { describe, expect, it } from "vitest";
import { SPEC_LOCATOR_CUSTOM_TYPE, scanSpecBranchLocators, validateSpecBranchLocator } from "../spec/locator.js";
import { NOW } from "./spec-fixtures.js";

const locator = { schemaVersion: 1 as const, planSessionId: "plan-session", artifactPath: "/tmp/plans/plan-session/spec", status: "ready" as const, stateVersion: 2, specRevision: 1, stateSha256: "a".repeat(64), committedAt: NOW };
describe("independent Spec locators", () => {
  it("accepts only the exact <plan-session>/spec path and scans newest-first", () => {
    expect(validateSpecBranchLocator(locator, "/tmp/plans")).toEqual(locator);
    expect(validateSpecBranchLocator({ ...locator, artifactPath: "/tmp/plans/plan-session" }, "/tmp/plans")).toBeNull();
    expect(validateSpecBranchLocator({ ...locator, artifactPath: "/tmp/plans/sibling/spec" }, "/tmp/plans")).toBeNull();
    expect(validateSpecBranchLocator({ ...locator, artifactPath: "/tmp/outside/plan-session/spec" }, "/tmp/plans")).toBeNull();
    const scan = scanSpecBranchLocators([{ type: "custom", customType: SPEC_LOCATOR_CUSTOM_TYPE, data: { ...locator, stateVersion: 1 } }, { type: "custom", customType: SPEC_LOCATOR_CUSTOM_TYPE, data: locator }], "/tmp/plans");
    expect(scan.locators.map((entry) => entry.stateVersion)).toEqual([2, 1]);
  });
});
