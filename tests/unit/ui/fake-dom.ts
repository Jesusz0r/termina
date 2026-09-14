/**
 * Minimal DOM stand-in for renderer unit tests (vitest runs in node).
 *
 * Covers the subset the renderer uses: elements with classes/attributes/
 * listeners/children, class/id/tag queries, input props, focus tracking,
 * and document globals. Not a DOM implementation — add only what a test needs.
 */

export interface FakeEvent {
  [key: string]: unknown;
  preventDefault(): void;
  stopPropagation(): void;
  readonly defaultPrevented: boolean;
}

type Listener = (event: FakeEvent) => void;

function makeEvent(init: Record<string, unknown>): FakeEvent {
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
  };
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
  private _tabIndex = 0;
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

  /** Reflects to the content attribute, like the real IDL setter. */
  get tabIndex(): number {
    return this._tabIndex;
  }
  set tabIndex(value: number) {
    this._tabIndex = value;
    this.attributes.set("tabindex", String(value));
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
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
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

/**
 * Selector subset: comma groups of an optional tag plus `#id`, `.class`,
 * `[attr]` / `[attr="value"]` in any order, with `:not(...)` conditions.
 * Anything else (`:scope`, combinators, pseudo-classes) never matches.
 */
function matchesSelector(el: FakeEl, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingle(el, part));
}

function matchesSingle(el: FakeEl, selector: string): boolean {
  const nots: string[] = [];
  let rest = selector
    .replace(/:not\(([^)]*)\)/g, (_m, inner: string) => {
      nots.push(inner.trim());
      return "";
    })
    .trim();
  for (const not of nots) {
    if (matchAttrCondition(el, not)) return false;
  }
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    if (el.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    if (rest.startsWith("#")) {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith(".")) {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[")) {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
      if (!m || !matchAttrCondition(el, m[1] + (m[2] !== undefined ? `="${m[2]}"` : ""))) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchAttrCondition(el: FakeEl, condition: string): boolean {
  const m = /^([\w-]+)(?:="([^"]*)")?$/.exec(condition.trim());
  if (!m) return false;
  const actual = el.getAttribute(m[1]);
  return m[2] === undefined ? actual !== null : actual === m[2];
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
  /** Dispatch to document-level listeners (capture listeners live here). */
  dispatch(type: string, init: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const event = makeEvent({ type, ...init });
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
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
