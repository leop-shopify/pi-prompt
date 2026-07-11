import { element, replaceChildren } from "./dom.js";

export function renderPlan(snapshot, treeNode, onComment, busy = false) {
  treeNode.classList.toggle("single-plan", Boolean(snapshot.planMarkdown));
  if (snapshot.planMarkdown) {
    replaceChildren(treeNode, snapshot.document
      ? renderMarkdownPlan(snapshot, onComment, busy)
      : [element("pre", { className: "plan-file-preview" }, [snapshot.planMarkdown])]);
    return;
  }
  if (!snapshot.document) {
    replaceChildren(treeNode, [element("div", { className: "plan-placeholder" }, [
      element("strong", {}, [snapshot.job ? "The plan is being generated" : "No plan yet"]),
      element("p", {}, [snapshot.job ? "The saved plan will appear here automatically." : "Start or retry planning from Pi."]),
    ])]);
    return;
  }
  const planNodes = [snapshot.document.title, ...snapshot.document.elements];
  replaceChildren(treeNode, planNodes.map((entry, index) => renderElement(entry, snapshot, onComment, index + 1, 0, busy)));
}

function renderMarkdownPlan(snapshot, onComment, busy) {
  const sections = parseMarkdown(snapshot.planMarkdown);
  const entries = [snapshot.document.title, ...snapshot.document.elements];
  return sections.map((section, index) => renderMarkdownEntry(section, entries[index], snapshot, onComment, busy, index, 0));
}

function renderMarkdownEntry(section, entry, snapshot, onComment, busy, ordinal, depth) {
  if (!entry) return element(depth === 0 ? "section" : "article", { className: `plan-element depth-${Math.min(depth, 4)}` }, [element("pre", { className: "markdown-body" }, [section.body])]);
  const article = element(depth === 0 ? "section" : "article", { className: `plan-element depth-${Math.min(depth, 4)}`, id: `element-${entry.id}`, dataset: { planElementId: entry.id } });
  const headingField = entry.kind === "title" ? "body" : entry.title === undefined ? undefined : "title";
  const heading = element(depth === 0 ? "h3" : "h4", headingField ? { dataset: { planField: headingField } } : {}, [section.title]);
  article.append(element("div", { className: "element-header" }, [heading]));
  if (section.body && entry.kind !== "title") article.append(element("pre", { className: "markdown-body", dataset: { planField: "body" } }, [section.body]));
  if (section.children.length) article.append(element("div", { className: "children" }, section.children.map((child, index) => renderMarkdownEntry(child, entry.children[index], snapshot, onComment, busy, index, depth + 1))));
  return article;
}

function parseMarkdown(markdown) {
  const sections = [];
  let current = null;
  let parent = null;
  for (const line of String(markdown).replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading && heading[1].length <= 3) {
      const section = { title: heading[2].trim(), lines: [], children: [] };
      if (heading[1].length === 3 && parent) parent.children.push(section);
      else { sections.push(section); parent = heading[1].length === 2 ? section : null; }
      current = section;
      continue;
    }
    if (current) current.lines.push(line);
  }
  const materialize = (section) => ({ title: section.title, body: section.lines.join("\n").trim(), children: section.children.map(materialize) });
  return sections.map(materialize);
}

function renderElement(entry, snapshot, onComment, ordinal, depth = 0, busy = false) {
  const article = element(depth === 0 ? "section" : "article", {
    className: `plan-element depth-${Math.min(depth, 4)}`,
    id: `element-${entry.id}`,
    dataset: { planElementId: entry.id },
  });
  const heading = element(depth === 0 ? "h3" : "h4", entry.title === undefined ? {} : { dataset: { planField: "title" } }, [entry.title ?? label(entry.kind)]);
  const header = element("div", { className: "element-header" }, [heading]);
  article.append(header, element("p", { className: "element-body", dataset: { planField: "body" } }, [entry.body]));
  if (entry.children.length) article.append(element("div", { className: "children" }, entry.children.map((child, index) => renderElement(child, snapshot, onComment, `${ordinal}.${index + 1}`, depth + 1, busy))));
  return article;
}

