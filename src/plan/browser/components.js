import { element, replaceChildren } from "./dom.js";

export function renderPlan(snapshot, treeNode, onComment, onEdit, busy = false) {
  treeNode.classList.toggle("single-plan", Boolean(snapshot.planMarkdown));
  if (!snapshot.document) {
    replaceChildren(treeNode, [element("div", { className: "plan-placeholder" }, [
      element("strong", {}, [snapshot.clarification ? "Planning is waiting for your answers" : snapshot.job ? "The plan is being generated" : "No plan yet"]),
      element("p", {}, [snapshot.clarification ? "Continue above when you are ready." : snapshot.job ? "The saved plan will appear here automatically." : "Start or retry planning from Pi."]),
    ])]);
    return;
  }
  const sections = snapshot.planMarkdown ? parseMarkdown(snapshot.planMarkdown) : [];
  const entries = [snapshot.document.title, ...snapshot.document.elements];
  const rendered = entries.map((entry, index) => renderEntry(entry, sections[index], snapshot, onEdit, busy, 0));
  const fallback = snapshot.annotations.filter((note) => note.target.kind === "root" || !findEntry(snapshot.document, note.target.elementId));
  if (fallback.length) rendered.push(element("div", { className: "root-annotation-badges", "aria-label": "Plan-level and fallback notes" }, fallback.map((note) => annotationBadge(note, onEdit, busy, true))));
  replaceChildren(treeNode, rendered);
}

function renderEntry(entry, section, snapshot, onEdit, busy, depth) {
  const article = element(depth === 0 ? "section" : "article", { className: `plan-element depth-${Math.min(depth, 4)}`, id: `element-${entry.id}`, dataset: { planElementId: entry.id } });
  const headingField = entry.kind === "title" ? "body" : entry.title === undefined ? undefined : "title";
  const headingText = entry.kind === "title" ? entry.body : entry.title ?? label(entry.kind);
  const headingNotes = headingField ? rangeNotes(snapshot, entry.id, headingField) : [];
  const heading = element(depth === 0 ? "h3" : "h4", headingField ? { dataset: { planField: headingField } } : {}, annotatedNodes(headingText, headingNotes, onEdit, busy));
  if (entry.kind === "title") for (const note of snapshot.annotations.filter((value) => value.target.elementId === entry.id && (value.target.kind === "element" || value.status === "orphaned"))) heading.append(annotationBadge(note, onEdit, busy, note.status === "orphaned"));
  article.append(element("div", { className: "element-header" }, [heading]));
  if (entry.kind !== "title") {
    const bodyText = entry.body;
    const body = element("pre", { className: snapshot.planMarkdown ? "markdown-body" : "element-body", dataset: { planField: "body" } }, annotatedNodes(bodyText, rangeNotes(snapshot, entry.id, "body"), onEdit, busy));
    const legacy = snapshot.annotations.filter((note) => note.target.elementId === entry.id && (note.target.kind === "element" || note.status === "orphaned"));
    for (const note of legacy) body.append(annotationBadge(note, onEdit, busy, note.status === "orphaned"));
    article.append(body);
  }
  if (entry.children.length) article.append(element("div", { className: "children" }, entry.children.map((child, index) => renderEntry(child, section?.children?.[index], snapshot, onEdit, busy, depth + 1))));
  return article;
}

export function inlineAnnotationSegments(text, notes) {
  const points = [...String(text)]; const groups = new Map();
  for (const note of [...notes].sort((left, right) => left.target.selector.end - right.target.selector.end || left.id.localeCompare(right.id))) { const end = Math.max(0, Math.min(points.length, note.target.selector.end)); groups.set(end, [...(groups.get(end) ?? []), note]); }
  const segments = []; let cursor = 0; for (const [end, badges] of groups) { segments.push({ text: points.slice(cursor, end).join(""), badges }); cursor = end; } segments.push({ text: points.slice(cursor).join(""), badges: [] }); return segments;
}
function annotatedNodes(text, notes, onEdit, busy) {
  const nodes = []; for (const segment of inlineAnnotationSegments(text, notes)) { if (segment.text) nodes.push(segment.text); for (const note of segment.badges) nodes.push(annotationBadge(note, onEdit, busy, false)); } return nodes.length ? nodes : [String(text)];
}

