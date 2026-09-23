/**
 * OS file drops anywhere on the terminal column (tab bar and terminal body)
 * go to a terminal: the tab under the cursor, else the active one.
 *
 * Listeners run in capture so the zone owns drops whose hit target is
 * xterm's helper textarea (it sits on the composer caret): preventDefault
 * there cancels that control's pathless file-paste default and keeps
 * filesystem paths. Drags that start inside the window (tab reorder,
 * explorer rows) are not file drops and pass through. The zone lives as
 * long as the window, so it has no teardown.
 */
export function createTerminalDropZone(opts: {
  zones: readonly HTMLElement[];
  /** Carries the `term-drop-target` class while a file drag is over a zone. */
  highlight: HTMLElement;
  /** False while there is no terminal to receive the files. */
  canDrop: () => boolean;
  /** `target` is the drop's hit element, so a tab can pick its own terminal. */
  dropFiles: (files: File[], target: EventTarget | null) => void;
}): void {
  let depth = 0;
  // Source of an in-window drag. A source that has left the DOM (an explorer
  // refresh mid-drag) never delivers dragend to the document, so a detached
  // source no longer counts instead of pinning the zone shut.
  let dragSource: Element | null = null;

  const clear = () => {
    depth = 0;
    opts.highlight.classList.remove("term-drop-target");
  };

  const isFileDrag = (event: DragEvent): boolean => {
    if (!opts.canDrop()) return false;
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    const types = transfer.types ? Array.from(transfer.types) : [];
    // In-window drags never carry files, so a file list is always an OS drop.
    if (types.includes("Files") || (transfer.files?.length ?? 0) > 0) return true;
    // Chromium can omit "Files" until drop. An empty type list still needs
    // preventDefault on dragover or the drop is never delivered, unless it
    // is a tab reorder or another drag that started in this window.
    return event.type !== "drop" && types.length === 0 && !dragSource?.isConnected;
  };

  const onDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth += 1;
    opts.highlight.classList.add("term-drop-target");
  };
  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) opts.highlight.classList.remove("term-drop-target");
  };
  const onDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    clear();
    opts.dropFiles(filesFromDataTransfer(event.dataTransfer), event.target);
  };
  const onInternalDragStart = (event: DragEvent) => {
    dragSource = event.target instanceof Element ? event.target : null;
  };
  const onDragFinished = () => {
    dragSource = null;
    clear();
  };

  for (const zone of opts.zones) {
    zone.addEventListener("dragenter", onDragEnter, true);
    zone.addEventListener("dragover", onDragOver, true);
    zone.addEventListener("dragleave", onDragLeave, true);
    zone.addEventListener("drop", onDrop, true);
  }
  document.addEventListener("dragstart", onInternalDragStart, true);
  document.addEventListener("dragend", onDragFinished, true);
  window.addEventListener("drop", onDragFinished);
  window.addEventListener("blur", clear);

}

function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const listed = Array.from(data.files ?? []);
  if (listed.length > 0) return listed;
  const items = data.items;
  if (!items) return [];
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const file = items[i]?.getAsFile();
    if (file) files.push(file);
  }
  return files;
}
