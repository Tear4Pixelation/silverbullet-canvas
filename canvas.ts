import { editor, space } from "@silverbulletmd/silverbullet/syscalls";
import { CANVAS_CSS, EDITOR_JS, VIEWER_JS } from "./generated/editor_assets.ts";

// Document editor for .canvas files. SilverBullet puts this HTML into an
// iframe srcdoc; the inlined script talks back via window.silverbullet.
export function canvasEditor(): { html: string } {
  return {
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CANVAS_CSS}</style></head>` +
      `<body><div id="canvas-root"></div><script>${EDITOR_JS}</script></body></html>`,
  };
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function blockValue(body: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "im").exec(body);
  return match ? match[1].trim() : null;
}

function normalizeHeight(value: string | null): string {
  if (!value) return "400px";
  return /^\d+$/.test(value) ? `${value}px` : /^\d+(\.\d+)?(px|em|rem|vh)$/.test(value) ? value : "400px";
}

// Read-only preview for ```canvas blocks:
//   url: Boards/Plan.canvas
//   height: 400px
// pageName is empty when rendered from Lua (canvas.render), which has no block to resize.
export async function showWidget(body: string, pageName?: string): Promise<{ html: string; script: string }> {
  const path = blockValue(body, "url")?.replace(/^\[\[|\]\]$/g, "");
  if (!path) return { html: "<p>Canvas: add a <code>url: path/to/file.canvas</code> line.</p>", script: "" };
  if (!(await space.fileExists(path))) {
    return { html: `<p>Canvas: <code>${escapeAttribute(path)}</code> does not exist.</p>`, script: "" };
  }
  const html = `<style>${CANVAS_CSS}</style>` +
    `<div id="canvas-widget" class="cv-widget" style="height:${normalizeHeight(blockValue(body, "height"))}"` +
    ` data-path="${escapeAttribute(path)}" data-page="${escapeAttribute(pageName ?? "")}" data-body="${escapeAttribute(body)}"></div>`;
  return { html, script: VIEWER_JS };
}

const EMPTY_CANVAS = '{\n\t"nodes":[],\n\t"edges":[]\n}';

async function folderOfCurrentPage(): Promise<string> {
  const page = await editor.getCurrentPage();
  const slash = page.lastIndexOf("/");
  return slash === -1 ? "" : page.slice(0, slash + 1);
}

// Prompts for a name and creates the file; returns its path, or null when cancelled.
async function createCanvasFile(): Promise<string | null> {
  const folder = await folderOfCurrentPage();
  let name = await editor.prompt("New canvas name:", folder + "Untitled");
  if (!name) return null;
  name = name.trim().replace(/^\/+/, "");
  if (!/\.canvas$/i.test(name)) name += ".canvas";
  if (await space.fileExists(name)) {
    if (!(await editor.confirm(`${name} already exists. Use it anyway?`))) return null;
    return name;
  }
  await space.writeFile(name, new TextEncoder().encode(EMPTY_CANVAS));
  return name;
}

const embedBlock = (path: string) => "```canvas\nurl: " + path + "\nheight: 400px\n```\n";

async function pickCanvas(): Promise<string | null> {
  const canvases = (await space.listFiles())
    .filter((file) => /\.canvas$/i.test(file.name))
    .sort((first, second) => second.lastModified - first.lastModified)
    .map((file) => ({ name: file.name, description: "canvas" }));
  if (!canvases.length) {
    await editor.flashNotification("No .canvas files in this space yet", "error");
    return null;
  }
  const picked = await editor.filterBox("Embed canvas", canvases, "Pick a canvas to preview on this page", "Canvas");
  return picked?.name ?? null;
}

export async function newCanvas() {
  const path = await createCanvasFile();
  if (path) await editor.navigate(path);
}

// "/canvas": create a canvas and embed a preview of it here.
export async function insertNewCanvas() {
  const path = await createCanvasFile();
  if (path) await editor.insertAtCursor(embedBlock(path));
}

// "/canvas-embed" and "Canvas: Embed": preview an existing canvas here.
export async function embedCanvas() {
  const path = await pickCanvas();
  if (path) await editor.insertAtCursor(embedBlock(path));
}

// "/canvas-link": create a canvas and link to it.
export async function linkNewCanvas() {
  const path = await createCanvasFile();
  if (path) await editor.insertAtCursor(`[[${path}]]`);
}
