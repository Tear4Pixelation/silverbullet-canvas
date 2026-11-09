import { editor, space } from "@silverbulletmd/silverbullet/syscalls";
import { EDITOR_CSS, EDITOR_JS } from "./generated/editor_assets.ts";

// Document editor for .canvas files. SilverBullet puts this HTML into an
// iframe srcdoc; the inlined script talks back via window.silverbullet.
export function canvasEditor(): { html: string } {
  return {
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EDITOR_CSS}</style></head>` +
      `<body><div id="canvas-root"></div><script>${EDITOR_JS}</script></body></html>`,
  };
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
    if (!(await editor.confirm(`${name} already exists. Open it instead?`))) return null;
    return name;
  }
  await space.writeFile(name, new TextEncoder().encode(EMPTY_CANVAS));
  return name;
}

export async function newCanvas() {
  const path = await createCanvasFile();
  if (path) await editor.navigate(path);
}

export async function insertNewCanvas() {
  const path = await createCanvasFile();
  if (!path) return;
  await editor.insertAtCursor(`[[${path}]]`);
}
