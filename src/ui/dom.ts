/**
 * The entire "framework" (08 §2.1). One persistent canvas and a handful of panels does
 * not justify React; this is the ~40 lines that makes vanilla DOM pleasant.
 *
 * Revisit trigger is written down in 08 §2.1: if `src/ui/` passes ~1,500 lines of
 * imperative DOM churn, that decision gets re-opened rather than quietly endured.
 */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

/**
 * @param spec tag with optional `.class` suffixes, e.g. `'div.panel.spawner'`
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: K | string,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElement {
  const [tag = 'div', ...classes] = spec.split('.');
  const node = document.createElement(tag);
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children.flat?.() ?? children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * A button that is a real `<button>` — keyboard-focusable and announced correctly —
 * rather than a div with a click handler. MVP keeps semantic DOM even though the full
 * a11y pass is V1 (08 §1).
 */
export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLElement {
  return el('button', { type: 'button', ...attrs, onClick, text: label });
}

/** Swaps text only when it actually changed — avoids pointless layout invalidation. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: HTMLElement, name: string, on: boolean): void {
  node.classList.toggle(name, on);
}
