import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { browserLaunchCommand } from "../plan/browser-launcher.js";
import { createBrowserPlanReviewPort } from "../extension/browser-review-port.js";
import { livePlanActivity, registerLivePlanActivity, updateLivePlanActivity } from "../extension/live-activity.js";
import { GENERATION_PROFILES } from "../plan/modes.js";
import type { PlanController } from "../plan/controller.js";
import type { PlanSession } from "../plan/types.js";

const browserFiles = ["app.js", "api.js", "store.js", "dom.js", "components.js", "range.js"];
const state: PlanSession = {
  schemaVersion: 1, id: "session", stateVersion: 3, documentRevision: 1, status: "ready",
  source: { prompt: "ORIGINAL PRIVATE SOURCE", cwd: "/private", skills: [{ name: "security", path: "/private/SKILL.md", baseDir: "/private", sha256: "a".repeat(64) }] },
  execution: { kind: "loop" }, generation: { mode: "careful" },
  document: { id: "document", title: { id: "title", kind: "title", body: "Review", children: [] }, elements: [{ id: "execution", kind: "execution", body: "Read only", children: [] }] }, annotations: [],
};

describe("browser review client", () => {
  it("uses packaged native modules with safe DOM and port-scoped session authorization", async () => {
    const sources = await Promise.all(browserFiles.map((name) => readFile(new URL(`../plan/browser/${name}`, import.meta.url), "utf8")));
    const all = sources.join("\n");
    expect(all).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(all).not.toMatch(/localStorage|document\.cookie|indexedDB/);
    expect(sources[1]).toContain("sessionStorage");
    expect(all).not.toMatch(/https?:\/\//);
    expect(sources[0]).toContain("readCapability()");
    expect(sources[0]).toContain("const runAction = async");
    expect(sources[0]).toContain("void runAction(");
    expect(sources[0]).not.toMatch(/addEventListener\([^,]+,\s*async\s*\(/);
    expect(sources[0]).toContain("captureFocus()"); expect(sources[0]).toContain("setSelectionRange");
    expect(sources[0]).toMatch(/const actionFocus = captureFocus\(\);\s*store\.set\(\{ busy: true \}\);[\s\S]*finally \{\s*store\.set\(\{ busy: false \}\);\s*restoreFocus\(actionFocus\);/);
    expect(sources[0]).toContain("retry-generation-button"); expect(sources[0]).toContain("/api/v1/generation-retries");
    expect(sources[0]).toContain("spec-retry-stage-button"); expect(sources[0]).toContain("Retry Spec revision"); expect(sources[0]).toContain("Revise Plan from comments");
    expect(sources[0]).toContain("Accept & send Spec"); expect(sources[0]).not.toContain("It will not execute until you press Enter");
    const acceptSpecStart = sources[0].indexOf("const acceptSpec = (retry"); const acceptSpecSource = sources[0].slice(acceptSpecStart, sources[0].indexOf('byId("spec-accept-button")', acceptSpecStart));
    expect(acceptSpecSource).toMatch(/await mutateSpec\("\/api\/v1\/spec\/accept"[\s\S]*finishReview\(\);[\s\S]*toast\("The exact Spec revision was sent to the agent\."\)/u);
    expect(acceptSpecSource).not.toMatch(/finishReview\(\);[\s\S]*await mutateSpec/u);
    expect(sources[0]).toMatch(/const pollPlan = async \(\) => \{ while \(!stopped\)[\s\S]*if \(error\?\.name === "AbortError" \|\| stopped\) return; toast\("Plan live updates paused; retrying\."\)/u);
    expect(sources[0]).not.toContain("activity?.phase");
    expect(sources[0]).not.toContain("progress-model"); expect(sources[0]).not.toContain("raw thinking");
    expect(sources[0]).toContain("activity?.progress?.summary ?? activity?.summary"); expect(sources[0]).toContain("generation needs attention");
    expect(sources[0]).toContain("snapshot.originalPrompt"); expect(sources[0]).toContain("snapshot.id"); expect(sources[0]).toContain("Reviewing the current Plan adversarially");
    expect(sources[0]).toContain("createRebuildTransitionTracker"); expect(sources[0]).toContain("createAgentWorkTransitionTracker"); expect(sources[0]).toContain("agentWorkLabel"); expect(sources[0].match(/enteredAgentWork\(/gu)).toHaveLength(2); expect(sources[0]).toContain('window.scrollTo({ top: 0, behavior: "auto" })'); expect(sources[0]).toContain("agent-work-overlay");
    expect(sources[0]).toContain("progress-detail");
    expect(sources[0]).not.toContain("window.prompt(");
    expect(sources[0]).toContain("selection-composer"); expect(sources[0]).toContain("composerState"); expect(sources[0]).toContain("clarificationDraft");
    expect(sources[0]).toContain("isAwaitingClarification"); expect(sources[0]).toContain('revise.hidden = activeStage !== "plan" || awaiting'); expect(sources[0]).toContain("spec-accept-button");
    expect(sources[0]).toContain("Boolean(item?.locked)"); expect(sources[0]).toContain("selectedGrillAnnotationIds"); expect(sources[0]).toContain('revisionRequestPayload(selected, byId("grill-revision-instruction").value)');
    expect(sources[0]).toMatch(/const openComposer = [\s\S]*?positionComposer\(anchor\); syncComposer\(current\); byId\("selection-comment"\)\.focus/);
    expect(sources[0]).toContain('stage !== "spec" && isAwaitingClarification(snapshot)');
    expect(sources[0]).not.toMatch(/sidebar[^\n]*(message|chat|agent)/i);
    expect(sources[2]).toContain("canRetryGeneration"); expect(sources[2]).toContain("canRetryStaging"); expect(sources[2]).toContain("canGenerateFreshSpec"); expect(sources[2]).toContain("specIsStale(snapshot, specSnapshot)");
    expect(sources[0]).toContain("canRunGrill(snapshot, specSnapshot)"); expect(sources[0]).toContain('snapshot.grill || snapshot.status === "error" ? "Retry Adversarial Review" : "Run Adversarial Review"');
    expect(sources[4]).toContain("note.locked"); expect(sources[4]).toContain("annotation-badge"); expect(sources[4]).toContain("snapshot.planMarkdown"); expect(sources[4]).toContain("projectPlanAnnotations");
    expect(sources[4]).toContain("target.selector.end"); expect(sources[4]).toContain("[...String(text)]");
    expect(sources[4]).toContain('element("button"'); expect(sources[4]).toContain("annotation-fallback"); expect(sources[4]).toContain('role: "checkbox"'); expect(sources[4]).toContain('"aria-checked"'); expect(sources[4]).toContain("Generated text is read-only");
    expect(sources[4]).toContain('element("fieldset"'); expect(sources[4]).toContain('element("legend"'); expect(sources[4]).toContain('type: "radio"'); expect(sources[4]).toContain("Custom answer");
    expect(sources[4]).not.toContain('element("details"');
    expect(sources[0]).toContain('"/api/v1/spec/generations"'); expect(sources[0]).toContain('"/api/v1/spec/fresh-generations"'); expect(sources[0]).toContain('"Generate fresh Spec"'); expect(sources[0]).toContain('"/api/v1/spec/revisions"');
    expect(sources[1]).toContain("historyObject.replaceState(null");
    expect(sources[1]).toContain("/^#capability=");
    const shell = await readFile(new URL("../plan/html.ts", import.meta.url), "utf8");
    expect(shell).not.toContain("Refreshing removes access"); expect(shell).toContain("/prompt resume"); expect(shell).not.toContain("ORIGINAL PRIVATE SOURCE");
    expect(shell).toContain('role="alert"'); expect(shell).toContain('aria-labelledby="dialog-title"'); expect(shell).toContain('aria-describedby="dialog-body"'); expect(shell).toContain('aria-live="polite"');
    expect(shell).toContain("Current stage activity"); expect(shell).toContain('id="progress-budget"'); expect(shell).toContain('id="progress-elapsed"'); expect(shell).not.toContain('id="progress-model"'); expect(shell).not.toContain('id="progress-timeline"'); expect(shell).not.toContain("raw thinking");
    const mainStart = shell.indexOf('<main id="plan-content"'); const mainEnd = shell.indexOf("</main>", mainStart); const detail = shell.indexOf('id="progress-detail"'); const plan = shell.indexOf('id="plan-tree"');
    expect(mainStart).toBeGreaterThan(-1); expect(detail).toBeGreaterThan(mainStart); expect(detail).toBeLessThan(plan); expect(plan).toBeLessThan(mainEnd);
    expect(shell).toContain('id="original-prompt"'); expect(shell).toContain('id="plan-context"'); expect(shell).toContain('id="selection-composer"'); expect(shell).toContain('id="clarification-section"'); expect(shell).toContain('id="retry-generation-button"');
    expect(shell).toContain('aria-label="Plan workflow stages"'); expect(shell).toContain('id="stage-grill"'); expect(shell).toContain('<strong>Adversarial Review</strong>'); expect(shell).toContain('id="stage-spec"'); expect(shell).toContain('rows="5"');
    expect(shell).toContain('<button id="selection-cancel" type="button" class="quiet">Close</button>');
    expect(shell).toContain('id="document-surface"'); expect(shell).toMatch(/id="document-surface"[^\n]*id="plan-tree"[^\n]*id="spec-tree"[^\n]*id="agent-work-overlay"/u); expect(shell).toContain('role="status" aria-live="polite" hidden'); expect(shell).toContain('id="agent-work-label"'); expect(shell).toContain("Agent working…");
    expect(shell).toContain('id="grill-select-all"'); expect(shell).toContain('id="grill-clear-selection"'); expect(shell).toContain('id="grill-revision-instruction"'); expect(shell).toContain('id="address-grill-feedback"'); expect(shell).toContain("Address selected feedback");
    expect(shell).not.toContain('id="annotation-list"'); expect(shell).not.toContain('id="notes-section"');
    expect(shell).not.toContain("<aside"); expect(shell).not.toContain('id="root-comment"'); expect(shell).not.toContain("Drawing index"); expect(shell).not.toContain("Markup rail");
    const shellIds = [...shell.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]); expect(new Set(shellIds).size).toBe(shellIds.length);
    const css = await readFile(new URL("../plan/browser/styles.css", import.meta.url), "utf8");
    const compactCss = css.replace(/\s+/gu, "");
    expect(compactCss).toContain("color-scheme:dark"); expect(compactCss).toContain(".single-plan"); expect(compactCss).toContain(".annotation-badge:focus-visible"); expect(compactCss).toContain(".clarification-question");
    const toastStyles = compactCss.match(/\.toast\{([^}]*)\}/)?.[1] ?? "";
    expect(toastStyles).toContain("background:var(--surface)"); expect(toastStyles).toContain("color:var(--ink)"); expect(toastStyles).toContain("border:1pxsolidvar(--line-strong)");
    expect(toastStyles).not.toContain("background:var(--ink)"); expect(toastStyles).not.toContain("color:#fff");
    expect(compactCss).toContain("@media(max-width:700px)"); expect(compactCss).toContain("prefers-reduced-motion"); expect(compactCss).toContain("min-height:40px"); expect(compactCss).toContain(".grill-feedback-controls"); expect(compactCss).not.toContain("transition:all");
    expect(compactCss).toContain(".annotation-badge{position:relative;display:inline-grid;place-items:center;width:16px"); expect(compactCss).toContain(".document-surface{position:relative;isolation:isolate;min-height:180px"); expect(compactCss).toContain(".agent-work-overlay{position:absolute;z-index:8;inset:0;min-height:100%"); expect(compactCss).toContain(".agent-work-status{position:sticky;top:24px"); expect(compactCss).toContain(".agent-work-spinner{width:34px;height:34px"); expect(compactCss).toContain("animation:plan-rebuild-spin.8slinearinfinite"); expect(compactCss).toContain(".agent-work-spinner{animation:none");
  });

  it("maps public platform argv without shell interpolation", () => {
    const url = "http://127.0.0.1:1234/#capability=" + "a".repeat(43);
    expect(browserLaunchCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(browserLaunchCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(browserLaunchCommand(url, "win32")).toEqual({ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
    expect(() => browserLaunchCommand("https://example.com", "linux")).toThrow("invalid-browser-url");
  });

  it("opens live browser progress before a document exists and publishes time/prompt inputs", async () => {
    const liveState: PlanSession = {
      ...state, status: "generating", stateVersion: 2, documentRevision: 0, document: null, annotations: [],
      generationJob: { jobId: "job-live", operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], instruction: "", startedAt: "2026-07-11T13:00:00.000Z" },
    };
    let launchUrl = "";
    const controller = { snapshot: () => liveState, acceptedStagingPending: () => false, subscribe: () => () => undefined, configureWriterEndpoint: () => ({ ok: true, value: undefined }) } as unknown as PlanController;
    const activity = {}; updateLivePlanActivity(activity, {
      phase: "waiting-report", adapter: "delegated", primaryCount: 1, primaryStatus: "waiting",
      startedAt: "2026-07-11T13:00:00.000Z", updatedAt: "2026-07-11T13:01:00.000Z", budgetMinutes: 20,
      model: { slot: "writing-hard", model: "openai/gpt-planner", thinking: "xhigh" },
      progress: { summary: "Reviewing focused tests", updatedAt: "2026-07-11T13:00:30.000Z" },
    }); registerLivePlanActivity(controller, activity);
    const port = createBrowserPlanReviewPort({ launcher: { open: async (url) => { launchUrl = url; } }, reopen: vi.fn() });
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    await port.start?.({ controller, state: liveState, ctx });
    const parsed = new URL(launchUrl); const token = parsed.hash.slice("#capability=".length); const origin = parsed.origin;
    const response = await fetch(`${origin}/api/v1/snapshot`, { headers: { Authorization: `Bearer ${token}`, "X-Pi-Prompt-Origin": origin } });
    const body = await response.json() as { snapshot: { originalPrompt: string; promptPreview: string; document: null; activity: Record<string, unknown>; job: { startedAt: string } } };
    expect(body.snapshot).toMatchObject({
      originalPrompt: "ORIGINAL PRIVATE SOURCE", promptPreview: "ORIGINAL PRIVATE SOURCE", document: null,
      activity: {
        phase: "waiting-report", headline: "Waiting for the primary report", summary: "One primary planner is working independently.",
        progress: { summary: "Reviewing focused tests", updatedAt: "2026-07-11T13:00:30.000Z" },
        budgetMinutes: 20, adapter: "delegated", model: { slot: "writing-hard", model: "openai/gpt-planner", thinking: "xhigh" }, primary: { count: 1, status: "waiting" }, helpers: { supported: false, active: 0 },
      },
      job: { startedAt: "2026-07-11T13:00:00.000Z" },
    });
    await port.close?.();
  });

  it("treats every planning budget as advisory UI state without a generation timeout", () => {
    for (const profile of Object.values(GENERATION_PROFILES)) {
      let now = new Date("2026-07-11T13:00:00.000Z");
      const activity = { clock: () => now };
      const controller = {} as PlanController;
      updateLivePlanActivity(activity, {
        phase: "primary-active", adapter: "delegated", primaryCount: 1, primaryStatus: "active",
        startedAt: now.toISOString(), updatedAt: now.toISOString(), budgetMinutes: profile.timeBudgetMinutes,
        model: { slot: profile.modelSlot },
      });
      registerLivePlanActivity(controller, activity);
      now = new Date(now.getTime() + (profile.timeBudgetMinutes + 1) * 60_000);
      expect(livePlanActivity(controller)).toMatchObject({ phase: "primary-active", overBudget: true, budgetMinutes: profile.timeBudgetMinutes });
    }
  });

  it("opens a materialized review with compact status only and no white info notification", async () => {
    const errorState: PlanSession = { ...state, status: "error", lastError: { code: "generation-failed", message: "The revision failed safely." } };
    let launchUrl = "";
    const notify = vi.fn(); const setStatus = vi.fn(); const setWidget = vi.fn();
    const controller = { snapshot: () => errorState, acceptedStagingPending: () => false, subscribe: () => () => undefined, configureWriterEndpoint: () => ({ ok: true, value: undefined }) } as unknown as PlanController;
    const port = createBrowserPlanReviewPort({ launcher: { open: async (url) => {
      expect(notify).not.toHaveBeenCalled();
      launchUrl = url;
    } }, reopen: vi.fn() });
    const ctx = { ui: { notify, setStatus, setWidget } } as unknown as ExtensionContext;
    await port.ready({ controller, state: errorState, ctx });
    expect(launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#capability=/);
    expect(setWidget).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith("pi-prompt-plan", undefined);
    const statusCalls = setStatus.mock.calls.length;
    await port.close?.();
    expect(setStatus).toHaveBeenLastCalledWith("pi-prompt-plan", undefined);
    expect(setStatus.mock.calls.length).toBe(statusCalls + 1);
  });

  it("does not restore terminal progress when a stale browser launch finishes after close", async () => {
    const liveState: PlanSession = {
      ...state, status: "generating", stateVersion: 2, documentRevision: 0, document: null, annotations: [],
      generationJob: { jobId: "job-stale", operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: "2026-07-11T13:00:00.000Z" },
    };
    let finishLaunch!: () => void;
    const opening = new Promise<void>((resolve) => { finishLaunch = resolve; });
    const launcher = { open: vi.fn(() => opening) };
    const setStatus = vi.fn();
    const controller = { snapshot: () => liveState, acceptedStagingPending: () => false, subscribe: () => () => undefined, configureWriterEndpoint: () => ({ ok: true, value: undefined }) } as unknown as PlanController;
    const port = createBrowserPlanReviewPort({ launcher, reopen: vi.fn() });
    const ctx = { ui: { notify: vi.fn(), setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    const start = port.start?.({ controller, state: liveState, ctx });
    await vi.waitFor(() => expect(launcher.open).toHaveBeenCalledOnce());
    await port.close?.();
    finishLaunch();
    await start;
    expect(setStatus).toHaveBeenLastCalledWith("pi-prompt-plan", undefined);
  });

  it("hosts one injected controller, launches the fragment URL, exposes only a bounded prompt preview, and reopens Pi", async () => {
    let launchUrl = "";
    const reopen = vi.fn();
    const listeners = new Set();
    const controller = { snapshot: () => state, acceptedStagingPending: () => false, subscribe: (listener: unknown) => { listeners.add(listener); return () => listeners.delete(listener); }, configureWriterEndpoint: () => ({ ok: true, value: undefined }) } as unknown as PlanController;
    const port = createBrowserPlanReviewPort({ launcher: { open: async (url) => { launchUrl = url; } }, reopen });
    const ctx = { ui: { notify: vi.fn() } } as unknown as ExtensionContext;
    await port.ready({ controller, state, ctx });
    expect(launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#capability=[A-Za-z0-9_-]{43}$/);
    const parsed = new URL(launchUrl); const token = parsed.hash.slice("#capability=".length); const origin = parsed.origin;
    const snapshot = await fetch(`${origin}/api/v1/snapshot`, { headers: { Authorization: `Bearer ${token}`, "X-Pi-Prompt-Origin": origin } });
    const publicBody = await snapshot.json() as { snapshot: Record<string, unknown> };
    expect(publicBody.snapshot.promptPreview).toBe("ORIGINAL PRIVATE SOURCE");
    expect(publicBody.snapshot).not.toHaveProperty("source");
    expect(JSON.stringify(publicBody)).not.toContain("/private/SKILL.md"); expect(JSON.stringify(publicBody)).not.toContain('"cwd"'); expect(JSON.stringify(publicBody)).not.toContain("nonce_");
    const reopenResponse = await fetch(`${origin}/api/v1/reopen-in-pi`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Pi-Prompt-Origin": origin, Origin: origin, "Content-Type": "application/json", "If-Match": '"pi-plan-state-3"' }, body: JSON.stringify({ requestId: "request-id-reopen-001" }) });
    expect(reopenResponse.status).toBe(200);
    await port.close?.(); await Promise.resolve();
    expect(reopen).toHaveBeenCalledWith(ctx, { text: "ORIGINAL PRIVATE SOURCE", mode: "careful", execution: { kind: "loop" }, selectedSkills: ["security"] });
    expect(listeners.size).toBe(0);
  });
});
