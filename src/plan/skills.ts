import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SkillReference } from "./types.js";

export interface DiscoveredSkillReference {
  readonly name: string;
  readonly path: string;
  readonly baseDir: string;
}

class LoadedSkillContext {
  readonly name: string;
  readonly #body: string;
  constructor(name: string, body: string) { this.name = name; this.#body = body; Object.freeze(this); }
  get body(): string { return this.#body; }
}

export type SkillContextIssueCode =
  | "duplicate-selection"
  | "duplicate-discovery"
  | "skill-missing"
  | "skill-changed"
  | "skill-unreadable"
  | "skill-invalid-utf8"
  | "skill-digest-mismatch";

export interface SkillContextIssue {
  readonly code: SkillContextIssueCode;
  readonly name: string;
}

export type SkillContextResult =
  | { readonly ok: true; readonly references: readonly SkillReference[]; readonly contexts: readonly LoadedSkillContext[] }
  | { readonly ok: false; readonly issues: readonly SkillContextIssue[] };

export async function captureSelectedSkills(
  selectedNames: readonly string[], discovered: readonly DiscoveredSkillReference[],
): Promise<SkillContextResult> {
  const duplicateSelection = duplicates(selectedNames);
  if (duplicateSelection.length) return failure(duplicateSelection.map((name) => issue("duplicate-selection", name)));
  const indexed = indexDiscovery(discovered);
  if (!indexed.ok) return indexed;
  const selected: DiscoveredSkillReference[] = [];
  const missing: SkillContextIssue[] = [];
  for (const name of selectedNames) {
    const skill = indexed.value.get(name);
    if (skill) selected.push(skill); else missing.push(issue("skill-missing", name));
  }
  if (missing.length) return failure(missing);
  return loadAll(selected, undefined);
}

export async function reloadSavedSkills(
  saved: readonly SkillReference[], discovered: readonly DiscoveredSkillReference[],
): Promise<SkillContextResult> {
  const indexed = indexDiscovery(discovered);
  if (!indexed.ok) return indexed;
  const corroborated: DiscoveredSkillReference[] = [];
  const issues: SkillContextIssue[] = [];
  for (const reference of saved) {
    const current = indexed.value.get(reference.name);
    if (!current) { issues.push(issue("skill-missing", reference.name)); continue; }
    if (current.path !== reference.path || current.baseDir !== reference.baseDir) {
      issues.push(issue("skill-changed", reference.name)); continue;
    }
    corroborated.push(current);
  }
  if (issues.length) return failure(issues);
  return loadAll(corroborated, saved);
}

export const captureSkillContext = captureSelectedSkills;
export const reloadSkillContext = reloadSavedSkills;

async function loadAll(
  skills: readonly DiscoveredSkillReference[], expected: readonly SkillReference[] | undefined,
): Promise<SkillContextResult> {
  const references: SkillReference[] = [];
  const contexts: LoadedSkillContext[] = [];
  const issues: SkillContextIssue[] = [];
  for (let index = 0; index < skills.length; index += 1) {
    const skill = skills[index];
    if (!skill) continue;
    let bytes: Buffer;
    try { bytes = await readFile(skill.path); }
    catch { issues.push(issue("skill-unreadable", skill.name)); continue; }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let body: string;
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { issues.push(issue("skill-invalid-utf8", skill.name)); continue; }
    const expectedReference = expected?.[index];
    if (expectedReference && expectedReference.sha256 !== sha256) {
      issues.push(issue("skill-digest-mismatch", skill.name)); continue;
    }
    references.push({ name: skill.name, path: skill.path, baseDir: skill.baseDir, sha256 });
    contexts.push(new LoadedSkillContext(skill.name, body));
  }
  return issues.length ? failure(issues) : Object.freeze({ ok: true, references: Object.freeze(references), contexts: Object.freeze(contexts) });
}

function indexDiscovery(discovered: readonly DiscoveredSkillReference[]):
  | { readonly ok: true; readonly value: ReadonlyMap<string, DiscoveredSkillReference> }
  | { readonly ok: false; readonly issues: readonly SkillContextIssue[] } {
  const map = new Map<string, DiscoveredSkillReference>();
  const duplicateNames: string[] = [];
  for (const skill of discovered) {
    if (map.has(skill.name)) duplicateNames.push(skill.name); else map.set(skill.name, skill);
  }
  return duplicateNames.length
    ? failure(duplicateNames.map((name) => issue("duplicate-discovery", name)))
    : { ok: true, value: map };
}
function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>(); const duplicate = new Set<string>();
  for (const value of values) { if (seen.has(value)) duplicate.add(value); else seen.add(value); }
  return [...duplicate];
}
function issue(code: SkillContextIssueCode, name: string): SkillContextIssue { return Object.freeze({ code, name }); }
function failure(issues: readonly SkillContextIssue[]): { readonly ok: false; readonly issues: readonly SkillContextIssue[] } {
  return Object.freeze({ ok: false, issues: Object.freeze([...issues]) });
}
