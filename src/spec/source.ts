import { join, resolve } from "node:path";
import type { PlanSession, ValidationResult } from "../plan/types.js";
import { sha256Text } from "./schema.js";
import type { CapturedSpecSource, SpecSourceReference } from "./types.js";

export function canonicalJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
export function sha256Json(value: unknown): string { return sha256Text(canonicalJson(value)); }

export function captureSpecSource(plan: PlanSession, planArtifactPath: string): ValidationResult<CapturedSpecSource> {
  if (plan.status !== "ready" || !plan.document || !plan.committedMarkdown) return invalid("plan-not-ready", "Spec generation requires a ready durable Plan with exact Markdown.");
  if (!plan.grill || plan.grill.basedOnDocumentRevision !== plan.documentRevision) return invalid("grill-unavailable", "Spec generation requires the current Plan Adversarial Review artifact.");
  const artifactPath = resolve(planArtifactPath);
  const reference: SpecSourceReference = {
    planSessionId: plan.id,
    planArtifactPath: artifactPath,
    planMarkdownPath: join(artifactPath, "plan.md"),
    annotationsPath: join(artifactPath, "annotations.json"),
    planDocumentRevision: plan.documentRevision,
    planStateVersion: plan.stateVersion,
    planMarkdownSha256: sha256Text(plan.committedMarkdown),
    annotationsSha256: sha256Json(plan.annotations),
    grillPath: join(artifactPath, "grill.json"),
    grillPointer: "#/decisionTree",
    grillBasedOnDocumentRevision: plan.grill.basedOnDocumentRevision,
    grillStateVersion: plan.stateVersion,
    grillDecisionTreeSha256: sha256Json(plan.grill.decisionTree),
  };
  return { ok: true, value: Object.freeze({ reference: Object.freeze(reference), planMarkdown: plan.committedMarkdown, annotations: plan.annotations, decisionTree: plan.grill.decisionTree }) };
}

/** Re-captures the live Plan and rejects generation if any durable source component moved. */
export function verifyFreshSpecSource(captured: CapturedSpecSource, current: PlanSession, artifactPath: string): ValidationResult<CapturedSpecSource> {
  const next = captureSpecSource(current, artifactPath);
  if (!next.ok) return next;
  return sameSpecSource(captured.reference, next.value.reference)
    ? { ok: true, value: captured }
    : invalid("stale-spec-source", "The Plan, annotations, or Adversarial Review source changed. Capture a fresh Spec source.");
}

export function sameSpecSource(left: SpecSourceReference | undefined, right: SpecSourceReference): boolean {
  return Boolean(left && JSON.stringify(left) === JSON.stringify(right));
}
function invalid<T>(code: string, message: string): ValidationResult<T> { return { ok: false, issues: [{ path: "$", code, message }] }; }
