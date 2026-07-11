export function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "className") node.className = value;
    else if (name === "dataset") for (const [key, data] of Object.entries(value)) node.dataset[key] = data;
    else if (name.startsWith("aria-")) node.setAttribute(name, value);
    else if (name === "hidden") node.hidden = Boolean(value);
    else if (name in node && !name.startsWith("on")) node[name] = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
export function replaceChildren(node, children) { node.replaceChildren(...children); }
export function byId(id) { const node = document.getElementById(id); if (!node) throw new Error(`Missing shell node: ${id}`); return node; }
export function isTypingTarget(target) { return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable; }
