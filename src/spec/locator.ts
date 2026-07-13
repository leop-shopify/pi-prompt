import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SpecBranchLocator, SpecStatus } from "./types.js";

export const SPEC_LOCATOR_CUSTOM_TYPE = "pi-prompt.spec-locator.v1";
export interface SpecBranchEntry { readonly type: string; readonly customType?: string; readonly data?: unknown }
export interface SpecLocatorScan { readonly locators: readonly SpecBranchLocator[]; readonly invalidEntries: number }
const STATUSES: readonly SpecStatus[] = ["paused", "generating", "ready", "revising", "accepted", "cancelled", "error"];
const KEYS = ["schemaVersion", "planSessionId", "artifactPath", "status", "stateVersion", "specRevision", "stateSha256", "committedAt"];

export function isSafeSpecSessionId(value: string): boolean { return value.length > 0 && value.length <= 64 && value !== "." && value !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value); }
export function validateSpecBranchLocator(input: unknown, planRoot: string): SpecBranchLocator | null {
  if (!record(input) || !exact(input, KEYS) || input.schemaVersion !== 1 || typeof input.planSessionId !== "string" || !isSafeSpecSessionId(input.planSessionId)
    || typeof input.artifactPath !== "string" || !isAbsolute(input.artifactPath) || resolve(input.artifactPath) !== input.artifactPath
    || typeof input.status !== "string" || !STATUSES.includes(input.status as SpecStatus) || !positive(input.stateVersion) || !safe(input.specRevision)
    || typeof input.stateSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.stateSha256) || typeof input.committedAt !== "string" || !timestamp(input.committedAt)) return null;
  const root = resolve(planRoot); const expected = resolve(root, input.planSessionId, "spec");
  if (input.artifactPath !== expected || !contained(root, expected)) return null;
  return { schemaVersion: 1, planSessionId: input.planSessionId, artifactPath: expected, status: input.status as SpecStatus, stateVersion: input.stateVersion, specRevision: input.specRevision, stateSha256: input.stateSha256, committedAt: input.committedAt };
}
export function scanSpecBranchLocators(entries: readonly SpecBranchEntry[], planRoot: string): SpecLocatorScan {
  const locators: SpecBranchLocator[] = []; let invalidEntries = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) { const entry = entries[index]; if (!entry || entry.type !== "custom" || entry.customType !== SPEC_LOCATOR_CUSTOM_TYPE) continue; const locator = validateSpecBranchLocator(entry.data, planRoot); if (locator) locators.push(locator); else invalidEntries += 1; }
  return Object.freeze({ locators: Object.freeze(locators), invalidEntries });
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
function safe(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positive(value: unknown): value is number { return safe(value) && value > 0; }
function timestamp(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value; }
function contained(root: string, target: string): boolean { const path = relative(root, target); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
