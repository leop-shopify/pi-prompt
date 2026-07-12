import { beforeAll, describe, expect, it } from "vitest";
import { renderClarification, renderPlan } from "../plan/browser/components.js";
import { selectionTarget } from "../plan/browser/range.js";

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
  return { status, planMarkdown: "# Plan", clarification: null, annotations, document: { id: "doc", title: { id: "title", kind: "title", body: "Plan", children: [] }, elements: [{ id: "step", kind: "step", title: "Task", body: "A😀BC", children: [] }] } };
}
function clarificationSnapshot(planDocument = null) {
  return { status: "awaiting-clarification", planMarkdown: planDocument ? "# Plan" : null, annotations: [], document: planDocument, clarification: { id: "batch", questions: [{ id: "question", prompt: "Choose?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] } };
}
function planBodyField(tree) { return tree.querySelectorAll("[data-plan-element-id]").find((node) => node.dataset.planElementId === "step").querySelector('[data-plan-field="body"]'); }

beforeAll(async () => {
  installDocument();
  ({ captureFocus, restoreFocus } = await import("../plan/browser/app.js"));
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
  it.each([2, 3])("excludes multiple overlapping badge glyphs from a Unicode selection starting at child boundary %s", (startOffset) => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); renderPlan(fieldSnapshot(), tree, () => {}, () => {}, false);
    const field = planBodyField(tree); const finalText = field.childNodes.at(-1);
    const result = selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: field, startOffset, endContainer: finalText, endOffset: 1 }) });
    expect(result).toMatchObject({ ok: true, target: { selector: { exact: "BC", start: 2, end: 4 } } });
    expect(field.textContent).toContain("◆◆");
    expect(field.querySelectorAll(".annotation-badge")[0].attributes.get("aria-label")).toContain("note:");
  });

  it("measures text after a later badge without counting its visible gold glyph", () => {
    installDocument(); const tree = document.createElement("div"); document.body.append(tree); renderPlan(fieldSnapshot(), tree, () => {}, () => {}, false);
    const field = planBodyField(tree); const finalText = field.childNodes.at(-1);
    expect(selectionTarget({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: field, startOffset: field.childNodes.length - 1, endContainer: finalText, endOffset: 1 }) }))
      .toMatchObject({ ok: true, target: { selector: { exact: "C", start: 3, end: 4 } } });
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
