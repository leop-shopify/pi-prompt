export const STAGES = Object.freeze(["plan", "grill", "spec"]);

export function createStore(initial = {}) {
  let state = Object.freeze({
    snapshot: null, specSnapshot: null, busy: false, activeStage: "plan",
    selectedAnnotationIds: [], selectedGrillAnnotationIds: [], selectedSpecCommentIds: [], clarificationDraft: null,
    ...initial,
  });
  const listeners = new Set();
  return Object.freeze({
    get: () => state,
    set(patch) {
      const candidate = { ...state, ...patch };
      candidate.activeStage = availableStage(candidate.activeStage, candidate.snapshot);
      state = Object.freeze(candidate);
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}

export function stageAvailability(snapshot) {
  const documentReady = Boolean(snapshot?.document);
  const grilling = snapshot?.job?.operation === "grill";
  const grilled = Boolean(snapshot?.grill && snapshot.grill.basedOnDocumentRevision === snapshot.documentRevision);
  return Object.freeze({ plan: true, grill: documentReady && (grilling || grilled), spec: grilled && snapshot.status === "ready" && !snapshot.job });
}
export function availableStage(requested, snapshot) {
  const available = stageAvailability(snapshot);
  return STAGES.includes(requested) && available[requested] ? requested : "plan";
}
export function stageBusy(stage, snapshot, specSnapshot) {
  if (stage === "spec") return Boolean(specSnapshot?.job);
  return Boolean(snapshot?.job && (stage === "plan" ? snapshot.job.operation !== "grill" : snapshot.job.operation === "grill"));
}
export function openAnnotations(snapshot, author = "user") { return snapshot.annotations.filter((note) => note.author === author && note.status === "open"); }
export function allOpenGrillAnnotationIds(snapshot) { return openAnnotations(snapshot, "grill").map((note) => note.id); }
export function selectedOpenGrillAnnotationIds(snapshot, selectedIds) {
  const openIds = new Set(allOpenGrillAnnotationIds(snapshot));
  return [...new Set(selectedIds.filter((id) => openIds.has(id)))];
}
export function canAddressGrillFeedback(snapshot, selectedIds) {
  return Boolean(snapshot && ["ready", "error"].includes(snapshot.status) && snapshot.document && !snapshot.job && selectedOpenGrillAnnotationIds(snapshot, selectedIds).length > 0);
}
export function revisionRequestPayload(selectedAnnotationIds, instruction) {
  const trimmed = instruction.trim(); return { selectedAnnotationIds: [...selectedAnnotationIds], ...(trimmed ? { instruction: trimmed } : {}) };
}
export function canRevise(snapshot) { return ["ready", "error"].includes(snapshot.status) && snapshot.document !== null && !snapshot.job && (snapshot.status === "error" || openAnnotations(snapshot).length > 0); }
export function canAccept(snapshot) { return snapshot.status === "ready" && !snapshot.job && snapshot.document !== null; }
export function canRetryStaging(snapshot) { return snapshot.status === "accepted" && snapshot.actions?.canRetryStaging === true && !snapshot.job && !snapshot.clarification; }
export function canRunGrill(snapshot, specSnapshot) {
  return Boolean(snapshot && ["ready", "error"].includes(snapshot.status) && snapshot.document && !snapshot.job && !snapshot.clarification
    && (!snapshot.grill || snapshot.status === "error" || specIsStale(snapshot, specSnapshot)));
}
export function canRetryGeneration(snapshot) { return snapshot.status === "error" && snapshot.document === null && snapshot.actions?.canRetryGeneration === true && !snapshot.job && !snapshot.clarification; }
export function isAwaitingClarification(snapshot) { return snapshot.status === "awaiting-clarification" && Boolean(snapshot.clarification); }
export function openSpecComments(snapshot) { return snapshot?.comments?.filter((comment) => comment.status === "open") ?? []; }
export function canGenerateSpec(snapshot) { return Boolean(snapshot && !snapshot.job && snapshot.markdown === null && ["paused", "error"].includes(snapshot.status)); }
export function canGenerateFreshSpec(planSnapshot, specSnapshot) { return Boolean(specIsStale(planSnapshot, specSnapshot) && !specSnapshot.job && ["paused", "ready", "error"].includes(specSnapshot.status)); }
export function canReviseSpec(snapshot) { return Boolean(snapshot && !snapshot.job && snapshot.markdown !== null && ["ready", "error"].includes(snapshot.status) && (snapshot.status === "error" || openSpecComments(snapshot).length > 0)); }
export function canAcceptSpec(snapshot) { return Boolean(snapshot && snapshot.status === "ready" && snapshot.markdown !== null && !snapshot.job); }
export function canRetrySpecStaging(snapshot) { return Boolean(snapshot && snapshot.status === "accepted" && snapshot.actions?.canRetryStaging && !snapshot.job); }
export function specIsStale(planSnapshot, specSnapshot) {
  if (!planSnapshot?.grill || !specSnapshot?.source) return false;
  return specSnapshot.source.planDocumentRevision !== planSnapshot.documentRevision
    || specSnapshot.source.grillBasedOnDocumentRevision !== planSnapshot.grill.basedOnDocumentRevision
    || specSnapshot.source.grillStateVersion !== planSnapshot.stateVersion;
}
