import { join, resolve } from "node:path";
import type { PlanSession, ValidationResult } from "../plan/types.js";
import { sha256Text } from "./schema.js";
import type { CapturedSpecSource, ReviewedSpecSourceReference, SpecSourceReference } from "./types.js";

export function canonicalJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
export function sha256Json(value: unknown): string { return sha256Text(canonicalJson(value)); }

export function captureSpecSource(plan: PlanSession, planArtifactPath: string): ValidationResult<CapturedSpecSource> {
  if (!["ready", "error"].includes(plan.status) || !plan.document || !plan.committedMarkdown || plan.generationJob) return invalid("plan-not-ready", "Spec generation requires a durable Plan with exact Markdown and no active job.");
  const artifactPath = resolve(planArtifactPath);
  const planReference = {
    planSessionId: plan.id,
    planArtifactPath: artifactPath,
    planMarkdownPath: join(artifactPath, "plan.md"),
    annotationsPath: join(artifactPath, "annotations.json"),
    planDocumentRevision: plan.documentRevision,
    planStateVersion: plan.stateVersion,
    planMarkdownSha256: sha256Text(plan.committedMarkdown),
    annotationsSha256: sha256Json(plan.annotations),
  };
  const grill = plan.grill?.basedOnDocumentRevision === plan.documentRevision ? plan.grill : undefined;
  if (!grill) return { ok: true, value: Object.freeze({ reference: Object.freeze(planReference), planMarkdown: plan.committedMarkdown, annotations: plan.annotations }) };
  const reference: ReviewedSpecSourceReference = {
    ...planReference,
    grillPath: join(artifactPath, "grill.json"),
    grillPointer: "#/decisionTree",
    grillBasedOnDocumentRevision: grill.basedOnDocumentRevision,
    grillStateVersion: plan.stateVersion,
    grillDecisionTreeSha256: sha256Json(grill.decisionTree),
  };
  return { ok: true, value: Object.freeze({ reference: Object.freeze(reference), planMarkdown: plan.committedMarkdown, annotations: plan.annotations, decisionTree: grill.decisionTree }) };
}

/** Re-captures the live Plan and rejects generation if any durable source component moved. */
export function verifyFreshSpecSource(captured: CapturedSpecSource, current: PlanSession, artifactPath: string): ValidationResult<CapturedSpecSource> {
  const next = captureSpecSource(current, artifactPath);
  if (!next.ok) return next;
  return sameSpecSource(captured.reference, next.value.reference)
    ? { ok: true, value: captured }
    : invalid("stale-spec-source", "The Plan or optional Adversarial Review source changed. Capture a fresh Spec source.");
}

export function hasAdversarialReview(source: SpecSourceReference): source is ReviewedSpecSourceReference {
  return source.grillPath !== undefined;
}
export function sameSpecSource(left: SpecSourceReference | undefined, right: SpecSourceReference): boolean {
  return Boolean(left && JSON.stringify(left) === JSON.stringify(right));
}
function invalid<T>(code: string, message: string): ValidationResult<T> { return { ok: false, issues: [{ path: "$", code, message }] }; }
