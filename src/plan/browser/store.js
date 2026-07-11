export function createStore(initial = { snapshot: null, filter: "open", busy: false, selectedAnnotationIds: [] }) {
  let state = Object.freeze({ ...initial });
  const listeners = new Set();
  return Object.freeze({
    get: () => state,
    set(patch) { state = Object.freeze({ ...state, ...patch }); for (const listener of listeners) listener(state); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}

export function openAnnotations(snapshot) { return snapshot.annotations.filter((annotation) => annotation.status === "open"); }
export function annotationCount(snapshot, elementId) { return snapshot.annotations.filter((annotation) => annotation.target.elementId === elementId).length; }
export function canRevise(snapshot) { return ["ready", "error"].includes(snapshot.status) && snapshot.document !== null && !snapshot.job && (snapshot.status === "error" || openAnnotations(snapshot).length > 0); }
export function canAccept(snapshot) { return snapshot.status === "ready" && !snapshot.job && snapshot.document !== null; }
export function canRetryStaging(snapshot) { return snapshot.status === "accepted" && snapshot.actions?.canRetryStaging === true && !snapshot.job; }
