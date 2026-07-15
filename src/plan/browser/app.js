import { clearCapability, createPlanApi, readCapability, requestId } from "./api.js";
import { byId, isTypingTarget } from "./dom.js";
import {
  createStore, stageAvailability, stageBusy, openAnnotations, canRevise, canRunGrill, canRetryGeneration,
  isAwaitingClarification, openSpecComments, canGenerateSpec, canGenerateFreshSpec, canReviseSpec, canAcceptSpec,
  canRetrySpecStaging, specIsStale, allOpenGrillAnnotationIds, selectedOpenGrillAnnotationIds, canAddressGrillFeedback, revisionRequestPayload,
} from "./store.js";
import { renderClarification, renderPlan, renderSpec } from "./components.js";
import { selectionTarget } from "./range.js";

const capability = readCapability();
if (!capability) byId("auth-lost").hidden = false;
else {
  const api = createPlanApi(capability); const store = createStore();
  let planSequence = 0; let specSequence = 0; let stopped = false; let progressFrame = 0; let composerState = null; const enteredAgentWork = createAgentWorkTransitionTracker();
  const progressFrames = ["◐", "◓", "◑", "◒"];
  const toast = (message) => { const node = byId("toast"); node.textContent = message; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.textContent = ""; }, 4000); };
  const closeComposer = (restore = true) => { const saved = composerState?.returnFocus; composerState = null; byId("selection-comment").value = ""; byId("selection-composer").hidden = true; if (restore) restoreFocus(saved); };
  const snapshots = createSnapshotCoordinator({ api, store, enteredAgentWork, closeComposer, scrollToTop: () => window.scrollTo({ top: 0, behavior: "auto" }) });
  const { applyPlanSnapshot, applySpecSnapshot, refreshPlan, refreshSpec } = snapshots;
  const mutatePlan = async (path, method, body) => {
    const epoch = snapshots.beginPlanRequest();
    try { const result = await api.mutate(path, method, { requestId: requestId(), ...body }); if (result?.snapshot) applyPlanSnapshot(result.snapshot, epoch); return result; }
    catch (error) { if (error && typeof error === "object") error.snapshotEpoch = epoch; throw error; }
  };
  const mutateSpec = async (path, method, body) => {
    const epoch = snapshots.beginSpecRequest();
    try { const result = await api.specMutate(path, method, { requestId: requestId(), ...body }); if (result?.snapshot) applySpecSnapshot(result.snapshot, epoch); return result; }
    catch (error) { if (error && typeof error === "object") error.snapshotEpoch = epoch; throw error; }
  };
  const finishReview = () => { clearCapability(); stopped = true; };
  const runAction = async (operation) => {
    if (store.get().busy || stopped) return; const actionFocus = captureFocus(); store.set({ busy: true });
    try { await operation(); }
    catch (error) {
      if (error?.snapshot) error.kind === "spec" ? applySpecSnapshot(error.snapshot, error.snapshotEpoch) : applyPlanSnapshot(error.snapshot, error.snapshotEpoch);
      else { try { error?.kind === "spec" ? await refreshSpec() : await refreshPlan(); } catch { /* retain the newest canonical snapshots */ } }
      toast(typeof error?.message === "string" ? error.message : "The action could not be completed.");
    } finally { store.set({ busy: false }); restoreFocus(actionFocus); }
  };
  const positionComposer = (anchor) => {
    const form = byId("selection-composer"); form.hidden = false; const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor; const width = Math.min(400, window.innerWidth - 24); const height = Math.min(340, window.innerHeight - 24);
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, (rect?.left ?? window.innerWidth / 2) + 8)); const top = Math.max(12, Math.min(window.innerHeight - height - 12, (rect?.bottom ?? window.innerHeight / 2) + 10)); form.style.left = `${left}px`; form.style.top = `${top}px`;
  };
  const openComposer = (stage, target, anchor) => {
    const current = store.get(); const snapshot = current.snapshot;
    if (!snapshot || stage === "spec" && current.specSnapshot?.status !== "ready" || stage !== "spec" && isAwaitingClarification(snapshot)) return;
    composerState = { stage, mode: "create", target, returnFocus: captureFocus() }; byId("selection-provenance").textContent = "Your comment"; byId("selection-label").textContent = `Add a comment to this ${stage === "spec" ? "Spec" : "Plan"} selection`; byId("selection-comment").value = "";
    byId("selection-revision-label").hidden = true; byId("selection-status").hidden = true; byId("selection-save").hidden = false; positionComposer(anchor); syncComposer(current); byId("selection-comment").focus({ preventScroll: true });
  };
  const openItem = (stage, item, anchor) => {
    const generated = stage !== "spec" && item.author === "grill"; composerState = { stage, mode: "edit", itemId: item.id, returnFocus: captureFocus() };
    byId("selection-provenance").textContent = generated ? "Adversarial Review finding" : "Your comment"; byId("selection-label").textContent = generated ? `Generated finding (${item.status})` : `Edit ${stage === "spec" ? "Spec comment" : "Plan comment"} (${item.status})`; byId("selection-comment").value = item.body;
    const selected = stage === "spec" ? store.get().selectedSpecCommentIds.includes(item.id) : generated ? store.get().selectedGrillAnnotationIds.includes(item.id) : store.get().selectedAnnotationIds.includes(item.id); byId("selection-revision").checked = selected;
    byId("selection-revision-label").hidden = item.status !== "open"; byId("selection-revision-text").textContent = generated ? "Address in next Plan revision" : "Include in next revision"; byId("selection-save").hidden = generated; const status = byId("selection-status"); status.hidden = item.status === "orphaned" || item.status === "addressed"; status.textContent = item.status === "dismissed" ? "Reopen" : "Dismiss";
    positionComposer(anchor); syncComposer(store.get()); (generated && item.status === "open" ? byId("selection-revision") : generated ? status : byId("selection-comment")).focus({ preventScroll: true });
  };
  const currentComposerItem = (state) => composerState?.stage === "spec" ? state.specSnapshot?.comments.find((item) => item.id === composerState.itemId) : state.snapshot?.annotations.find((item) => item.id === composerState.itemId);
  const syncComposer = (state) => {
    if (!composerState) return; const item = composerState.mode === "edit" ? currentComposerItem(state) : null; const generated = composerState.stage !== "spec" && item?.author === "grill"; const disabled = state.busy || Boolean(item?.locked);
    byId("selection-comment").disabled = disabled || generated; byId("selection-revision").disabled = disabled; byId("selection-status").disabled = disabled; byId("selection-save").disabled = disabled;
  };

  const draw = (state) => {
    const { snapshot, specSnapshot, busy, activeStage, clarificationDraft } = state; if (!snapshot) return; const focus = captureFocus(); const availability = stageAvailability(snapshot); const awaiting = isAwaitingClarification(snapshot);
    byId("plan-content").hidden = false; byId("action-bar").hidden = false; byId("original-prompt").textContent = snapshot.originalPrompt;
    byId("plan-context").textContent = `Plan ${snapshot.id} · revision ${snapshot.documentRevision}`;
    for (const stage of ["plan", "grill", "spec"]) {
      const button = byId(`stage-${stage}`); const available = availability[stage]; const current = activeStage === stage; const working = stageBusy(stage, snapshot, specSnapshot) || busy && current;
      button.disabled = !available || busy; button.setAttribute("aria-current", current ? "step" : "false"); button.classList.toggle("is-busy", working);
      byId(`stage-${stage}-state`).textContent = current ? working ? "Current · busy" : "Current" : working ? "Busy" : available ? stage === "plan" ? "Available" : stage === "grill" && snapshot.grill ? "Complete" : stage === "spec" && specSnapshot?.markdown ? "Generated" : "Available" : "Unavailable";
    }
    const planView = activeStage !== "spec"; byId("plan-tree").hidden = !planView; byId("spec-tree").hidden = planView;
    const agentWorking = agentWorkIdentity(snapshot, specSnapshot) !== null; const documentSurface = byId("document-surface"); const workOverlay = byId("agent-work-overlay"); documentSurface.setAttribute("aria-busy", String(agentWorking)); workOverlay.hidden = !agentWorking; byId("agent-work-label").textContent = agentWorkLabel(snapshot, specSnapshot);
    if (planView) renderPlan(snapshot, byId("plan-tree"), () => undefined, (item, anchor) => openItem(activeStage, item, anchor), busy, activeStage, activeStage === "grill" ? state.selectedGrillAnnotationIds : [], (id) => {
      const selected = store.get().selectedGrillAnnotationIds; store.set({ selectedGrillAnnotationIds: selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id] });
    });
    else renderSpec(specSnapshot, byId("spec-tree"), (item, anchor) => openItem("spec", item, anchor), busy);
    const visibleCount = activeStage === "spec" ? specSnapshot?.comments.length ?? 0 : snapshot.annotations.filter((note) => activeStage === "grill" || note.author !== "grill").length;
    byId("annotation-count").textContent = `${visibleCount} ${visibleCount === 1 ? "comment" : "comments"}`;
    const labels = activeStage === "plan" ? ["Durable original", "Plan · Review and annotate", "Your selected-text comments stay attached to this durable Plan revision."] : activeStage === "grill" ? ["Adversarial overlay", "Adversarial Review · Same Plan, challenged", "Generated findings are immutable overlays on the same Plan. Your comments remain editable."] : ["Independent artifact", "To Spec · Implementation specification", "This separately versioned Markdown Spec has its own comments, revisions, and acceptance."];
    byId("stage-eyebrow").textContent = labels[0]; byId("stage-heading").textContent = labels[1]; byId("stage-description").textContent = labels[2];
    const errorValue = activeStage === "spec" ? specSnapshot?.error : snapshot.error; const stale = activeStage === "spec" && specIsStale(snapshot, specSnapshot); const error = byId("snapshot-error"); error.hidden = !errorValue && !stale; error.textContent = stale ? "This Spec source is stale because its Plan or Adversarial Review changed. Generate a fresh Spec from the current Plan and Adversarial Review." : errorValue ? `${errorValue.message} (${errorValue.code})` : "";
    const clarification = byId("clarification-section"); clarification.hidden = activeStage !== "plan" || !snapshot.clarification; renderClarification(snapshot, byId("clarification-questions"), clarificationDraft, (questionId, answer) => { const current = store.get().clarificationDraft; if (current) store.set({ clarificationDraft: { id: current.id, answers: { ...current.answers, [questionId]: answer } } }); }, busy); byId("clarification-submit").disabled = busy || !snapshot.clarification;
    drawProgress(snapshot, specSnapshot, activeStage);
    byId("plan-lifecycle-actions").hidden = activeStage === "spec"; byId("plan-stage-actions").hidden = activeStage === "spec"; byId("spec-stage-actions").hidden = activeStage !== "spec";
    const revise = byId("revise-button"); revise.hidden = activeStage !== "plan" || awaiting; revise.disabled = busy || awaiting || !canRevise(snapshot); revise.textContent = snapshot.status === "error" && snapshot.document ? "Retry Plan revision" : "Revise Plan from comments";
    const grillControls = byId("grill-feedback-controls"); grillControls.hidden = activeStage !== "grill"; const openGrillIds = allOpenGrillAnnotationIds(snapshot); const selectedGrill = selectedOpenGrillAnnotationIds(snapshot, state.selectedGrillAnnotationIds); const grillBusy = busy || Boolean(snapshot.job); byId("grill-selection-count").textContent = `${selectedGrill.length} of ${openGrillIds.length} open ${openGrillIds.length === 1 ? "finding" : "findings"} selected`; byId("grill-select-all").disabled = grillBusy || openGrillIds.length === 0 || selectedGrill.length === openGrillIds.length; byId("grill-clear-selection").disabled = grillBusy || selectedGrill.length === 0; byId("grill-revision-instruction").disabled = grillBusy; byId("address-grill-feedback").disabled = grillBusy || !canAddressGrillFeedback(snapshot, state.selectedGrillAnnotationIds);
    const retry = byId("retry-generation-button"); retry.hidden = activeStage !== "plan" || !canRetryGeneration(snapshot); retry.disabled = busy || !canRetryGeneration(snapshot);
    const runGrill = byId("run-grill-button"); const grillRunnable = canRunGrill(snapshot, specSnapshot); runGrill.hidden = activeStage !== "plan" || !grillRunnable; runGrill.disabled = busy || !grillRunnable; runGrill.textContent = snapshot.grill || snapshot.status === "error" ? "Retry Adversarial Review" : "Run Adversarial Review";
    const toSpec = byId("to-spec-button"); toSpec.hidden = activeStage !== "grill" || !availability.spec; toSpec.disabled = busy || !availability.spec;
    for (const id of ["reopen-button", "pause-button", "cancel-button"]) byId(id).disabled = busy;
    const staleSpec = specIsStale(snapshot, specSnapshot); const freshSpec = canGenerateFreshSpec(snapshot, specSnapshot); const generateSpec = canGenerateSpec(specSnapshot); const generate = byId("spec-generate-button"); generate.hidden = !freshSpec && !generateSpec; generate.disabled = busy || !freshSpec && (!generateSpec || staleSpec); generate.textContent = freshSpec ? "Generate fresh Spec" : specSnapshot?.status === "error" ? "Retry Spec generation" : "Generate Spec";
    const reviseSpec = byId("spec-revise-button"); reviseSpec.hidden = !canReviseSpec(specSnapshot); reviseSpec.disabled = busy || staleSpec || !canReviseSpec(specSnapshot); reviseSpec.textContent = specSnapshot?.status === "error" ? "Retry Spec revision" : "Revise Spec from comments";
    const acceptSpec = byId("spec-accept-button"); acceptSpec.hidden = !canAcceptSpec(specSnapshot); acceptSpec.disabled = busy || staleSpec || !canAcceptSpec(specSnapshot);
    const retrySpecStage = byId("spec-retry-stage-button"); retrySpecStage.hidden = !canRetrySpecStaging(specSnapshot); retrySpecStage.disabled = busy || !canRetrySpecStaging(specSnapshot);
    byId("spec-pause-button").disabled = busy || !specSnapshot || ["accepted", "cancelled", "paused"].includes(specSnapshot.status); byId("spec-cancel-button").disabled = busy || !specSnapshot || ["accepted", "cancelled"].includes(specSnapshot.status);
    syncComposer(state); if (composerState?.stage === "spec" && !specSnapshot?.markdown || composerState?.stage !== "spec" && !snapshot.document) closeComposer(false); restoreFocus(focus);
  };
  store.subscribe(draw);

  function drawProgress(snapshot, specSnapshot, stage) {
    const spec = stage === "spec"; const job = spec ? specSnapshot?.job : snapshot.job; const activity = spec ? null : snapshot.activity; const live = byId("live-progress"); const relevant = spec ? job || specSnapshot?.error : job || activity || snapshot.error; live.hidden = !relevant; if (!relevant) return;
    const running = Boolean(job); const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; byId("progress-spinner").textContent = !running || reduceMotion ? "•" : progressFrames[progressFrame++ % progressFrames.length];
    byId("progress-eyebrow").textContent = spec ? "To Spec" : job?.operation === "grill" ? "Adversarial Review" : "Thinking";
    const failure = spec ? !job && specSnapshot?.error : !job && snapshot.error; byId("progress-headline").textContent = failure ? `${spec ? "Spec" : job?.operation === "grill" ? "Adversarial Review" : "Plan"} generation needs attention` : spec ? job?.operation === "revision" ? "Revising the Spec" : "Generating the Spec" : job?.operation === "grill" ? "Reviewing the current Plan adversarially" : activity?.headline ?? "Planning is starting";
    byId("progress-detail").textContent = failure ? failure.message : spec ? "Building the independent implementation Spec from the exact Plan and Adversarial Review source." : activity?.progress?.summary ?? activity?.summary ?? (job?.operation === "grill" ? "Generating immutable, evidence-backed findings without rewriting the Plan." : "Preparing the planning run.");
    const startedAt = spec ? job?.startedAt : activity?.startedAt ?? job?.startedAt; byId("progress-elapsed").textContent = elapsedSince(startedAt, running ? undefined : activity?.updatedAt); byId("progress-budget").textContent = spec ? "—" : `${activity?.overBudget ? "Over " : ""}${activity?.budgetMinutes ?? "—"} min`;
  }

  for (const stage of ["plan", "grill", "spec"]) byId(`stage-${stage}`).addEventListener("click", () => { void runAction(async () => { if (stage === "spec") await refreshSpec(); store.set({ activeStage: stage }); byId("stage-content").focus({ preventScroll: true }); }); });
  byId("to-spec-button").addEventListener("click", () => byId("stage-spec").click());
  byId("run-grill-button").addEventListener("click", () => { void runAction(async () => { await mutatePlan("/api/v1/grill-runs", "POST", {}); store.set({ activeStage: "grill" }); toast("Adversarial Review started against this exact Plan revision."); }); });
  byId("selection-composer").addEventListener("submit", (event) => { event.preventDefault(); void runAction(async () => {
    const body = byId("selection-comment").value.trim(); if (!composerState || !body) return; const state = store.get();
    if (composerState.stage === "spec") {
      if (composerState.mode === "create") await mutateSpec("/api/v1/spec/comments", "POST", { ...composerState.target, body });
      else { const item = currentComposerItem(state); if (item && item.body !== body) await mutateSpec(`/api/v1/spec/comments/${encodeURIComponent(item.id)}`, "PATCH", { body }); }
    } else if (composerState.mode === "create") await mutatePlan("/api/v1/annotations", "POST", { target: composerState.target, body });
    else { const item = currentComposerItem(state); if (item?.author !== "grill" && item?.body !== body) await mutatePlan(`/api/v1/annotations/${encodeURIComponent(item.id)}`, "PATCH", { update: { body } }); }
    closeComposer();
  }); });
  byId("selection-cancel").addEventListener("click", () => closeComposer());
  byId("selection-revision").addEventListener("change", () => { if (composerState?.mode !== "edit") return; const item = currentComposerItem(store.get()); const key = composerState.stage === "spec" ? "selectedSpecCommentIds" : item?.author === "grill" ? "selectedGrillAnnotationIds" : "selectedAnnotationIds"; const current = store.get()[key]; const id = composerState.itemId; store.set({ [key]: byId("selection-revision").checked ? [...new Set([...current, id])] : current.filter((value) => value !== id) }); });
  byId("selection-status").addEventListener("click", () => { void runAction(async () => { if (composerState?.mode !== "edit") return; const item = currentComposerItem(store.get()); if (!item) return; const status = item.status === "dismissed" ? "open" : "dismissed"; if (composerState.stage === "spec") await mutateSpec(`/api/v1/spec/comments/${encodeURIComponent(item.id)}/status`, "PATCH", { status }); else { await mutatePlan(`/api/v1/annotations/${encodeURIComponent(item.id)}`, "PATCH", { update: { status } }); if (item.author === "grill" && status !== "open") store.set({ selectedGrillAnnotationIds: store.get().selectedGrillAnnotationIds.filter((id) => id !== item.id) }); } closeComposer(); }); });

  const selectionHandler = (stage) => () => { const selected = selectionTarget(window.getSelection(), stage); if (!selected.ok) return; const selection = window.getSelection(); const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : undefined; openComposer(stage, selected.target, rect); };
  byId("plan-tree").addEventListener("mouseup", () => selectionHandler(store.get().activeStage)()); byId("spec-tree").addEventListener("mouseup", selectionHandler("spec"));
  byId("clarification-form").addEventListener("submit", (event) => { event.preventDefault(); void runAction(async () => { const current = store.get(); const pending = current.snapshot?.clarification; const draft = current.clarificationDraft; const error = byId("clarification-error"); if (!pending || !draft || draft.id !== pending.id) return; const answers = [];
    for (const question of pending.questions) { const answer = draft.answers[question.id]; if (!answer || answer.kind === "custom" && !answer.text.trim()) { error.textContent = "Answer every question before continuing."; error.hidden = false; document.querySelector(`[data-focus-key^="clarification-${pending.id}-${question.id}-"]`)?.focus(); return; } answers.push({ questionId: question.id, answer: answer.kind === "custom" ? { kind: "custom", text: answer.text.trim() } : answer }); }
    error.hidden = true; await mutatePlan("/api/v1/clarification-answers", "POST", { clarificationId: pending.id, answers });
  }); });
  byId("revise-button").addEventListener("click", () => { void runAction(async () => { const current = store.get(); const snapshot = current.snapshot; if (!snapshot) return; const openIds = new Set(openAnnotations(snapshot).map((note) => note.id)); const selected = current.selectedAnnotationIds.filter((id) => openIds.has(id)); await mutatePlan("/api/v1/revision-requests", "POST", { selectedAnnotationIds: selected.length ? selected : [...openIds] }); store.set({ selectedAnnotationIds: [] }); }); });
  byId("grill-select-all").addEventListener("click", () => { const snapshot = store.get().snapshot; if (snapshot) store.set({ selectedGrillAnnotationIds: allOpenGrillAnnotationIds(snapshot) }); });
  byId("grill-clear-selection").addEventListener("click", () => store.set({ selectedGrillAnnotationIds: [] }));
  byId("address-grill-feedback").addEventListener("click", () => { void runAction(async () => { const current = store.get(); if (!current.snapshot) return; const selected = selectedOpenGrillAnnotationIds(current.snapshot, current.selectedGrillAnnotationIds); if (!selected.length) return; await mutatePlan("/api/v1/revision-requests", "POST", revisionRequestPayload(selected, byId("grill-revision-instruction").value)); byId("grill-revision-instruction").value = ""; store.set({ selectedGrillAnnotationIds: [] }); }); });
  byId("retry-generation-button").addEventListener("click", () => { void runAction(async () => { await mutatePlan("/api/v1/generation-retries", "POST", {}); toast("Plan generation restarted."); }); });
  byId("spec-generate-button").addEventListener("click", () => { void runAction(async () => { const current = store.get(); const fresh = canGenerateFreshSpec(current.snapshot, current.specSnapshot); await mutateSpec(fresh ? "/api/v1/spec/fresh-generations" : "/api/v1/spec/generations", "POST", {}); if (fresh) store.set({ selectedSpecCommentIds: [] }); toast(fresh ? "Fresh Spec generation started from the current Plan and Adversarial Review." : "Spec generation started."); }); });
  byId("spec-revise-button").addEventListener("click", () => { void runAction(async () => { const current = store.get(); const openIds = new Set(openSpecComments(current.specSnapshot).map((comment) => comment.id)); const selected = current.selectedSpecCommentIds.filter((id) => openIds.has(id)); await mutateSpec("/api/v1/spec/revisions", "POST", { selectedCommentIds: selected.length ? selected : [...openIds] }); store.set({ selectedSpecCommentIds: [] }); }); });

  const confirmDialog = (title, body, buttonLabel) => new Promise((resolve) => { const dialog = byId("dialog"); byId("dialog-title").textContent = title; byId("dialog-body").textContent = body; byId("dialog-confirm").textContent = buttonLabel; const closed = () => { dialog.removeEventListener("close", closed); resolve(dialog.returnValue === "confirm"); }; dialog.addEventListener("close", closed); dialog.showModal(); });
  const acceptSpec = (retry = false) => { void runAction(async () => { const snapshot = store.get().specSnapshot; if (!snapshot || !(await confirmDialog(retry ? "Retry sending this Spec?" : "Accept and send this Spec?", "Pi will submit this exact independent Spec revision as your next message.", retry ? "Retry send" : "Accept & send Spec"))) return; await mutateSpec("/api/v1/spec/accept", "POST", { stateVersion: snapshot.stateVersion, specRevision: snapshot.specRevision, confirmed: true }); finishReview(); toast("The exact Spec revision was sent to the agent."); }); };
  byId("spec-accept-button").addEventListener("click", () => acceptSpec(false)); byId("spec-retry-stage-button").addEventListener("click", () => acceptSpec(true));
  const stopSpec = (disposition) => { void runAction(async () => { if (!(await confirmDialog(disposition === "pause" ? "Pause Spec work?" : "Cancel this Spec?", disposition === "pause" ? "The independent Spec history remains saved." : "The Spec becomes terminal; the Plan and Adversarial Review remain unchanged.", disposition === "pause" ? "Pause Spec" : "Cancel Spec"))) return; await mutateSpec("/api/v1/spec/cancel", "POST", { disposition }); }); };
  byId("spec-pause-button").addEventListener("click", () => stopSpec("pause")); byId("spec-cancel-button").addEventListener("click", () => stopSpec("cancel"));
  const stopPlan = (disposition) => { void runAction(async () => { if (!(await confirmDialog(disposition === "pause" ? "Pause Plan review?" : "Cancel this Plan?", disposition === "pause" ? "Plan history remains saved. Resume later from Pi." : "The Plan session becomes terminal, but history is retained.", disposition === "pause" ? "Pause Plan" : "Cancel Plan"))) return; await mutatePlan("/api/v1/cancel", "POST", { disposition }); finishReview(); }); };
  byId("pause-button").addEventListener("click", () => stopPlan("pause")); byId("cancel-button").addEventListener("click", () => stopPlan("cancel")); byId("reopen-button").addEventListener("click", () => { void runAction(async () => { await mutatePlan("/api/v1/reopen-in-pi", "POST", {}); finishReview(); toast("Return to Pi to continue."); }); });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("selection-composer").hidden) { event.preventDefault(); closeComposer(); return; }
    if (event.key === "Escape" && byId("dialog").open) { byId("dialog").close("cancel"); return; }
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (["ArrowLeft", "ArrowRight"].includes(event.key) && event.target?.closest?.(".stage-nav")) { const available = ["plan", "grill", "spec"].filter((stage) => !byId(`stage-${stage}`).disabled); const index = available.indexOf(store.get().activeStage); const next = available[Math.max(0, Math.min(available.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)))]; if (next) { event.preventDefault(); byId(`stage-${next}`).click(); } return; }
    if (event.key.toLowerCase() === "c") { const stage = store.get().activeStage; const selected = selectionTarget(window.getSelection(), stage); if (selected.ok) { event.preventDefault(); openComposer(stage, selected.target); } }
  });

  const progressClock = setInterval(() => { const state = store.get(); if (state.snapshot?.activity || state.snapshot?.job || state.specSnapshot?.job) drawProgress(state.snapshot, state.specSnapshot, state.activeStage); }, 250);
  const activityClock = setInterval(() => { const state = store.get(); if (!state.busy) { if (state.snapshot?.job) void refreshPlan().catch(() => undefined); if (state.activeStage === "spec" && state.specSnapshot?.job) void refreshSpec().catch(() => undefined); } }, 1000);
  window.addEventListener("pagehide", () => { clearInterval(progressClock); clearInterval(activityClock); }, { once: true });
  const pollPlan = async () => { while (!stopped) { try { const result = await api.pollEvents(planSequence); planSequence = result.currentSequence; if (result.kind === "reset" || result.events?.length) await refreshPlan(); } catch (error) { if (error?.name === "AbortError" || stopped) return; toast("Plan live updates paused; retrying."); await delay(1000); } } };
  const pollSpec = async () => { while (!stopped) { try { if (!store.get().specSnapshot) { await delay(1000); continue; } const result = await api.pollSpecEvents(specSequence); specSequence = result.currentSequence; if (result.kind === "reset" || result.events?.length) await refreshSpec(); } catch (error) { if (error?.name === "AbortError" || stopped) return; await delay(1000); } } };
  void runAction(async () => { await refreshPlan(); void pollPlan(); void pollSpec(); });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export function createSnapshotCoordinator({ api, store, enteredAgentWork, closeComposer, scrollToTop }) {
  let planRequestEpoch = 0; let specRequestEpoch = 0;
  let acceptedPlanVersion = snapshotVersion(store.get().snapshot) ?? -1; let acceptedPlanEpoch = 0;
  let acceptedSpecVersion = snapshotVersion(store.get().specSnapshot) ?? -1; let acceptedSpecEpoch = 0;
  let acceptedNonNullSpec = store.get().specSnapshot != null;
  const beginPlanRequest = () => ++planRequestEpoch;
  const beginSpecRequest = () => ++specRequestEpoch;
  const applyPlanSnapshot = (snapshot, epoch = planRequestEpoch) => {
    const version = snapshotVersion(snapshot);
    if (version === null || version < acceptedPlanVersion || version === acceptedPlanVersion && epoch < acceptedPlanEpoch) return false;
    acceptedPlanVersion = version; acceptedPlanEpoch = epoch;
    const current = store.get(); const prior = current.snapshot; const carriesMarkdown = Object.hasOwn(snapshot, "planMarkdown");
    const sameRevision = prior?.documentRevision === snapshot.documentRevision; const next = carriesMarkdown || !sameRevision || typeof prior?.planMarkdown !== "string" ? snapshot : { ...snapshot, planMarkdown: prior.planMarkdown };
    const batchId = next.clarification?.id ?? null; const clarificationDraft = current.clarificationDraft?.id === batchId ? current.clarificationDraft : batchId ? { id: batchId, answers: {} } : null;
    const workStarted = enteredAgentWork(next, current.specSnapshot);
    api.setVersion(version); store.set({ snapshot: next, clarificationDraft, ...(sameRevision ? {} : { selectedAnnotationIds: [], selectedGrillAnnotationIds: [] }) });
    if (workStarted) scrollToTop();
    if (!next.grill && current.activeStage !== "plan" || !sameRevision) closeComposer(false);
    return true;
  };
  const applySpecSnapshot = (snapshot, epoch = specRequestEpoch) => {
    if (snapshot === null) {
      if (acceptedNonNullSpec || epoch !== specRequestEpoch) return false;
      store.set({ specSnapshot: null }); return true;
    }
    const version = snapshotVersion(snapshot);
    if (version === null || version < acceptedSpecVersion || version === acceptedSpecVersion && epoch < acceptedSpecEpoch) return false;
    acceptedSpecVersion = version; acceptedSpecEpoch = epoch; acceptedNonNullSpec = true;
    const current = store.get(); const workStarted = enteredAgentWork(current.snapshot, snapshot);
    api.setSpecVersion(version); store.set({ specSnapshot: snapshot });
    if (workStarted) scrollToTop();
    return true;
  };
  const refreshPlan = async () => {
    const epoch = beginPlanRequest();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await api.snapshot(); const markdown = await api.plan();
      if (markdown === null) {
        if (snapshot?.document === null && applyPlanSnapshot(snapshot, epoch)) return snapshot;
      } else if (markdown.stateVersion === snapshot?.stateVersion) {
        const next = { ...snapshot, planMarkdown: markdown.markdown };
        return applyPlanSnapshot(next, epoch) ? next : null;
      }
    }
    return null;
  };
  const refreshSpec = async () => {
    const epoch = beginSpecRequest(); const snapshot = await api.specSnapshot();
    return applySpecSnapshot(snapshot, epoch) ? snapshot : null;
  };
  return Object.freeze({ beginPlanRequest, beginSpecRequest, applyPlanSnapshot, applySpecSnapshot, refreshPlan, refreshSpec });
}
function snapshotVersion(snapshot) { return typeof snapshot?.stateVersion === "number" && Number.isSafeInteger(snapshot.stateVersion) && snapshot.stateVersion >= 0 ? snapshot.stateVersion : null; }
export function isPlanRebuilding(snapshot) { return Boolean(snapshot && (snapshot.job?.operation === "revision" || snapshot.status === "revising")); }
export function createRebuildTransitionTracker() { let active = false; return (snapshot) => { const next = isPlanRebuilding(snapshot); const entered = next && !active; active = next; return entered; }; }
export function agentWorkIdentity(planSnapshot, specSnapshot) {
  const planJob = planSnapshot?.job; const specJob = specSnapshot?.job;
  if (planJob && typeof planJob === "object") return typeof planJob.id === "string" && planJob.id.length > 0 ? `plan:${planJob.id}` : null;
  if (specJob && typeof specJob === "object") return typeof specJob.id === "string" && specJob.id.length > 0 ? `spec:${specJob.id}` : null;
  if (["generating", "revising", "grilling"].includes(planSnapshot?.status)) return `plan-status:${planSnapshot.status}`;
  if (["generating", "revising"].includes(specSnapshot?.status)) return `spec-status:${specSnapshot.status}`;
  return null;
}
export function createAgentWorkTransitionTracker() {
  let activeIdentity = null; const observedJobs = new Set();
  return (planSnapshot, specSnapshot) => {
    const next = agentWorkIdentity(planSnapshot, specSnapshot);
    if (next === null) { activeIdentity = null; return false; }
    if (next === activeIdentity) return false;
    activeIdentity = next;
    if (next.startsWith("plan-status:") || next.startsWith("spec-status:")) return true;
    if (observedJobs.has(next)) return false;
    observedJobs.add(next); return true;
  };
}
export function agentWorkLabel(planSnapshot, specSnapshot) {
  if (planSnapshot?.job?.operation === "grill" || planSnapshot?.status === "grilling") return "Running Adversarial Review…";
  if (planSnapshot?.job?.operation === "revision" || planSnapshot?.status === "revising") return "Revising Plan…";
  if (planSnapshot?.job?.operation === "initial" || planSnapshot?.status === "generating") return "Generating Plan…";
  if (specSnapshot?.job?.operation === "revision" || specSnapshot?.status === "revising") return "Revising Spec…";
  if (specSnapshot?.job?.operation === "initial" || specSnapshot?.status === "generating") return "Generating Spec…";
  return "Agent working…";
}
function elapsedSince(startedAt, endedAt) { if (!startedAt) return "0:00"; const seconds = Math.max(0, Math.floor(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function supportsTextSelection(node) { return node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ["text", "search", "url", "tel", "password"].includes(node.type); }
export function captureFocus() { const node = document.activeElement; if (!(node instanceof HTMLElement)) return null; const selection = supportsTextSelection(node) && Number.isInteger(node.selectionStart) && Number.isInteger(node.selectionEnd) ? { start: node.selectionStart, end: node.selectionEnd } : undefined; return { key: node.dataset.focusKey, id: node.id, selection }; }
export function restoreFocus(saved) { if (!saved) return; const node = saved.key ? [...document.querySelectorAll("[data-focus-key]")].find((candidate) => candidate.dataset.focusKey === saved.key) : saved.id ? document.getElementById(saved.id) : null; if (!(node instanceof HTMLElement) || node.hasAttribute("disabled")) return; node.focus({ preventScroll: true }); if (saved.selection && supportsTextSelection(node)) node.setSelectionRange(saved.selection.start, saved.selection.end); }
