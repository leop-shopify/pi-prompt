import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderClarification, renderPlan, renderSpec } from "../plan/browser/components.js";
import { selectionTarget } from "../plan/browser/range.js";
import { createStore } from "../plan/browser/store.js";
import { projectMarkdownPlan } from "../plan/markdown-projection.js";

class TestNode {
  static TEXT_NODE = 3;
  constructor(type = 1) { this.nodeType = type; this.parentElement = null; this.childNodes = []; }
  append(...children) { for (const child of children) { const node = child instanceof TestNode ? child : new TestText(String(child)); node.parentElement = this instanceof TestElement ? this : null; this.childNodes.push(node); } }
  replaceChildren(...children) { this.childNodes = []; this.append(...children); }
  get textContent() { return this.nodeType === TestNode.TEXT_NODE ? this.data : this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(new TestText(String(value))); }
}
class TestText extends TestNode { constructor(data) { super(TestNode.TEXT_NODE); this.data = data; } }
class TestElement extends TestNode {
  constructor(tag, ownerDocument) {
    super(); this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.attributes = new Map(); this.dataset = {}; this.listeners = new Map();
    this.id = ""; this.className = ""; this.hidden = false; this.disabled = false; this.checked = false; this.value = ""; this.type = tag === "input" ? "text" : ""; this.style = {};
    this.classList = { toggle: (name, force) => { const names = new Set(this.className.split(/\s+/u).filter(Boolean)); if (force) names.add(name); else names.delete(name); this.className = [...names].join(" "); } };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "id") this.id = String(value); if (name === "class") this.className = String(value); }
  hasAttribute(name) { return name === "disabled" ? this.disabled : this.attributes.has(name); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatchEvent(event) { event.target = this; for (const listener of this.listeners.get(event.type) ?? []) listener(event); return true; }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent({ type: "focus" }); }
  matches(selector) {
    if (selector === ".annotation-badge") return this.className.split(/\s+/u).includes("annotation-badge");
    const data = /^\[data-([a-z-]+)(?:="([^"]+)")?\]$/u.exec(selector);
    if (data) { const key = data[1].replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase()); return this.dataset[key] !== undefined && (data[2] === undefined || this.dataset[key] === data[2]); }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { const found = []; const visit = (node) => { if (node instanceof TestElement && node.matches(selector)) found.push(node); for (const child of node.childNodes) visit(child); }; for (const child of this.childNodes) visit(child); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { left: 0, bottom: 0 }; }
}
class TestInput extends TestElement {
  constructor(owner) { super("input", owner); this.selectionStart = 0; this.selectionEnd = 0; }
  setSelectionRange(start, end) { if (!["text", "search", "url", "tel", "password"].includes(this.type)) throw new Error(`selection unsupported for ${this.type}`); this.selectionStart = start; this.selectionEnd = end; }
}
class TestTextarea extends TestElement {
  constructor(owner) { super("textarea", owner); this.selectionStart = 0; this.selectionEnd = 0; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
class TestDocument {
  constructor() { this.body = new TestElement("body", this); this.activeElement = this.body; }
  createElement(tag) { return tag === "input" ? new TestInput(this) : tag === "textarea" ? new TestTextarea(this) : new TestElement(tag, this); }
  createTextNode(value) { return new TestText(value); }
  getElementById(id) { return this.body.querySelectorAll("[id]").find((node) => node.id === id) ?? this.#walk().find((node) => node.id === id) ?? null; }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  #walk() { const values = []; const visit = (node) => { if (node instanceof TestElement) values.push(node); for (const child of node.childNodes) visit(child); }; visit(this.body); return values; }
}

let documentFixture;
let captureFocus;
let restoreFocus;
let createRebuildTransitionTracker;
let isPlanRebuilding;
let createAgentWorkTransitionTracker;
let agentWorkIdentity;
let agentWorkLabel;
let createSnapshotCoordinator;
function installDocument() {
  documentFixture = new TestDocument();
  Object.assign(globalThis, {
    Node: TestNode, Element: TestElement, HTMLElement: TestElement, HTMLInputElement: TestInput, HTMLTextAreaElement: TestTextarea,
    HTMLSelectElement: class extends TestElement {}, NodeFilter: { SHOW_TEXT: 4 }, document: documentFixture,
    window: { location: { hash: "", pathname: "/", search: "", origin: "http://127.0.0.1" }, history: { replaceState() {} }, sessionStorage: { getItem: () => null }, addEventListener() {} },
  });
  const authLost = documentFixture.createElement("div"); authLost.id = "auth-lost"; authLost.hidden = true; documentFixture.body.append(authLost);
}
function fieldSnapshot(status = "ready") {
  const annotations = [
    { id: "same-a", body: "first", status: "open", locked: false, target: { kind: "range", elementId: "step", selector: { field: "body", start: 0, end: 2, exact: "A😀" } } },
    { id: "same-b", body: "overlap", status: "open", locked: false, target: { kind: "range", elementId: "step", selector: { field: "body", start: 1, end: 2, exact: "😀" } } },
    { id: "later", body: "later", status: "open", locked: false, target: { kind: "range", elementId: "step", selector: { field: "body", start: 2, end: 3, exact: "B" } } },
  ];
  return { status, documentRevision: 1, planMarkdown: "# Plan\n\n> arbitrary quote\n\n## Task\n- [ ] literal <tag>\n\nA😀BC\n```", clarification: null, annotations, document: { id: "doc", title: { id: "title", kind: "title", body: "Plan", children: [] }, elements: [{ id: "step", kind: "step", title: "Task", body: "A😀BC", children: [] }] } };
}
function clarificationSnapshot(planDocument = null) {
  return { status: "awaiting-clarification", planMarkdown: planDocument ? "# Plan\n\n## Task\nA😀BC" : null, annotations: [], document: planDocument, clarification: { id: "batch", questions: [{ id: "question", prompt: "Choose?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] } };
}
function planSurface(tree) { return tree.querySelector('[data-comment-surface="plan"]') ?? tree.querySelector('[data-comment-surface="grill"]'); }

beforeAll(async () => {
  installDocument();
  ({ captureFocus, restoreFocus, createRebuildTransitionTracker, isPlanRebuilding, createAgentWorkTransitionTracker, agentWorkIdentity, agentWorkLabel, createSnapshotCoordinator } = await import("../plan/browser/app.js"));
});

describe("clarification redraw focus", () => {
  it("retains focus without selecting text when a clarification radio redraws", () => {
    installDocument(); const target = document.createElement("div"); document.body.append(target); let draft = { id: "batch", answers: {} };
    const draw = () => renderClarification(clarificationSnapshot(), target, draft, (id, answer) => { draft = { id: "batch", answers: { [id]: answer } }; const saved = captureFocus(); draw(); restoreFocus(saved); });
    draw(); const radio = target.querySelector('[data-focus-key="clarification-batch-question-a"]'); radio.focus();
    expect(() => radio.dispatchEvent({ type: "change" })).not.toThrow();
    expect(document.activeElement.dataset.focusKey).toBe("clarification-batch-question-a");
    expect(draft.answers.question).toEqual({ kind: "option", optionId: "a" });
  });

  it("retains a custom clarification draft, focus, and caret across redraw", () => {
    installDocument(); const target = document.createElement("div"); document.body.append(target); let draft = { id: "batch", answers: {} };
    const draw = () => renderClarification(clarificationSnapshot(), target, draft, (id, answer) => { draft = { id: "batch", answers: { [id]: answer } }; });
    draw(); let textarea = target.querySelector('[data-focus-key="clarification-batch-question-custom-text"]'); textarea.focus(); textarea.value = "draft 😀 answer"; textarea.setSelectionRange(6, 8); textarea.dispatchEvent({ type: "input" });
    const saved = captureFocus(); draw(); restoreFocus(saved); textarea = target.querySelector('[data-focus-key="clarification-batch-question-custom-text"]');
    expect(textarea.value).toBe("draft 😀 answer"); expect(document.activeElement).toBe(textarea); expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 8]);
  });

  it("restores a revision-selection checkbox across a plan redraw without a selection API exception", () => {
    installDocument(); const tree = document.createElement("div"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.focusKey = "annotation-select-note"; document.body.append(tree, checkbox);
    let selected = false; checkbox.addEventListener("change", () => { selected = checkbox.checked; }); checkbox.focus(); checkbox.checked = true; checkbox.dispatchEvent({ type: "change" });
    const saved = captureFocus(); expect(() => { renderPlan(fieldSnapshot(), tree, () => {}, () => {}, false); restoreFocus(saved); }).not.toThrow();
    expect(selected).toBe(true); expect(document.activeElement).toBe(checkbox);
  });
});

describe("canonical annotation selectors", () => {
  it("renders fetched arbitrary Markdown exactly while excluding compact badges from selection offsets", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); const snapshot = fieldSnapshot(); renderPlan(snapshot, tree, () => {}, () => {}, false);
    const surface = planSurface(tree); const finalText = surface.childNodes.at(-1); const markedB = surface.childNodes.find((node) => node instanceof TestElement && node.textContent === "B");
    const result = selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: markedB.childNodes[0], startOffset: 0, endContainer: finalText, endOffset: 1 }) });
    expect(result).toMatchObject({ ok: true, target: { elementId: "step", selector: { exact: "BC", start: 2, end: 4 } } });
    expect(surface.textContent.replaceAll("•", "")).toBe(snapshot.planMarkdown);
    const badge = surface.querySelectorAll(".annotation-badge")[0]; expect(badge.textContent).toBe("•"); expect(badge.attributes.get("aria-label")).toContain("Your comment:");
  });

  it("maps an opaque compatibility projection onto exact Markdown code points", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree);
    const markdown = "\0\r\ncafe\u0301"; const planDocument = projectMarkdownPlan(markdown, 2);
    renderPlan({ status: "ready", documentRevision: 2, planMarkdown: markdown, annotations: [], document: planDocument }, tree, () => {}, () => {}, false);
    const surface = planSurface(tree); const field = surface.planProjection.find((entry) => entry.end > entry.start); const text = surface.childNodes[0];
    expect(surface.textContent).toBe(markdown);
    expect(field).toEqual({ start: 0, end: [...markdown].length, elementId: planDocument.elements[0].id, field: "body" });
    expect(selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: text, startOffset: 1, endContainer: text, endOffset: 3 }) }))
      .toMatchObject({ ok: true, target: { kind: "range", elementId: planDocument.elements[0].id, selector: { start: 1, end: 3, exact: "\r\n" } } });
  });

  it("counts a leading BOM without drifting Plan controller field offsets", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree);
    const markdown = "\uFEFF# Plan\n\n## Task\nA😀BC"; const planDocument = { id: "doc", title: { id: "title", kind: "title", body: "Plan", children: [] }, elements: [{ id: "step", kind: "step", title: "Task", body: "A😀BC", children: [] }] };
    renderPlan({ status: "ready", documentRevision: 1, planMarkdown: markdown, annotations: [], document: planDocument }, tree, () => {}, () => {}, false);
    const surface = planSurface(tree); const text = surface.childNodes[0]; const start = markdown.indexOf("B");
    expect(surface.textContent.codePointAt(0)).toBe(0xfeff);
    expect(selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: text, startOffset: start, endContainer: text, endOffset: start + 1 }) }))
      .toMatchObject({ ok: true, target: { kind: "range", elementId: "step", selector: { start: 2, end: 3, exact: "B" } } });
  });

  it("accepts Markdown syntax outside semantic fields with a best-effort element target", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); renderPlan(fieldSnapshot(), tree, () => {}, () => {}, false);
    const surface = planSurface(tree); const text = surface.childNodes[0];
    expect(selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: text, startOffset: 0, endContainer: text, endOffset: 2 }) }))
      .toEqual({ ok: true, target: { kind: "element", elementId: "title" }, exact: "# " });
  });
});