export function renderAnnotations(snapshot, filter, selectedIds, target, onUpdate, onSelect, busy = false) {
  const expandedIds = new Set([...target.querySelectorAll("details[open][data-annotation-id]")].map((node) => node.dataset.annotationId));
  const notes = snapshot.annotations.filter((annotation) => filter === "all" || annotation.status === filter);
  replaceChildren(target, notes.map((annotation, index) => {
    const context = annotation.targetSummary.label;
    const commentName = `note ${index + 1} on ${context}`;
    const disabled = busy || annotation.locked || !canAnnotate(snapshot);
    const headingId = `annotation-heading-${index}`;
    const body = element("textarea", {
      rows: 3, maxLength: 8192, value: annotation.body, disabled,
      dataset: { focusKey: `annotation-body-${annotation.id}` },
      "aria-label": `Edit ${commentName}`,
    });
    body.addEventListener("change", () => onUpdate(annotation, { body: body.value }));
    const status = element("span", { className: `annotation-status status-${annotation.status}` }, [annotation.locked ? `${annotation.status} · locked` : annotation.status]);
    const reopenable = annotation.status === "dismissed" || annotation.status === "addressed";
    const action = element("button", {
      type: "button", className: "quiet", disabled: disabled || annotation.status === "orphaned",
      dataset: { focusKey: `annotation-action-${annotation.id}` },
      "aria-label": `${reopenable ? "Reopen" : "Dismiss"} ${commentName}`,
    }, [reopenable ? "Reopen" : "Dismiss"]);
    action.addEventListener("click", () => onUpdate(annotation, { status: reopenable ? "open" : "dismissed" }));
    const selected = element("input", {
      type: "checkbox", checked: selectedIds.includes(annotation.id), disabled: disabled || annotation.status !== "open",
      dataset: { focusKey: `annotation-select-${annotation.id}` },
      "aria-label": `Select ${commentName} for revision`,
    });
    selected.addEventListener("change", () => onSelect(annotation.id, selected.checked));
    const summary = element("summary", { id: headingId, className: "note-summary" }, [
      element("span", {}, [`${context}`]), status,
      element("span", { className: "note-toggle-hint" }, ["Show note"]),
    ]);
    return element("details", { className: "note-card", open: expandedIds.has(annotation.id), dataset: { focusKey: `annotation-${annotation.id}`, annotationId: annotation.id } }, [
      summary,
      element("div", { className: "note-content" }, [
        renderTargetContext(annotation),
        element("label", { className: "select-note" }, [selected, "Include in next revision"]),
        body,
        element("div", { className: "note-actions" }, [action]),
      ]),
    ]);
  }));
}

function renderTargetContext(annotation) {
  const summary = annotation.targetSummary;
  const href = summary.historical ? undefined : annotation.target.kind === "root" ? "#plan-content" : `#element-${annotation.target.elementId}`;
  const labelNode = href
    ? element("a", { className: "annotation-target", href, dataset: { focusKey: `annotation-target-${annotation.id}` } }, [summary.label])
    : element("span", { className: "annotation-target" }, [`Historical ${summary.historical?.elementKind ?? "target"}: ${summary.label}`]);
  const details = [labelNode];
  if (summary.field && summary.quote !== undefined) details.push(element("q", { className: "annotation-quote" }, [`${summary.field}: ${summary.quote}`]));
  if (summary.historical?.excerpt) details.push(element("span", { className: "annotation-excerpt" }, [summary.historical.excerpt]));
  return element("div", { className: "annotation-context" }, details);
}

export function renderFilters(fieldset, filter, onFilter, disabled = false) {
  replaceChildren(fieldset, ["open", "addressed", "dismissed", "orphaned", "all"].map((value) => {
    const input = element("input", { type: "radio", name: "filter", value, checked: filter === value, disabled, dataset: { focusKey: `filter-${value}` } });
    input.addEventListener("change", () => onFilter(value));
    return element("label", { className: "filter" }, [input, value]);
  }));
}

function canAnnotate(snapshot) { return ["ready", "revising", "error", "needs-input"].includes(snapshot.status); }
function label(kind) { return kind.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
