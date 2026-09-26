export interface ImagePreviewState {
  /** Null follows the viewport; a number is relative to the natural image size. */
  scale: number | null;
  left: number;
  top: number;
}

export function fitImageScale(width: number, height: number, availableWidth: number, availableHeight: number): number {
  return Math.min(1, availableWidth / width, availableHeight / height);
}

/** One mounted image view. The tab owns its state; this view owns its listeners. */
export class ImagePreview {
  readonly element = document.createElement("div");
  private readonly viewport = document.createElement("div");
  private readonly stage = document.createElement("div");
  private readonly image = document.createElement("img");
  private readonly percentage = document.createElement("output");
  private readonly status = document.createElement("div");
  private readonly events = new AbortController();
  private readonly resize: ResizeObserver;
  private readonly zoomOut: HTMLButtonElement;
  private readonly zoomIn: HTMLButtonElement;
  private readonly fit: HTMLButtonElement;
  private readonly actual: HTMLButtonElement;
  private scale = 1;
  private loaded = false;
  private restored = false;
  private focusToRestore: HTMLElement | null = null;
  private drag: { id: number; x: number; y: number; left: number; top: number } | null = null;

  constructor(src: string, name: string, private readonly state: ImagePreviewState) {
    this.element.className = "image-preview";
    const toolbar = document.createElement("div");
    toolbar.className = "image-preview-toolbar";
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Image controls");
    const button = (text: string, label: string, action: () => void) => {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = text;
      el.title = label;
      el.setAttribute("aria-label", label);
      el.disabled = true;
      el.addEventListener("click", action, { signal: this.events.signal });
      return el;
    };
    this.zoomOut = button("−", "Zoom out", () => this.zoom(this.scale / 1.25));
    this.zoomIn = button("+", "Zoom in", () => this.zoom(this.scale * 1.25));
    this.fit = button("Fit", "Fit image", () => {
      this.state.scale = null;
      this.render();
    });
    this.actual = button("100%", "Actual size", () => this.zoom(1));
    this.percentage.setAttribute("aria-label", "Image zoom");
    this.percentage.textContent = "—";
    toolbar.append(this.zoomOut, this.percentage, this.zoomIn, this.fit, this.actual);

    this.viewport.className = "image-preview-viewport";
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("role", "region");
    this.viewport.setAttribute("aria-label", `Image preview: ${name}`);
    this.viewport.title = "Drag to pan · Ctrl/Cmd + scroll to zoom · + / − to zoom · 0 for actual size · F to fit";
    this.stage.className = "image-preview-stage";
    this.image.alt = name;
    this.image.draggable = false;
    this.image.hidden = true;
    this.status.className = "image-preview-status";
    this.status.setAttribute("role", "status");
    this.status.textContent = "Loading image…";
    this.stage.append(this.image);
    this.viewport.append(this.stage);
    this.element.append(toolbar, this.status, this.viewport);

    const options = { signal: this.events.signal };
    this.viewport.addEventListener("scroll", () => this.rememberPosition(), options);
    this.image.addEventListener("load", () => {
      this.loaded = this.image.naturalWidth > 0 && this.image.naturalHeight > 0;
      this.image.hidden = !this.loaded;
      this.status.hidden = this.loaded;
      if (!this.loaded) this.status.textContent = "This image has no viewable dimensions.";
      this.render();
    }, options);
    this.image.addEventListener("error", () => {
      this.status.textContent = "This image could not be loaded. It may be damaged or use an unsupported format.";
    }, options);
    this.viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1);
      this.zoom(this.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.01), event.clientX - rect.left, event.clientY - rect.top);
    }, { ...options, passive: false });
    this.viewport.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key.toLowerCase()) {
        case "+": case "=": this.zoom(this.scale * 1.25); break;
        case "-": this.zoom(this.scale / 1.25); break;
        case "0": this.zoom(1); break;
        case "f": this.state.scale = null; this.render(); break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
    }, options);
    this.viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.loaded) return;
      this.viewport.focus({ preventScroll: true });
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
      this.viewport.setPointerCapture(event.pointerId);
      this.viewport.classList.add("dragging");
      event.preventDefault();
    }, options);
    this.viewport.addEventListener("pointermove", (event) => {
      if (this.drag?.id !== event.pointerId) return;
      this.viewport.scrollLeft = this.drag.left - (event.clientX - this.drag.x);
      this.viewport.scrollTop = this.drag.top - (event.clientY - this.drag.y);
      this.rememberPosition();
    }, options);
    const endDrag = () => {
      if (this.drag && this.viewport.hasPointerCapture(this.drag.id)) this.viewport.releasePointerCapture(this.drag.id);
      this.drag = null;
      this.viewport.classList.remove("dragging");
    };
    this.viewport.addEventListener("pointerup", endDrag, options);
    this.viewport.addEventListener("pointercancel", endDrag, options);
    this.viewport.addEventListener("lostpointercapture", endDrag, options);
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(this.viewport);
    this.image.src = src;
  }

  private fitScale(): number {
    return fitImageScale(this.image.naturalWidth, this.image.naturalHeight, this.viewport.clientWidth, this.viewport.clientHeight);
  }

  private render(): void {
    const { clientWidth: width, clientHeight: height } = this.viewport;
    if (!this.loaded || !width || !height) return;
    this.scale = this.state.scale ?? this.fitScale();
    const imageWidth = this.image.naturalWidth * this.scale;
    const imageHeight = this.image.naturalHeight * this.scale;
    this.stage.style.width = `${Math.max(width, imageWidth)}px`;
    this.stage.style.height = `${Math.max(height, imageHeight)}px`;
    this.image.style.width = `${imageWidth}px`;
    this.image.style.height = `${imageHeight}px`;
    this.percentage.textContent = `${Math.round(this.scale * 1000) / 10}%`;
    this.zoomOut.disabled = this.scale <= Math.min(0.01, this.fitScale());
    this.zoomIn.disabled = this.scale >= 32;
    this.fit.disabled = this.actual.disabled = false;
    this.fit.setAttribute("aria-pressed", String(this.state.scale === null));
    this.viewport.classList.toggle("pannable", imageWidth > width || imageHeight > height);
    if (!this.restored) {
      this.viewport.scrollLeft = this.state.left;
      this.viewport.scrollTop = this.state.top;
      this.restored = true;
    }
    this.rememberPosition();
    if (this.focusToRestore) {
      if (document.activeElement === this.viewport) this.focusToRestore.focus({ preventScroll: true });
      this.focusToRestore = null;
    }
  }

  private zoom(next: number, x = this.viewport.clientWidth / 2, y = this.viewport.clientHeight / 2): void {
    if (!this.loaded || !this.viewport.clientWidth || !this.viewport.clientHeight) return;
    const { clientWidth: width, clientHeight: height } = this.viewport;
    // Keep the image point under the pointer (or viewport center) in place.
    const imageX = (this.viewport.scrollLeft + x - Math.max(0, (width - this.image.naturalWidth * this.scale) / 2)) / this.scale;
    const imageY = (this.viewport.scrollTop + y - Math.max(0, (height - this.image.naturalHeight * this.scale) / 2)) / this.scale;
    this.state.scale = Math.max(Math.min(0.01, this.fitScale()), Math.min(32, next));
    this.render();
    this.viewport.scrollLeft = imageX * this.scale + Math.max(0, (width - this.image.naturalWidth * this.scale) / 2) - x;
    this.viewport.scrollTop = imageY * this.scale + Math.max(0, (height - this.image.naturalHeight * this.scale) / 2) - y;
    this.rememberPosition();
  }

  private rememberPosition(): void {
    // Hidden viewports report zero offsets. Retain the last visible position.
    if (!this.restored || !this.viewport.clientWidth || !this.viewport.clientHeight) return;
    this.state.left = this.viewport.scrollLeft;
    this.state.top = this.viewport.scrollTop;
  }

  private focusTargets(): HTMLElement[] {
    return [this.viewport, this.zoomOut, this.zoomIn, this.fit, this.actual];
  }

  get focusedControl(): number {
    return this.focusTargets().findIndex((element) => element === document.activeElement);
  }

  restoreFocus(control: number): void {
    const target = this.focusTargets()[control];
    if (!target) return;
    this.viewport.focus({ preventScroll: true });
    // Toolbar buttons are disabled during loading. Restore the exact control
    // after load only if the user has not moved focus elsewhere in the meantime.
    if (this.loaded) target.focus({ preventScroll: true });
    else this.focusToRestore = target;
  }

  dispose(): void {
    this.rememberPosition();
    this.events.abort();
    this.resize.disconnect();
    this.element.remove();
  }
}