describe("staged author rendering", () => {
  it("filters generated review authors from Plan and labels both Adversarial Review provenance classes", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); const base = fieldSnapshot();
    const snapshot = { ...base, grill: { basedOnDocumentRevision: 1 }, documentRevision: 1, annotations: [
      { ...base.annotations[0], id: "user-note", author: "user", body: "user body" },
      { ...base.annotations[1], id: "grill-note", author: "grill", body: "generated body" },
    ] };
    renderPlan(snapshot, tree, () => {}, () => {}, false, "plan"); expect(tree.querySelectorAll("button")).toHaveLength(1); expect(tree.querySelectorAll("button")[0].attributes.get("aria-label")).not.toContain("Adversarial Review finding");
    renderPlan(snapshot, tree, () => {}, () => {}, false, "grill"); const buttons = tree.querySelectorAll("button");
    expect(buttons.map((button) => button.className)).toEqual(expect.arrayContaining([expect.stringContaining("author-user"), expect.stringContaining("author-grill")]));
    expect(buttons.map((button) => button.attributes.get("aria-label"))).toEqual(expect.arrayContaining([expect.stringContaining("Your comment:"), expect.stringContaining("Adversarial Review finding:")]));
  });

  it("renders open generated critiques as named checked controls without making their body editable", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); const base = fieldSnapshot(); const toggled = []; const opened = [];
    const generated = { ...base.annotations[0], id: "grill-selectable", author: "grill", body: "Preserve auth boundaries", status: "open" };
    renderPlan({ ...base, annotations: [generated] }, tree, () => {}, (item) => opened.push(item.id), false, "grill", [generated.id], (id) => toggled.push(id));
    const badge = tree.querySelector("button");
    expect(badge.attributes.get("role")).toBe("checkbox"); expect(badge.attributes.get("aria-checked")).toBe("true"); expect(badge.textContent).toBe("✓"); expect(badge.className).toContain("is-selected");
    expect(badge.attributes.get("aria-label")).toContain("Adversarial Review finding: Preserve auth boundaries"); expect(badge.attributes.get("aria-label")).toContain("Generated text is read-only"); expect(badge.attributes.get("aria-label")).toContain("Selected for Plan revision");
    badge.dispatchEvent({ type: "click" }); expect(toggled).toEqual([generated.id]); expect(opened).toEqual([generated.id]);
  });

  it("does not offer selection semantics for dismissed generated critiques", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); const base = fieldSnapshot(); const generated = { ...base.annotations[0], id: "grill-dismissed", author: "grill", status: "dismissed" };
    renderPlan({ ...base, annotations: [generated] }, tree, () => {}, () => {}, false, "grill", [generated.id], () => { throw new Error("dismissed critique must not toggle"); });
    const badge = tree.querySelector("button"); expect(badge.attributes.has("aria-checked")).toBe(false); expect(badge.textContent).toBe("•"); badge.dispatchEvent({ type: "click" });
  });

  it("renders an independent Spec surface with compact comment provenance and no Plan target", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); renderSpec({ specRevision: 2, markdown: "# Spec 😀\nExact body", job: null, comments: [{ id: "spec-comment", body: "tighten", status: "open", locked: false, target: { start: 2, end: 8 } }] }, tree, () => {}, false);
    const surface = tree.querySelector('[data-comment-surface="spec"]'); expect(surface).not.toBeNull(); expect(surface.textContent).toContain("•"); expect(surface.querySelector("button").attributes.get("aria-label")).toContain("Your comment:"); expect(surface.dataset.planElementId).toBeUndefined();
  });

  it("measures a Spec emoji selection in Unicode code points", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); renderSpec({ specRevision: 1, markdown: "# 😀 Spec", comments: [] }, tree, () => {}, false);
    const surface = tree.querySelector('[data-comment-surface="spec"]'); const text = surface.childNodes[0]; const selected = selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: text, startOffset: 2, endContainer: text, endOffset: 4 }) }, "spec");
    expect(selected).toEqual({ ok: true, target: { start: 2, end: 3 }, exact: "😀" });
  });

  it("counts a leading BOM in Spec controller offsets", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); const markdown = "\uFEFF# 😀 Spec"; renderSpec({ specRevision: 1, markdown, comments: [] }, tree, () => {}, false);
    const surface = tree.querySelector('[data-comment-surface="spec"]'); const text = surface.childNodes[0]; const start = markdown.indexOf("Spec");
    expect(surface.textContent.codePointAt(0)).toBe(0xfeff);
    expect(selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: text, startOffset: start, endContainer: text, endOffset: start + 4 }) }, "spec"))
      .toEqual({ ok: true, target: { start: 5, end: 9 }, exact: "Spec" });
  });
});

