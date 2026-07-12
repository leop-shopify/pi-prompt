import { clearCapability, createPlanApi, readCapability, requestId } from "./api.js";
import { byId, isTypingTarget } from "./dom.js";
import { createStore, openAnnotations, canAccept, canRevise, canRetryStaging, isAwaitingClarification } from "./store.js";
import { renderClarification, renderPlan } from "./components.js";
import { selectionTarget } from "./range.js";

const capability = readCapability();
if (!capability) {
  byId("auth-lost").hidden = false;
} else {
  const api = createPlanApi(capability);
  const store = createStore();
  let sequence = 0;
  let stopped = false;
  let progressFrame = 0;
  let composerState = null;
  const progressFrames = ["◐", "◓", "◑", "◒"];
  const toast = (message) => { const node = byId("toast"); node.textContent = message; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.textContent = ""; }, 4000); };
  const applySnapshot = (snapshot) => {
    const current = store.get(); const previousMarkdown = current.snapshot?.planMarkdown;
    const next = snapshot.planMarkdown || !previousMarkdown ? snapshot : { ...snapshot, planMarkdown: previousMarkdown };
    const batchId = next.clarification?.id ?? null;
    const clarificationDraft = current.clarificationDraft?.id === batchId ? current.clarificationDraft : batchId ? { id: batchId, answers: {} } : null;
    api.setVersion(next.stateVersion); store.set({ snapshot: next, clarificationDraft });
  };
  const refresh = async () => {
    const snapshot = await api.snapshot();
    const markdown = await api.plan();
    applySnapshot(markdown ? { ...snapshot, planMarkdown: markdown } : snapshot);
  };
  const mutate = async (path, method, body) => {
    const result = await api.mutate(path, method, { requestId: requestId(), ...body });
    if (result?.snapshot) applySnapshot(result.snapshot);
    return result;
  };
  const finishReview = () => { clearCapability(); stopped = true; };
  const runAction = async (operation) => {
    if (store.get().busy || stopped) return;
    const actionFocus = captureFocus();
    store.set({ busy: true });
    try { await operation(); }
    catch (error) {
      if (error?.snapshot) applySnapshot(error.snapshot);
      else { try { await refresh(); } catch { /* retain the last canonical snapshot */ } }
      toast(typeof error?.message === "string" ? error.message : "The action could not be completed.");
    } finally {
      store.set({ busy: false });
      restoreFocus(actionFocus);
    }
  };

  const closeComposer = () => { composerState = null; byId("selection-comment").value = ""; byId("selection-composer").hidden = true; };
  const positionComposer = (anchor) => { const form = byId("selection-composer"); form.hidden = false; const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor; const left = Math.max(16, Math.min(window.innerWidth - 336, (rect?.left ?? window.innerWidth / 2) + 8)); const top = Math.max(16, Math.min(window.innerHeight - 260, (rect?.bottom ?? window.innerHeight / 2) + 10)); form.style.left = `${left}px`; form.style.top = `${top}px`; };
  const openComposer = (target, anchor) => {
    const snapshot = store.get().snapshot; if (!snapshot || isAwaitingClarification(snapshot) || !["ready", "revising", "error", "needs-input"].includes(snapshot.status)) return;
    composerState = { mode: "create", target }; byId("selection-label").textContent = "Add a note to this selection"; byId("selection-comment").value = "";
    byId("selection-revision-label").hidden = true; byId("selection-status").hidden = true; positionComposer(anchor); byId("selection-comment").focus({ preventScroll: true });
  };
  const openAnnotation = (annotation, anchor) => {
    const snapshot = store.get().snapshot; if (!snapshot) return; composerState = { mode: "edit", annotationId: annotation.id };
    byId("selection-label").textContent = `Edit note (${annotation.status})`; byId("selection-comment").value = annotation.body;
    const selected = store.get().selectedAnnotationIds.includes(annotation.id); byId("selection-revision").checked = selected;
    byId("selection-revision-label").hidden = annotation.status !== "open"; const status = byId("selection-status"); status.hidden = annotation.status === "orphaned"; status.textContent = ["dismissed", "addressed"].includes(annotation.status) ? "Reopen" : "Dismiss";
    positionComposer(anchor); syncComposer(snapshot, store.get().busy); byId("selection-comment").focus({ preventScroll: true });
  };
  const syncComposer = (snapshot, busy) => { if (!composerState) return; const annotation = composerState.mode === "edit" ? snapshot.annotations.find((note) => note.id === composerState.annotationId) : null; const disabled = busy || isAwaitingClarification(snapshot) || Boolean(annotation?.locked); for (const id of ["selection-comment", "selection-revision", "selection-status", "selection-save"]) byId(id).disabled = disabled; };

  const draw = ({ snapshot, busy, selectedAnnotationIds, clarificationDraft }) => {
    if (!snapshot) return; const focus = captureFocus(); const awaiting = isAwaitingClarification(snapshot);
    byId("plan-content").hidden = false; byId("action-bar").hidden = false; byId("original-prompt").textContent = snapshot.originalPrompt; drawLiveProgress(snapshot);
    const error = byId("snapshot-error"); error.hidden = !snapshot.error; error.textContent = snapshot.error?.message ?? "";
    const clarificationSection = byId("clarification-section"); clarificationSection.hidden = !snapshot.clarification;
    renderClarification(snapshot, byId("clarification-questions"), clarificationDraft, (questionId, answer) => { const current = store.get().clarificationDraft; if (!current) return; store.set({ clarificationDraft: { id: current.id, answers: { ...current.answers, [questionId]: answer } } }); }, busy);
    byId("clarification-submit").disabled = busy || !snapshot.clarification;
    renderPlan(snapshot, byId("plan-tree"), openComposer, openAnnotation, busy);
    const noteCount = snapshot.annotations.length; byId("annotation-count").textContent = `${noteCount} ${noteCount === 1 ? "note" : "notes"}`;
    const revise = byId("revise-button"); revise.hidden = awaiting; revise.disabled = busy || awaiting || !canRevise(snapshot); revise.textContent = "Send notes to agent";
    const retryStage = byId("retry-stage-button"); retryStage.hidden = awaiting || !canRetryStaging(snapshot); retryStage.disabled = busy || awaiting || !canRetryStaging(snapshot);
    const accept = byId("accept-button"); accept.hidden = awaiting; accept.disabled = busy || awaiting || !canAccept(snapshot);
    for (const id of ["reopen-button", "pause-button", "cancel-button"]) byId(id).disabled = busy;
    syncComposer(snapshot, busy); if (!snapshot.document && composerState?.mode === "edit") closeComposer(); restoreFocus(focus);
  };
  store.subscribe(draw);

  const progressClock = setInterval(() => { const snapshot = store.get().snapshot; if (snapshot?.activity || snapshot?.job) drawLiveProgress(snapshot); }, 250);
  const activityClock = setInterval(() => { const current = store.get(); if (current.snapshot?.job && !current.busy) void refresh().catch(() => undefined); }, 1000);
  window.addEventListener("pagehide", () => { clearInterval(progressClock); clearInterval(activityClock); }, { once: true });

  function drawLiveProgress(snapshot) {
    const activity = snapshot.activity;
    const live = byId("live-progress");
    live.hidden = !activity && !snapshot.job;
    if (live.hidden) return;
    const running = Boolean(snapshot.job);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    byId("progress-spinner").textContent = !running || reduceMotion ? "•" : progressFrames[progressFrame++ % progressFrames.length];
    byId("progress-headline").textContent = activity?.headline ?? "Planning is starting";
    byId("progress-detail").textContent = activity?.progress?.summary ?? activity?.summary ?? "Preparing the planning run.";
    const startedAt = activity?.startedAt ?? snapshot.job?.startedAt;
    byId("progress-elapsed").textContent = elapsedSince(startedAt, running ? undefined : activity?.updatedAt);
    byId("progress-budget").textContent = `${activity?.overBudget ? "Over " : ""}${activity?.budgetMinutes ?? "—"} min`;
  }

  byId("selection-composer").addEventListener("submit", (event) => {
    event.preventDefault(); void runAction(async () => {
      const body = byId("selection-comment").value.trim(); if (!composerState || !body) return;
      if (composerState.mode === "create") await mutate("/api/v1/annotations", "POST", { target: composerState.target, body });
      else { const annotation = store.get().snapshot?.annotations.find((note) => note.id === composerState.annotationId); if (annotation && annotation.body !== body) await mutate(`/api/v1/annotations/${encodeURIComponent(annotation.id)}`, "PATCH", { update: { body } }); }
      closeComposer();
    });
  });
  byId("selection-cancel").addEventListener("click", closeComposer);
  byId("selection-revision").addEventListener("change", () => { if (composerState?.mode !== "edit") return; const current = store.get().selectedAnnotationIds; const id = composerState.annotationId; store.set({ selectedAnnotationIds: byId("selection-revision").checked ? [...new Set([...current, id])] : current.filter((value) => value !== id) }); });
  byId("selection-status").addEventListener("click", () => { void runAction(async () => { if (composerState?.mode !== "edit") return; const annotation = store.get().snapshot?.annotations.find((note) => note.id === composerState.annotationId); if (!annotation) return; const status = ["dismissed", "addressed"].includes(annotation.status) ? "open" : "dismissed"; await mutate(`/api/v1/annotations/${encodeURIComponent(annotation.id)}`, "PATCH", { update: { status } }); closeComposer(); }); });
  byId("clarification-form").addEventListener("submit", (event) => { event.preventDefault(); void runAction(async () => {
    const current = store.get(); const pending = current.snapshot?.clarification; const draft = current.clarificationDraft; const error = byId("clarification-error"); if (!pending || !draft || draft.id !== pending.id) return;
    const answers = []; for (const question of pending.questions) { const answer = draft.answers[question.id]; if (!answer || answer.kind === "custom" && !answer.text.trim()) { error.textContent = "Answer every question before continuing."; error.hidden = false; const prefix = `clarification-${pending.id}-${question.id}-`; const first = [...document.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey?.startsWith(prefix)); first?.focus(); return; } answers.push({ questionId: question.id, answer: answer.kind === "custom" ? { kind: "custom", text: answer.text.trim() } : answer }); }
    error.hidden = true; await mutate("/api/v1/clarification-answers", "POST", { clarificationId: pending.id, answers });
  }); });
  byId("plan-tree").addEventListener("mouseup", () => {
    const selected = selectionTarget();
    if (!selected.ok) return;
    const selection = window.getSelection();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : undefined;
    openComposer(selected.target, rect);
  });

  byId("revise-button").addEventListener("click", () => { void runAction(async () => {
    const current = store.get(); const snapshot = current.snapshot; if (!snapshot) return;
    const openIds = new Set(openAnnotations(snapshot).map((note) => note.id));
    const selected = current.selectedAnnotationIds.filter((id) => openIds.has(id));
    await mutate("/api/v1/revision-requests", "POST", { selectedAnnotationIds: selected.length ? selected : [...openIds] });
    store.set({ selectedAnnotationIds: [] });
  }); });
  const confirmDialog = (title, body, buttonLabel) => new Promise((resolve) => {
    const dialog = byId("dialog"); byId("dialog-title").textContent = title; byId("dialog-body").textContent = body; byId("dialog-confirm").textContent = buttonLabel;
    const closed = () => { dialog.removeEventListener("close", closed); resolve(dialog.returnValue === "confirm"); };
    dialog.addEventListener("close", closed); dialog.showModal();
  });
  byId("accept-button").addEventListener("click", () => { void runAction(async () => {
    const snapshot = store.get().snapshot;
    if (!snapshot || !(await confirmDialog("Accept and send this plan?", "Pi will submit this exact revision as your next message and start the agent immediately.", "Accept & send"))) return;
    await mutate("/api/v1/accept", "POST", { stateVersion: snapshot.stateVersion, documentRevision: snapshot.documentRevision, confirmed: true });
    finishReview(); toast("Plan sent to the agent. This review listener is closing.");
  }); });
  byId("retry-stage-button").addEventListener("click", () => { void runAction(async () => {
    const snapshot = store.get().snapshot;
    if (!snapshot || !canRetryStaging(snapshot) || !(await confirmDialog("Retry sending?", "Submit this exact accepted revision to the agent now.", "Retry send"))) return;
    await mutate("/api/v1/accept", "POST", { stateVersion: snapshot.stateVersion, documentRevision: snapshot.documentRevision, confirmed: true });
    finishReview(); toast("Plan sent to the agent. This review listener is closing.");
  }); });
  const stop = (disposition) => { void runAction(async () => {
    if (!(await confirmDialog(disposition === "pause" ? "Pause review?" : "Cancel this plan?", disposition === "pause" ? "History remains saved. Resume later from Pi." : "The saved session becomes terminal, but history is retained.", disposition === "pause" ? "Pause" : "Cancel plan"))) return;
    await mutate("/api/v1/cancel", "POST", { disposition }); finishReview();
  }); };
  byId("pause-button").addEventListener("click", () => stop("pause")); byId("cancel-button").addEventListener("click", () => stop("cancel"));
  byId("reopen-button").addEventListener("click", () => { void runAction(async () => { await mutate("/api/v1/reopen-in-pi", "POST", {}); finishReview(); toast("Return to Pi to continue."); }); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("selection-composer").hidden) { closeComposer(); return; }
    if (event.key === "Escape" && byId("dialog").open) byId("dialog").close("cancel");
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "c") { const selected = selectionTarget(); if (selected.ok) { event.preventDefault(); openComposer(selected.target); } }
    else if (key === "r") byId("revise-button").click();
    else if (key === "a") byId("accept-button").click();
  });
  const poll = async () => { while (!stopped) { try { const result = await api.pollEvents(sequence); sequence = result.currentSequence; if (result.kind === "reset" || result.events?.length) await refresh(); } catch (error) { if (error?.name === "AbortError" || stopped) return; toast(typeof error?.message === "string" ? error.message : "Live updates paused."); await new Promise((resolve) => setTimeout(resolve, 1000)); } } };
  void runAction(async () => { await refresh(); void poll(); });
}

function elapsedSince(startedAt, endedAt) {
  if (!startedAt) return "0:00";
  const seconds = Math.max(0, Math.floor(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function label(value) { return String(value ?? "").split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" "); }
function supportsTextSelection(node) {
  return node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ["text", "search", "url", "tel", "password"].includes(node.type);
}
export function captureFocus() {
  const node = document.activeElement;
  if (!(node instanceof HTMLElement)) return null;
  const selection = supportsTextSelection(node) && Number.isInteger(node.selectionStart) && Number.isInteger(node.selectionEnd)
    ? { start: node.selectionStart, end: node.selectionEnd } : undefined;
  return { key: node.dataset.focusKey, id: node.id, selection };
}
export function restoreFocus(saved) {
  if (!saved) return;
  const node = saved.key ? [...document.querySelectorAll("[data-focus-key]")].find((candidate) => candidate.dataset.focusKey === saved.key) : saved.id ? document.getElementById(saved.id) : null;
  if (!(node instanceof HTMLElement) || node.hasAttribute("disabled")) return;
  node.focus({ preventScroll: true });
  if (saved.selection && supportsTextSelection(node)) node.setSelectionRange(saved.selection.start, saved.selection.end);
}
