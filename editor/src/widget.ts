// Read-only canvas preview for the ```canvas code widget (and canvas.render in
// Lua). Runs in SilverBullet's widget iframe, where the html is set as body
// innerHTML and this script is eval'd, with `globalThis.syscall` available.
// Built without CodeMirror to stay small.

import { CanvasEditor } from "./editor.ts";
import type { Syscall } from "./host.ts";
import { syscallHost } from "./host.ts";
import { mirrorHostTheme } from "./theme.ts";
import { icon } from "./icons.ts";

const MIN_HEIGHT = 120;

interface FencedBlock { from: number; to: number; bodyFrom: number; bodyTo: number; body: string }

// Same block/body split SilverBullet uses for a code widget's bodyText.
function findCanvasBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  let open = -1;
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    if (open === -1) {
      const match = /^\s*(`{3,}|~{3,})\s*canvas\b/.exec(lines[i]);
      if (match) { open = i; fence = match[1]; }
      continue;
    }
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
      const bodyFrom = starts[open + 1];
      const bodyTo = i > open + 1 ? starts[i] - 1 : bodyFrom;
      blocks.push({ from: starts[open], to: starts[i] + lines[i].length, bodyFrom, bodyTo, body: text.slice(bodyFrom, bodyTo) });
      open = -1;
    }
  }
  return blocks;
}

const blockUrl = (body: string) => /url:\s*(.+)/i.exec(body)?.[1].trim() ?? null;

// The widget's position in the host page editor; exact when SB exposes its client.
function hostPosition(): number | null {
  try {
    const client = (window.parent as any)?.client;
    if (!client?.editorView || !window.frameElement) return null;
    const position = client.editorView.posAtDOM(window.frameElement);
    return typeof position === "number" ? position : null;
  } catch {
    return null;
  }
}

function identifyBlock(blocks: FencedBlock[], body: string, path: string): FencedBlock | null {
  const position = hostPosition();
  if (position !== null) {
    const containing = blocks.find((block) => block.from <= position && position <= block.to);
    return containing && blockUrl(containing.body) === path ? containing : null;
  }
  const same = blocks.filter((block) => block.body === body);
  if (same.length === 1) return same[0];
  if (same.length > 1) return null;
  const byUrl = blocks.filter((block) => blockUrl(block.body) === path);
  return byUrl.length === 1 ? byUrl[0] : null;
}

function heightEdit(block: FencedBlock, height: number): { from: number; to: number; insert: string; newBody: string } {
  let offset = block.bodyFrom;
  let urlLineEnd = -1;
  for (const line of block.body.split("\n")) {
    const heightLine = /^(\s*height\s*:\s*)/i.exec(line);
    if (heightLine) {
      const insert = `${heightLine[1]}${height}px`;
      const relative = offset - block.bodyFrom;
      return { from: offset, to: offset + line.length, insert, newBody: block.body.slice(0, relative) + insert + block.body.slice(relative + line.length) };
    }
    if (urlLineEnd === -1 && /^\s*url\s*:/i.test(line)) urlLineEnd = offset + line.length;
    offset += line.length + 1;
  }
  const at = urlLineEnd !== -1 ? urlLineEnd : block.bodyTo;
  const insert = block.body === "" ? `height: ${height}px` : `\nheight: ${height}px`;
  const relative = at - block.bodyFrom;
  return { from: at, to: at, insert, newBody: block.body.slice(0, relative) + insert + block.body.slice(relative) };
}

const documentHeight = () => Math.max(document.body.offsetHeight, document.documentElement.offsetHeight);
// SB stops polling the widget height ~2.5s after render, so report changes ourselves.
const reportHeight = () => window.parent?.postMessage({ type: "setHeight", height: documentHeight() }, "*");

async function persistHeight(syscall: Syscall, container: HTMLElement, height: number) {
  const path = container.dataset.path ?? "";
  const page = container.dataset.page ?? "";
  const body = container.dataset.body ?? "";
  if (!page || !body) return; // rendered from Lua: no block to update
  if ((await syscall("system.getMode")) === "ro") return;
  const text: string = await syscall("editor.getText");
  const block = identifyBlock(findCanvasBlocks(text), body, path);
  if (!block) {
    await syscall("editor.flashNotification", "Canvas: couldn't find the code block to save the new height", "error");
    return;
  }
  const edit = heightEdit(block, height);
  if (edit.newBody === block.body) return;
  // The edit re-creates the widget; seed SB's height cache so it doesn't collapse first.
  try {
    (window.parent as any)?.client?.widgetCache?.setCachedWidgetMeta(edit.newBody, { height: documentHeight(), block: true });
  } catch { /* internal API, best effort */ }
  await syscall("editor.replaceRange", edit.from, edit.to, edit.insert);
}

async function boot() {
  const container = document.getElementById("canvas-widget");
  if (!container) return;
  // The iframe may be reused; drop a previous instance's observers.
  (window as any).__canvasWidget?.destroy();

  const syscall: Syscall = (globalThis as any).syscall ?? ((name, ...args) => (globalThis as any).silverbullet.syscall(name, ...args));
  const path = container.dataset.path!;
  mirrorHostTheme(false);

  const root = document.createElement("div");
  root.className = "cv-widget-canvas";
  container.appendChild(root);
  const editor = new CanvasEditor(root, syscallHost(syscall, undefined, true), { viewer: true });
  (window as any).__canvasWidget = editor;

  const bar = document.createElement("div");
  bar.className = "cv-bar cv-widget-bar";
  bar.innerHTML =
    `<button data-act="lock" class="cv-lock"></button>` +
    `<button data-act="fit" title="Zoom to fit">${icon("fit", 16)}</button>` +
    `<button data-act="open" title="Open in canvas editor">${icon("edit", 16)}</button>`;
  container.appendChild(bar);
  const lockButton = bar.querySelector<HTMLElement>(".cv-lock")!;
  const setLocked = (locked: boolean) => {
    editor.setLocked(locked);
    lockButton.innerHTML = locked ? "🔒" : "🔓";
    lockButton.title = locked
      ? "Locked: scrolling moves the page. Click to pan and zoom the canvas"
      : "Unlocked: scroll and drag pan and zoom the canvas. Click to lock";
    lockButton.classList.toggle("cv-active", !locked);
  };
  bar.addEventListener("click", (event) => {
    const action = (event.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action === "lock") setLocked(!editor.isLocked());
    if (action === "fit") editor.zoomToFit();
    if (action === "open") syscall("editor.navigate", path).catch((error: unknown) => console.error(error));
  });

  const grip = document.createElement("div");
  grip.className = "cv-widget-resize";
  grip.title = "Drag to resize";
  container.appendChild(grip);
  let drag: { startY: number; startHeight: number; height: number; frame: number } | null = null;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const height = container.getBoundingClientRect().height;
    drag = { startY: event.clientY, startHeight: height, height, frame: 0 };
    document.documentElement.classList.add("cv-resizing");
  });
  grip.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const height = Math.max(MIN_HEIGHT, Math.round(drag.startHeight + event.clientY - drag.startY));
    if (height === drag.height) return;
    drag.height = height;
    container.style.height = `${height}px`;
    const current = drag;
    if (!current.frame) current.frame = requestAnimationFrame(() => { current.frame = 0; reportHeight(); });
  });
  const endDrag = () => {
    if (!drag) return;
    const finished = drag;
    drag = null;
    document.documentElement.classList.remove("cv-resizing");
    cancelAnimationFrame(finished.frame);
    reportHeight();
    if (Math.round(finished.startHeight) !== finished.height) {
      persistHeight(syscall, container, finished.height).catch((error) => console.error("Canvas: saving height failed", error));
    }
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  try {
    const bytes: Uint8Array = await syscall("space.readFile", path);
    await editor.load(new TextDecoder().decode(bytes), false);
    setLocked(true);
  } catch (error) {
    const message = document.createElement("div");
    message.className = "cv-empty";
    message.textContent = `Could not load ${path}: ${(error as Error).message}`;
    root.replaceChildren(message);
  }
}

void boot();
