import type { SafeError, ValidationResult } from "../plan/types.js";

export type SpecStatus = "paused" | "generating" | "ready" | "revising" | "accepted" | "cancelled" | "error";
export type SpecOperation = "initial" | "revision";
export type SpecCommentStatus = "open" | "addressed" | "dismissed" | "orphaned";

/** Immutable reference to the exact durable Plan and Grill projections used by Spec. */
export interface SpecSourceReference {
  readonly planSessionId: string;
  readonly planArtifactPath: string;
  readonly planMarkdownPath: string;
  readonly annotationsPath: string;
  readonly planDocumentRevision: number;
  readonly planStateVersion: number;
  readonly planMarkdownSha256: string;
  readonly annotationsSha256: string;
  readonly grillPath: string;
  readonly grillPointer: "#/decisionTree";
  readonly grillBasedOnDocumentRevision: number;
  readonly grillStateVersion: number;
  readonly grillDecisionTreeSha256: string;
}

/** Private immutable generation input. Only the reference is persisted in Spec state. */
export interface CapturedSpecSource {
  readonly reference: SpecSourceReference;
  readonly planMarkdown: string;
  readonly annotations: readonly unknown[];
  readonly decisionTree: unknown;
}

/** All offsets use Unicode code points, never UTF-16 code units or bytes. */
export interface SpecRangeTarget {
  readonly start: number;
  readonly end: number;
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly revision: number;
  readonly markdownSha256: string;
}
export interface SpecCommentHistoryEntry {
  readonly from: SpecCommentStatus;
  readonly to: SpecCommentStatus;
  readonly at: string;
}
export interface SpecComment {
  readonly id: string;
  readonly target: SpecRangeTarget;
  readonly originalTarget: SpecRangeTarget;
  readonly body: string;
  readonly status: SpecCommentStatus;
  readonly statusBeforeOrphan?: "open" | "dismissed";
  readonly history: readonly SpecCommentHistoryEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SpecGenerationJob {
  readonly jobId: string;
  readonly operation: SpecOperation;
  readonly baseSpecRevision: number;
  readonly selectedCommentIds: readonly string[];
  readonly source: SpecSourceReference;
  readonly instruction?: string;
  readonly startedAt: string;
}
export interface SpecSession {
  readonly schemaVersion: 1;
  readonly planSessionId: string;
  readonly stateVersion: number;
  readonly specRevision: number;
  readonly status: SpecStatus;
  readonly source: SpecSourceReference;
  /** Exact authenticated UTF-8 writer bytes. */
  readonly markdown: string | null;
  readonly comments: readonly SpecComment[];
  readonly generationJob?: SpecGenerationJob;
  readonly lastError?: SafeError;
}
export interface SpecBranchLocator {
  readonly schemaVersion: 1;
  readonly planSessionId: string;
  readonly artifactPath: string;
  readonly status: SpecStatus;
  readonly stateVersion: number;
  readonly specRevision: number;
  readonly stateSha256: string;
  readonly committedAt: string;
}
export interface AcceptedSpecPayload {
  readonly kind: "spec";
  readonly plan: {
    readonly sessionId: string;
    readonly artifactPath: string;
    readonly planMarkdownPath: string;
    readonly annotationsPath: string;
    readonly documentRevision: number;
    readonly stateVersion: number;
  };
  readonly grill: {
    readonly path: string;
    readonly pointer: "#/decisionTree";
    readonly basedOnDocumentRevision: number;
    readonly stateVersion: number;
  };
  readonly markdown: string;
}
export type AppendSpecBranchLocator = (locator: SpecBranchLocator) => void;
export type SpecResult<T = void> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SafeError };
export type SpecValidationResult<T> = ValidationResult<T>;
