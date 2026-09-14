/**
 * Minimal DOM stand-in for renderer unit tests (vitest runs in node).
 *
 * Covers the subset the renderer uses: elements with classes/attributes/
 * listeners/children, class/id/tag queries, input props, focus tracking,
 * and document globals. Not a DOM implementation — add only what a test needs.
 */

type Listener = (event: Record<string, unknown> & { preventDefault(): void; stopPropagation(): void }) => void;

function makeEvent(init: Record<string, unknown>): Parameters<Listener>[0] {
  let defaultPrevented = false;
  return {
    ...init,
    get defaultPrevented(): boolean {
      return defaultPrevented;
    },
    preventDefault(): void {
      defaultPrevented = true;
    },
    stopPropagation(): void {},
  } as Parameters<Listener>[0];
}

export class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  listeners = new Map<string, Listener[]>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = "";
  title = "";
  value = "";
  placeholder = "";
  type = "";
  hidden = false;
  tabIndex = 0;
  disabled = false;
  offsetLeft = 0;
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;
  clientHeight = 0;
  id = "";
  private attributes = new Map<string, string>();
  private classes = new Set<string>();
  classList = {
    add: (...names: string[]): void => {
      for (const name of names) this.classes.add(name);
    },
    remove: (...names: string[]): void => {
      for (const name of names) this.classes.delete(name);
    },
    toggle: (name: string, force?: boolean): void => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
    },
    contains: (name: string): boolean => this.classes.has(name),
  };
  /** Owning fake document (set by createElement) for focus tracking. */
  document: FakeDocument | null = null;

  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((f) => f !== fn));
  }
  /** Dispatch a synthetic event of `type` (bubbles to ancestors). */
  dispatch(type: string, init: Record<string, unknown> = {}): void {
    const event = makeEvent({ type, target: this, ...init });
    let node: FakeEl | null = this;
    while (node) {
      for (const fn of node.listeners.get(type) ?? []) fn(event);
      node = node.parent;
    }
  }
  click(): void {
    this.dispatch("click");
  }
  focus(): void {
    if (this.document) this.document.activeElement = this;
    this.dispatch("focus");
  }
  appendChild<T extends FakeEl>(child: T): T {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: FakeEl[]): void {
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child: FakeEl): void {
    this.children = this.children.filter((c) => c !== child);
    if (child.parent === this) child.parent = null;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  replaceChildren(...nodes: FakeEl[]): void {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  contains(node: FakeEl): boolean {
    let current: FakeEl | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }
  closest(selector: string): FakeEl | null {
    let node: FakeEl | null = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(selector: string): FakeEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (node: FakeEl): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  get isConnected(): boolean {
    let node: FakeEl | null = this;
    while (node.parent) node = node.parent;
    return node !== this || this.parent !== null;
  }
}

/** Single-part selectors only: `#id`, `.class.chain`, or `tag`. */
function matchesSelector(el: FakeEl, selector: string): boolean {
  const sel = selector.trim();
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  if (sel.startsWith(".")) return sel.slice(1).split(".").every((c) => el.classList.contains(c));
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

export class FakeDocument {
  body = new FakeEl("body");
  activeElement: FakeEl | null = null;
  private listeners = new Map<string, Listener[]>();
  private byId = new Map<string, FakeEl>();

  constructor() {
    this.body.document = this;
  }

  createElement(tagName: string): FakeEl {
    const el = new FakeEl(tagName);
    el.document = this;
    return el;
  }
  getElementById(id: string): FakeEl | null {
    return this.byId.get(id) ?? null;
  }
  registerId(id: string, el: FakeEl): void {
    this.byId.set(id, el);
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((f) => f !== fn));
  }
}

/**
 * Install fake `document`/`HTMLElement` globals for one test file. The modal
 * root (`#modal-root`) is pre-registered; `cleanup` restores the globals.
 */
export function installFakeDom(): { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void } {
  const document = new FakeDocument();
  const modalRoot = document.createElement("div");
  modalRoot.id = "modal-root";
  document.registerId("modal-root", modalRoot);
  const globals = globalThis as Record<string, unknown>;
  const prevDocument = globals.document;
  const prevHTMLElement = globals.HTMLElement;
  globals.document = document;
  globals.HTMLElement = class {};
  return {
    document,
    modalRoot,
    cleanup: () => {
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevHTMLElement === undefined) delete globals.HTMLElement;
      else globals.HTMLElement = prevHTMLElement;
    },
  };
}