describe("Plan rebuild transitions", () => {
  it("recognizes both revision job shapes and scrolls only once per rebuild transition", () => {
    const entered = createRebuildTransitionTracker(); const ready = { status: "ready", job: null }; const revising = { status: "revising", job: { operation: "revision" } };
    expect(isPlanRebuilding(revising)).toBe(true); expect(isPlanRebuilding({ status: "ready", job: { operation: "revision" } })).toBe(true);
    expect([entered(ready), entered(revising), entered(revising), entered(ready), entered(revising)]).toEqual([false, true, false, false, true]);
  });
});

describe("agent work transitions", () => {
  it("uses projected job ids once across higher states, same-operation jobs, recovery, and Spec rebases", () => {
    const entered = createAgentWorkTransitionTracker(); const readyPlan = { status: "ready", job: null };
    const review = { stateVersion: 10, status: "grilling", job: { id: "review-1", operation: "grill" } };
    const sameReview = { ...review, stateVersion: 11 }; const nextReview = { stateVersion: 12, status: "grilling", job: { id: "review-2", operation: "grill" } };
    const spec = { stateVersion: 5, status: "generating", job: { id: "spec-1", operation: "initial" } }; const rebase = { stateVersion: 6, specRevision: 0, markdown: null, status: "generating", job: { id: "spec-rebase", operation: "initial" } };
    expect(agentWorkIdentity(review, null)).toBe("plan:review-1"); expect(agentWorkIdentity(readyPlan, spec)).toBe("spec:spec-1"); expect(agentWorkIdentity({ status: "revising", job: null }, null)).toBe("plan-status:revising");
    expect(agentWorkIdentity({ status: "revising", job: { operation: "revision", startedAt: "legacy" } }, null)).toBeNull();
    expect(agentWorkLabel(review, null)).toBe("Running Adversarial Review…"); expect(agentWorkLabel({ status: "revising", job: { id: "plan-revision", operation: "revision" } }, null)).toBe("Revising Plan…");
    expect(agentWorkLabel(readyPlan, spec)).toBe("Generating Spec…"); expect(agentWorkLabel(readyPlan, { status: "revising", job: { id: "spec-revision", operation: "revision" } })).toBe("Revising Spec…");
    expect([
      entered(readyPlan, null), entered(review, null), entered(sameReview, null), entered(nextReview, null),
      entered(readyPlan, null), entered(nextReview, null), entered(readyPlan, spec), entered(readyPlan, { ...spec, stateVersion: 6 }),
      entered(readyPlan, { status: "ready", job: null }), entered(readyPlan, rebase), entered({ status: "generating" }, null),
      entered({ status: "generating", job: { operation: "initial", startedAt: "legacy" } }, null), entered({ status: "generating", job: { operation: "initial", startedAt: "legacy" } }, null),
    ]).toEqual([false, true, false, true, false, false, true, false, false, true, true, false, false]);
  });
});

