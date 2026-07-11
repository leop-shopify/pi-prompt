function offsetsWithin(root, range) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start = null;
  let end = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = [...node.data].length;
    if (node === range.startContainer) start = offset + [...node.data.slice(0, range.startOffset)].length;
    if (node === range.endContainer) end = offset + [...node.data.slice(0, range.endOffset)].length;
    offset += length;
  }
  return { start, end };
}
function graphemeBoundaries(text) {
  const boundaries = new Set([0, [...text].length]);
  if (typeof Intl.Segmenter !== "function") return boundaries;
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) boundaries.add([...text.slice(0, part.index)].length);
  return boundaries;
}
export function selectionTarget(selection = window.getSelection()) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return { ok: false, message: "Select text inside one plan field first." };
  const range = selection.getRangeAt(0);
  const startField = range.startContainer.parentElement?.closest("[data-plan-field]");
  const endField = range.endContainer.parentElement?.closest("[data-plan-field]");
  if (!startField || startField !== endField) return { ok: false, message: "Comments can select text within one title or body field only." };
  const owner = startField.closest("[data-plan-element-id]");
  if (!owner) return { ok: false, message: "That selection is outside the plan." };
  const text = startField.textContent ?? "";
  const { start, end } = offsetsWithin(startField, range);
  if (start === null || end === null || end <= start) return { ok: false, message: "The selected range could not be measured." };
  const boundaries = graphemeBoundaries(text);
  if (!boundaries.has(start) || !boundaries.has(end)) return { ok: false, message: "Select complete characters; the current selection splits a grapheme." };
  const points = [...text];
  return { ok: true, target: { kind: "range", elementId: owner.dataset.planElementId, selector: { field: startField.dataset.planField, start, end, exact: points.slice(start, end).join(""), prefix: points.slice(Math.max(0, start - 32), start).join(""), suffix: points.slice(end, end + 32).join("") } } };
}
