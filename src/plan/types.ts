export type GenerationMode =
  | "quick-win"
  | "normal"
  | "careful"
  | "hard-thinker"
  | "fully-orchestrated";

export type ExecutionKind = { readonly kind: "normal" } | { readonly kind: "goal" } | { readonly kind: "loop" };
export type PlanSessionStatus = "generating" | "ready" | "revising" | "accepted" | "paused" | "cancelled" | "error" | "needs-input";

/** Private generation input. It must never be copied into a browser snapshot. */
export interface SkillReference {
  readonly name: string;
  readonly path: string;
  readonly baseDir: string;
  readonly sha256: string;
}
export interface PlanSource { readonly prompt: string; readonly cwd: string; readonly skills: readonly SkillReference[] }
export interface SafeError { readonly code: string; readonly message: string }

export interface GenerationJob {
  readonly jobId: string;
  readonly operation: "initial" | "revision";
  readonly baseDocumentRevision: number;
  readonly selectedAnnotationIds: readonly string[];
  readonly instruction?: string;
  readonly startedAt: string;
}
export const PLAN_ELEMENT_KINDS = [
  "title", "execution", "outcome", "orientation", "constraint", "non-goal", "acceptance-criterion", "affected-area",
  "milestone", "step", "verification", "risk", "unknown", "alternative", "decision", "release", "rollback",
] as const;
export type PlanElementKind = (typeof PLAN_ELEMENT_KINDS)[number];

export interface PlanElement {
  readonly id: string;
  readonly kind: PlanElementKind;
  readonly title?: string;
  readonly body: string;
  readonly children: readonly PlanElement[];
}
export interface PlanDocument { readonly id: string; readonly title: PlanElement; readonly elements: readonly PlanElement[] }

export interface ModelPlanElementDraft {
  readonly kind: PlanElementKind;
  readonly title?: string;
  readonly body: string;
  readonly children: readonly ModelPlanElementDraft[];
}
export interface ModelRevisionPlanElementDraft {
  readonly retainedId?: string;
  readonly kind: PlanElementKind;
  readonly title?: string;
  readonly body: string;
  readonly children: readonly ModelRevisionPlanElementDraft[];
}
export interface ModelPlanDocumentDraft {
  readonly title: ModelPlanElementDraft;
  readonly elements: readonly ModelPlanElementDraft[];
}
export interface ModelRevisionPlanDocumentDraft {
  readonly retainedId?: string;
  readonly title: ModelRevisionPlanElementDraft;
  readonly elements: readonly ModelRevisionPlanElementDraft[];
}
export interface InitialPlanResultDraft { readonly kind: "plan"; readonly document: ModelPlanDocumentDraft }
export interface RevisionPlanResultDraft {
  readonly kind: "revision";
  readonly document: ModelRevisionPlanDocumentDraft;
  readonly addressedAnnotationIds: readonly string[];
}
export interface TextSelector {
  readonly field: "title" | "body";
  readonly start: number;
  readonly end: number;
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
}
export type AnnotationTarget =
  | { readonly kind: "root"; readonly elementId: string }
  | { readonly kind: "element"; readonly elementId: string }
  | { readonly kind: "range"; readonly elementId: string; readonly selector: TextSelector };
export interface AnnotationTargetSnapshot {
  readonly documentRevision: number;
  readonly target: AnnotationTarget;
  readonly elementKind: "root" | PlanElementKind;
  readonly text: string;
}
export type AnnotationStatus = "open" | "addressed" | "dismissed" | "orphaned";
export interface AnnotationHistoryEntry {
  readonly from: AnnotationStatus;
  readonly to: AnnotationStatus;
  readonly at: string;
}
export interface Annotation {
  readonly id: string;
  readonly target: AnnotationTarget;
  readonly targetSnapshot: AnnotationTargetSnapshot;
  readonly body: string;
  readonly status: AnnotationStatus;
  readonly statusBeforeOrphan?: Exclude<AnnotationStatus, "orphaned">;
  readonly history: readonly AnnotationHistoryEntry[];
  readonly createdAgainstRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PlanSessionBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly stateVersion: number;
  readonly status: PlanSessionStatus;
  readonly source: PlanSource;
  readonly execution: ExecutionKind;
  readonly generation: { readonly mode: GenerationMode };
  readonly generationJob?: GenerationJob;
  readonly lastError?: SafeError;
}
export interface EmptyPlanSession extends PlanSessionBase {
  readonly documentRevision: 0;
  readonly document: null;
  readonly annotations: readonly [];
}
export interface MaterializedPlanSession extends PlanSessionBase {
  readonly documentRevision: number;
  readonly document: PlanDocument;
  readonly annotations: readonly Annotation[];
}
export type PlanSession = EmptyPlanSession | MaterializedPlanSession;

export interface ValidationIssue { readonly path: string; readonly code: string; readonly message: string }
export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