describe("snapshot response ordering", () => {
  it("rejects a delayed stale Plan pair before ETag, tracker, selection, composer, or store changes", async () => {
    let resolveMarkdown; const delayedMarkdown = new Promise((resolve) => { resolveMarkdown = resolve; });
    const document = { id: "plan" }; const initial = { stateVersion: 9, documentRevision: 2, status: "ready", document, annotations: [], planMarkdown: "# V9\n" };
    const stale = { stateVersion: 10, documentRevision: 1, status: "revising", document, annotations: [], job: { id: "plan-old", operation: "revision" } };
    const current = { stateVersion: 11, documentRevision: 2, status: "revising", document, annotations: [], job: { id: "plan-new", operation: "revision" } };
    const store = createStore({ snapshot: initial, selectedAnnotationIds: ["keep-plan"], selectedGrillAnnotationIds: ["keep-grill"] });
    const api = {
      snapshot: vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(current).mockResolvedValueOnce(stale),
      plan: vi.fn().mockReturnValueOnce(delayedMarkdown).mockResolvedValueOnce({ markdown: "# V11\n", stateVersion: 11, etag: '"pi-plan-state-11"' }).mockResolvedValueOnce({ markdown: "# V10\n", stateVersion: 10, etag: '"pi-plan-state-10"' }),
      setVersion: vi.fn(), setSpecVersion: vi.fn(), specSnapshot: vi.fn(),
    };
    const closeComposer = vi.fn(); const scrollToTop = vi.fn();
    const coordinator = createSnapshotCoordinator({ api, store, enteredAgentWork: createAgentWorkTransitionTracker(), closeComposer, scrollToTop });
    const delayed = coordinator.refreshPlan(); await vi.waitFor(() => expect(api.plan).toHaveBeenCalledOnce());
    await coordinator.refreshPlan();
    resolveMarkdown({ markdown: "# Mismatched V9\n", stateVersion: 9, etag: '"pi-plan-state-9"' }); await delayed;
    expect(api.snapshot).toHaveBeenCalledTimes(3); expect(api.plan).toHaveBeenCalledTimes(3);
    expect(store.get()).toMatchObject({ snapshot: { stateVersion: 11, documentRevision: 2, planMarkdown: "# V11\n", job: { id: "plan-new" } }, selectedAnnotationIds: ["keep-plan"], selectedGrillAnnotationIds: ["keep-grill"] });
    expect(api.setVersion).toHaveBeenCalledTimes(1); expect(api.setVersion).toHaveBeenCalledWith(11); expect(scrollToTop).toHaveBeenCalledOnce(); expect(closeComposer).not.toHaveBeenCalled();
  });

  it("ignores stale Spec null/V4, accepts a V6 rebase, and keeps equal-version application idempotent", async () => {
    let resolveNull; const delayedNull = new Promise((resolve) => { resolveNull = resolve; });
    const plan = { stateVersion: 8, documentRevision: 2, status: "ready", document: { id: "plan" }, annotations: [] };
    const v5 = { stateVersion: 5, specRevision: 2, status: "revising", markdown: "# V5\n", comments: [{ id: "comment", status: "open" }], job: { id: "spec-job-5", operation: "revision" } };
    const v4 = { ...v5, stateVersion: 4, markdown: "# V4\n", job: { id: "spec-job-4", operation: "revision" } };
    const v6 = { stateVersion: 6, specRevision: 0, status: "generating", markdown: null, comments: [], job: { id: "spec-rebase-6", operation: "initial" } };
    const store = createStore({ snapshot: plan, specSnapshot: null, selectedSpecCommentIds: ["keep-selection"] });
    const api = { specSnapshot: vi.fn().mockReturnValueOnce(delayedNull).mockResolvedValueOnce(v5), setSpecVersion: vi.fn(), setVersion: vi.fn(), snapshot: vi.fn(), plan: vi.fn() };
    const closeComposer = vi.fn(); const scrollToTop = vi.fn();
    const coordinator = createSnapshotCoordinator({ api, store, enteredAgentWork: createAgentWorkTransitionTracker(), closeComposer, scrollToTop });
    const staleNull = coordinator.refreshSpec(); await vi.waitFor(() => expect(api.specSnapshot).toHaveBeenCalledOnce()); await coordinator.refreshSpec();
    expect(store.get().specSnapshot).toBe(v5); expect(scrollToTop).toHaveBeenCalledOnce();
    resolveNull(null); await staleNull;
    expect(coordinator.applySpecSnapshot({ ...v5, markdown: "# stale equal\n" }, 1)).toBe(false);
    const v4Epoch = coordinator.beginSpecRequest(); expect(coordinator.applySpecSnapshot(v4, v4Epoch)).toBe(false);
    const equalEpoch = coordinator.beginSpecRequest(); expect(coordinator.applySpecSnapshot(v5, equalEpoch)).toBe(true); expect(scrollToTop).toHaveBeenCalledOnce();
    const rebaseEpoch = coordinator.beginSpecRequest(); expect(coordinator.applySpecSnapshot(v6, rebaseEpoch)).toBe(true);
    expect(store.get()).toMatchObject({ specSnapshot: { stateVersion: 6, specRevision: 0, markdown: null, job: { id: "spec-rebase-6" } }, selectedSpecCommentIds: ["keep-selection"] });
    expect(api.setSpecVersion.mock.calls.map(([version]) => version)).toEqual([5, 5, 6]); expect(scrollToTop).toHaveBeenCalledTimes(2); expect(closeComposer).not.toHaveBeenCalled();
  });
});

describe("awaiting revision browser rendering", () => {
  it("keeps the current plan visible and renders questions while plan actions remain gated", async () => {
    installDocument(); const tree = document.createElement("div"); const questions = document.createElement("div"); document.body.append(tree, questions);
    const planDocument = fieldSnapshot().document; const snapshot = clarificationSnapshot(planDocument); renderPlan(snapshot, tree, () => { throw new Error("annotation creation must stay gated"); }, () => {}, false); renderClarification(snapshot, questions, { id: "batch", answers: {} }, () => {}, false);
    expect(tree.textContent).toContain("A😀BC"); expect(questions.textContent).toContain("Choose?");
    const store = await import("../plan/browser/store.js");
    expect(store.isAwaitingClarification(snapshot)).toBe(true); expect(store.canAccept(snapshot)).toBe(false); expect(store.canRevise(snapshot)).toBe(false);
  });
});
