import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PlanSessionStatus } from "./types.js";

export const PLAN_LOCATOR_CUSTOM_TYPE = "pi-prompt.plan-locator.v1";

export interface PlanBranchLocator {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly artifactPath: string;
  readonly status: PlanSessionStatus;
  readonly stateVersion: number;
  readonly documentRevision: number;
  readonly stateSha256: string;
  readonly committedAt: string;
}

export type AppendPlanBranchLocator = (locator: PlanBranchLocator) => void;

export interface LocatorScan {
  readonly locators: readonly PlanBranchLocator[];
  readonly invalidEntries: number;
}

export interface PlanBranchEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

const STATUSES: readonly PlanSessionStatus[] = [
  "generating", "ready", "revising", "accepted", "paused", "cancelled", "error", "needs-input",
];
const LOCATOR_KEYS = [
  "schemaVersion", "sessionId", "artifactPath", "status", "stateVersion", "documentRevision", "stateSha256", "committedAt",
] as const;

export function isSafePlanSessionId(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && value !== "." && value !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function validatePlanBranchLocator(input: unknown, rootDir: string): PlanBranchLocator | null {
  if (!isRecord(input) || !hasExactKeys(input, LOCATOR_KEYS)) return null;
  if (input.schemaVersion !== 1 || typeof input.sessionId !== "string" || !isSafePlanSessionId(input.sessionId)) return null;
  if (typeof input.artifactPath !== "string" || !isAbsolute(input.artifactPath) || resolve(input.artifactPath) !== input.artifactPath) return null;
  if (typeof input.status !== "string" || !STATUSES.includes(input.status as PlanSessionStatus)) return null;
  if (!positiveSafeInteger(input.stateVersion) || !nonnegativeSafeInteger(input.documentRevision)) return null;
  if (typeof input.stateSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.stateSha256)) return null;
  if (typeof input.committedAt !== "string" || !isCanonicalTimestamp(input.committedAt)) return null;

  const root = resolve(rootDir);
  const expected = resolve(root, input.sessionId);
  if (input.artifactPath !== expected || !isContained(root, expected) || symlinkEscapes(root, expected)) return null;
  return {
    schemaVersion: 1, sessionId: input.sessionId, artifactPath: expected, status: input.status as PlanSessionStatus,
    stateVersion: input.stateVersion, documentRevision: input.documentRevision,
    stateSha256: input.stateSha256, committedAt: input.committedAt,
  };
}

/** Entries must be the current branch in oldest-to-newest order. Global session ordering is intentionally unsupported. */
export function scanPlanBranchLocators(entries: readonly PlanBranchEntry[], rootDir: string): LocatorScan {
  const locators: PlanBranchLocator[] = [];
  let invalidEntries = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "custom" || entry.customType !== PLAN_LOCATOR_CUSTOM_TYPE) continue;
    const locator = validatePlanBranchLocator(entry.data, rootDir);
    if (locator) locators.push(locator); else invalidEntries += 1;
  }
  return Object.freeze({ locators: Object.freeze(locators), invalidEntries });
}

export const scanLocators = scanPlanBranchLocators;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function positiveSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === "number" && value >= 1; }
function nonnegativeSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === "number" && value >= 0; }
function isCanonicalTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isContained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function symlinkEscapes(root: string, target: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    return realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`);
  } catch {
    try {
      const realRoot = realpathSync(root);
      const realParent = realpathSync(dirname(target));
      return realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`);
    } catch { return false; }
  }
}
