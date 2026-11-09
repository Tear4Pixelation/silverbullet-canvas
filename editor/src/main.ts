import { CanvasEditor } from "./editor.ts";
import { silverBulletHost, silverbullet, standaloneHost } from "./host.ts";
import { escapeHtml } from "./markdown.ts";
import { icon } from "./icons.ts";
import { DEMO_CANVAS } from "./demo.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Overlay so the editor DOM stays intact and can load again once the file is fixed.
function showError(message: string | null) {
  let overlay = document.getElementById("cv-error");
  if (!message) { overlay?.remove(); return; }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "cv-error";
    overlay.className = "cv-empty";
    overlay.style.cssText = "flex-direction:column;gap:8px;padding:24px;text-align:center;background:var(--cv-bg);z-index:20;pointer-events:auto";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<strong>Could not open this canvas</strong><span>${escapeHtml(message)}</span><span>The file was left untouched.</span>`;
}

// SilverBullet's document-editor iframe is same-origin (srcdoc), so the host's
// live CSS variables and @font-face rules can be mirrored for a native look.
function mirrorHostTheme() {
  let hostDocument: Document;
  try {
    hostDocument = window.parent.document;
    if (!hostDocument || window.parent === window) return;
  } catch {
    return;
  }
  const sync = () => {
    const hostRoot = hostDocument.documentElement;
    const computed = window.parent.getComputedStyle(hostRoot);
    const style = document.documentElement.style;
    for (let i = 0; i < computed.length; i++) {
      const name = computed[i];
      if (name.startsWith("--")) style.setProperty(name, computed.getPropertyValue(name));
    }
    const theme = hostRoot.getAttribute("data-theme");
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  };
  sync();
  new MutationObserver(() => setTimeout(sync, 0)).observe(hostDocument.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });

  const fontRules: string[] = [];
  for (const sheet of Array.from(hostDocument.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    const base = sheet.href ?? hostDocument.baseURI;
    for (const rule of Array.from(rules)) {
      if (rule.constructor.name !== "CSSFontFaceRule") continue;
      fontRules.push(rule.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, _quote, url) => {
        try { return `url("${new URL(url, base).href}")`; } catch { return match; }
      }));
    }
  }
  if (fontRules.length) {
    const style = document.createElement("style");
    style.textContent = fontRules.join("\n");
    document.head.appendChild(style);
  }
}

function bootSilverBullet(root: HTMLElement) {
  const sb = silverbullet()!;
  mirrorHostTheme();
  const editor = new CanvasEditor(root, silverBulletHost(sb));
  (window as any).canvasEditor = editor; // for debugging from the devtools console
  let currentPath: string | null = null;
  let broken: Uint8Array | null = null;

  sb.addEventListener("file-open", async (event) => {
    const { data, meta } = (event as CustomEvent).detail as { data: Uint8Array; meta: { name: string } };
    const text = decoder.decode(data);
    const samePath = meta.name === currentPath;
    // Our own save echoing back: nothing to do.
    if (samePath && !broken && editor.isCurrent(text)) return;
    try {
      await editor.load(text, samePath && !broken);
      broken = null;
      showError(null);
    } catch (error) {
      broken = data;
      showError((error as Error).message);
    }
    currentPath = meta.name;
  });

  sb.addEventListener("request-save", () => {
    if (broken) {
      sb.sendMessage("file-saved", { data: broken });
      return;
    }
    const text = editor.serialize();
    sb.sendMessage("file-saved", { data: encoder.encode(text) });
    editor.markSaved(text);
  });

  sb.addEventListener("focus", () => editor.focus());
}

function bootStandalone(root: HTMLElement) {
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.setAttribute("data-theme", "dark");
  let fileHandle: any = null;
  let fileName = "demo.canvas";
  let unsaved = false;
  const editor = new CanvasEditor(root, standaloneHost(() => { unsaved = true; updateName(); }));

  const bar = document.createElement("div");
  bar.className = "cv-bar cv-standalone-bar";
  bar.innerHTML = `<button data-act="new" title="New canvas">New</button><button data-act="open" title="Open .canvas (Ctrl+O)">${icon("file")}&nbsp;Open</button><button data-act="save" title="Save (Ctrl+S)">Save</button><span class="cv-name"></span>`;
  document.body.appendChild(bar);
  const nameLabel = bar.querySelector<HTMLElement>(".cv-name")!;
  const updateName = () => { nameLabel.textContent = fileName + (unsaved ? " •" : ""); };

  const open = async (text: string, name: string, handle: any = null) => {
    try {
      await editor.load(text, false);
      fileName = name;
      fileHandle = handle;
      unsaved = false;
      updateName();
    } catch (error) {
      alert(`Could not open ${name}: ${(error as Error).message}`);
    }
  };

  const openFile = async () => {
    const picker = (window as any).showOpenFilePicker;
    if (picker) {
      try {
        const [handle] = await picker({ types: [{ description: "JSON Canvas", accept: { "application/json": [".canvas"] } }] });
        const file = await handle.getFile();
        await open(await file.text(), file.name, handle);
      } catch { /* cancelled */ }
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".canvas,application/json";
    input.onchange = async () => { const file = input.files?.[0]; if (file) await open(await file.text(), file.name); };
    input.click();
  };

  const save = async () => {
    const text = editor.serialize();
    try {
      if (!fileHandle && (window as any).showSaveFilePicker) {
        fileHandle = await (window as any).showSaveFilePicker({ suggestedName: fileName, types: [{ description: "JSON Canvas", accept: { "application/json": [".canvas"] } }] });
        fileName = fileHandle.name;
      }
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
      } else {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
      editor.markSaved(text);
      unsaved = false;
      updateName();
    } catch { /* cancelled */ }
  };

  bar.addEventListener("click", (event) => {
    const action = (event.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action === "open") void openFile();
    if (action === "save") void save();
    if (action === "new") void open('{"nodes":[],"edges":[]}', "untitled.canvas");
  });
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); void openFile(); }
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) await open(await file.text(), file.name);
  });
  window.addEventListener("beforeunload", (event) => { if (unsaved) event.preventDefault(); });
  // Exposed for automated tests.
  (window as any).canvasEditor = editor;
  void open(DEMO_CANVAS, fileName);
}

const root = document.getElementById("canvas-root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "canvas-root" }));
if (silverbullet()) bootSilverBullet(root); else bootStandalone(root);
