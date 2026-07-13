import { sha256Text } from "../spec/schema.js";
import { sha256Json } from "../spec/source.js";
import type { CapturedSpecSource, SpecSession, SpecSourceReference } from "../spec/types.js";

export const NOW = "2026-07-12T00:00:00.000Z";
export const MARKDOWN = "# Spec\n\nBuild 😀 safely.\n";
export function source(root = "/tmp/pi-prompt-plans", id = "plan-session"): SpecSourceReference {
  const artifact = `${root}/${id}`; const annotations: unknown[] = []; const tree = { nodes: [] };
  return { planSessionId: id, planArtifactPath: artifact, planMarkdownPath: `${artifact}/plan.md`, annotationsPath: `${artifact}/annotations.json`, planDocumentRevision: 1, planStateVersion: 4, planMarkdownSha256: sha256Text("# Plan\n"), annotationsSha256: sha256Json(annotations), grillPath: `${artifact}/grill.json`, grillPointer: "#/decisionTree", grillBasedOnDocumentRevision: 1, grillStateVersion: 4, grillDecisionTreeSha256: sha256Json(tree) };
}
export function captured(root = "/tmp/pi-prompt-plans", id = "plan-session"): CapturedSpecSource { return { reference: source(root, id), planMarkdown: "# Plan\n", annotations: [], decisionTree: { nodes: [] } }; }
export function session(overrides: Partial<SpecSession> = {}): SpecSession { return { schemaVersion: 1, planSessionId: "plan-session", stateVersion: 2, specRevision: 1, status: "ready", source: source(), markdown: MARKDOWN, comments: [], ...overrides }; }