function annotationBadge(note, onEdit, busy, fallback) {
  const status = note.locked ? `${note.status}, locked` : note.status;
  const label = `${fallback ? "Fallback " : ""}note: ${note.body}. Status: ${status}. Press Enter to edit.`;
  const badge = element("button", { type: "button", className: `annotation-badge status-${note.status}${fallback ? " annotation-fallback" : ""}`, title: label,
    dataset: { annotationId: note.id, focusKey: `annotation-badge-${note.id}`, preview: `${note.body} · ${status}` }, "aria-label": label }, ["◆"]);
  badge.addEventListener("click", () => onEdit(note, badge, busy));
  return badge;
}

function rangeNotes(snapshot, elementId, field) {
  return snapshot.annotations.filter((note) => note.target.kind === "range" && note.status !== "orphaned" && note.target.elementId === elementId && note.target.selector.field === field);
}
function findEntry(document, id) { const visit = (entry) => entry.id === id ? entry : entry.children.map(visit).find(Boolean); return visit(document.title) ?? document.elements.map(visit).find(Boolean); }

export function renderClarification(snapshot, target, draft, onDraft, busy = false) {
  const pending = snapshot.clarification;
  if (!pending) { replaceChildren(target, []); return; }
  replaceChildren(target, pending.questions.map((question, index) => {
    const selected = draft?.answers?.[question.id];
    const choices = question.options.map((option) => {
      const input = element("input", { type: "radio", name: `clarification-${question.id}`, value: option.id, checked: selected?.kind === "option" && selected.optionId === option.id, disabled: busy,
        dataset: { focusKey: `clarification-${pending.id}-${question.id}-${option.id}` } });
      input.addEventListener("change", () => onDraft(question.id, { kind: "option", optionId: option.id }));
      return element("label", { className: "clarification-option" }, [input, element("span", {}, [option.label])]);
    });
    const customId = `clarification-custom-${index}`;
    const customRadio = element("input", { type: "radio", name: `clarification-${question.id}`, checked: selected?.kind === "custom", disabled: busy,
      dataset: { focusKey: `clarification-${pending.id}-${question.id}-custom` }, "aria-label": `Custom answer for ${question.prompt}` });
    const custom = element("textarea", { id: customId, rows: 2, maxLength: 4096, disabled: busy, value: selected?.kind === "custom" ? selected.text : "", placeholder: "Write a custom answer",
      dataset: { focusKey: `clarification-${pending.id}-${question.id}-custom-text` } });
    customRadio.addEventListener("change", () => onDraft(question.id, { kind: "custom", text: custom.value }));
    custom.addEventListener("focus", () => { customRadio.checked = true; onDraft(question.id, { kind: "custom", text: custom.value }); });
    custom.addEventListener("input", () => onDraft(question.id, { kind: "custom", text: custom.value }));
    choices.push(element("div", { className: "clarification-custom" }, [customRadio, element("label", { htmlFor: customId }, ["Custom answer"]), custom]));
    return element("fieldset", { className: "clarification-question" }, [element("legend", {}, [`${index + 1}. ${question.prompt}`]), ...choices]);
  }));
}

function parseMarkdown(markdown) {
  const sections = []; let current = null; let parent = null;
  for (const line of String(markdown).replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { const section = { title: heading[2].trim(), lines: [], children: [] }; if (heading[1].length === 3 && parent) parent.children.push(section); else { sections.push(section); parent = heading[1].length === 2 ? section : null; } current = section; continue; }
    if (current) current.lines.push(line);
  }
  const materialize = (section) => ({ title: section.title, body: section.lines.join("\n").trim(), children: section.children.map(materialize) });
  return sections.map(materialize);
}
function label(kind) { return kind.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
