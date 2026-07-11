import { clearCapability, createPlanApi, readCapability, requestId } from "./api.js";
import { byId, isTypingTarget } from "./dom.js";
import { createStore, openAnnotations, canAccept, canRevise, canRetryStaging } from "./store.js";
import { renderAnnotations, renderFilters, renderPlan } from "./components.js";
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
  let pendingCommentTarget = null;
  const progressFrames = ["◐", "◓", "◑", "◒"];
  const toast = (message) => { const node = byId("toast"); node.textContent = message; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.textContent = ""; }, 4000); };
  const applySnapshot = (snapshot) => {
    const previousMarkdown = store.get().snapshot?.planMarkdown;
    const next = snapshot.planMarkdown || !previousMarkdown ? snapshot : { ...snapshot, planMarkdown: previousMarkdown };
    api.setVersion(next.stateVersion); store.set({ snapshot: next });
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

  const closeComposer = () => {
    pendingCommentTarget = null;
    byId("selection-comment").value = "";
    byId("selection-composer").hidden = true;
  };
  const openComposer = (target, anchor) => {
    const snapshot = store.get().snapshot;
    if (!snapshot || !["ready", "revising", "error", "needs-input"].includes(snapshot.status)) return;
    pendingCommentTarget = target;
    const form = byId("selection-composer");
    form.hidden = false;
    const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const left = Math.max(16, Math.min(window.innerWidth - 336, (rect?.left ?? window.innerWidth / 2) + 8));
    const top = Math.max(16, Math.min(window.innerHeight - 220, (rect?.bottom ?? window.innerHeight / 2) + 10));
    form.style.left = `${left}px`; form.style.top = `${top}px`;
    byId("selection-comment").focus({ preventScroll: true });
  };

  const draw = ({ snapshot, filter, busy, selectedAnnotationIds }) => {
    if (!snapshot) return;
    const focus = captureFocus();
    byId("plan-content").hidden = false; byId("action-bar").hidden = false;
    byId("original-prompt").textContent = snapshot.originalPrompt;
    drawLiveProgress(snapshot);
    const error = byId("snapshot-error"); error.hidden = !snapshot.error; error.textContent = snapshot.error?.message ?? "";
    renderPlan(snapshot, byId("plan-tree"), openComposer, busy);
    renderFilters(byId("filters"), filter, (value) => store.set({ filter: value }), busy);
    renderAnnotations(snapshot, filter, selectedAnnotationIds, byId("annotation-list"),
      (annotation, update) => { void runAction(() => mutate(`/api/v1/annotations/${encodeURIComponent(annotation.id)}`, "PATCH", { update })); },
      (id, selected) => { const current = store.get().selectedAnnotationIds; store.set({ selectedAnnotationIds: selected ? [...new Set([...current, id])] : current.filter((value) => value !== id) }); },
      busy,
    );
    const noteCount = snapshot.annotations.length;
    byId("annotation-count").textContent = `${noteCount} ${noteCount === 1 ? "note" : "notes"}`;
    byId("notes-section").hidden = noteCount === 0;
    const revise = byId("revise-button"); revise.disabled = busy || !canRevise(snapshot); revise.textContent = "Send notes to agent";
    const retryStage = byId("retry-stage-button"); retryStage.hidden = !canRetryStaging(snapshot); retryStage.disabled = busy || !canRetryStaging(snapshot);
    byId("accept-button").disabled = busy || !canAccept(snapshot);
    for (const id of ["reopen-button", "pause-button", "cancel-button"]) byId(id).disabled = busy;
    if (!snapshot.document) closeComposer();
    restoreFocus(focus);
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
    event.preventDefault();
    void runAction(async () => {
      const body = byId("selection-comment").value.trim();
      if (!pendingCommentTarget || !body) return;
      await mutate("/api/v1/annotations", "POST", { target: pendingCommentTarget, body });
      closeComposer();
    });
  });
  byId("selection-cancel").addEventListener("click", closeComposer);
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
    if (!snapshot || !(await confirmDialog("Accept this plan?", "Pi will stage this exact revision in the editor. It will not execute until you press Enter.", "Accept & stage"))) return;
    await mutate("/api/v1/accept", "POST", { stateVersion: snapshot.stateVersion, documentRevision: snapshot.documentRevision, confirmed: true });
    finishReview(); toast("Plan staged in Pi. This review listener is closing.");
  }); });
  byId("retry-stage-button").addEventListener("click", () => { void runAction(async () => {
    const snapshot = store.get().snapshot;
    if (!snapshot || !canRetryStaging(snapshot) || !(await confirmDialog("Retry staging?", "Retry staging this exact accepted revision in Pi.", "Retry staging"))) return;
    await mutate("/api/v1/accept", "POST", { stateVersion: snapshot.stateVersion, documentRevision: snapshot.documentRevision, confirmed: true });
    finishReview(); toast("Plan staged in Pi. This review listener is closing.");
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
function captureFocus() {
  const node = document.activeElement;
  if (!(node instanceof HTMLElement)) return null;
  const selection = node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? { start: node.selectionStart, end: node.selectionEnd } : undefined;
  return { key: node.dataset.focusKey, id: node.id, selection };
}
function restoreFocus(saved) {
  if (!saved) return;
  const node = saved.key ? [...document.querySelectorAll("[data-focus-key]")].find((candidate) => candidate.dataset.focusKey === saved.key) : saved.id ? document.getElementById(saved.id) : null;
  if (!(node instanceof HTMLElement) || node.hasAttribute("disabled")) return;
  node.focus({ preventScroll: true });
  if (saved.selection && (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)) node.setSelectionRange(saved.selection.start, saved.selection.end);
}
