// JSON Canvas 1.0 model (https://jsoncanvas.org).
// Objects are kept as parsed and mutated in place, so unknown properties and
// key order survive a round trip; only the fields we edit ever change.

export type Side = "top" | "right" | "bottom" | "left";
export type EndShape = "none" | "arrow";

export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group" | string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: string;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: EndShape;
  toEnd?: EndShape;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}

export interface Format {
  // "obsidian": tab-indented top level, one compact object per line (what Obsidian writes).
  style: "obsidian" | "json";
  indent: string | number | undefined;
  trailingNewline: boolean;
  hadNodes: boolean;
  hadEdges: boolean;
}

export interface ParsedCanvas {
  data: CanvasData;
  format: Format;
  original: string;
}

function detectIndent(text: string): string | number | undefined {
  const match = /^[{[]\r?\n([ \t]+)\S/.exec(text.trimStart());
  if (!match) return undefined;
  const whitespace = match[1];
  return whitespace[0] === "\t" ? "\t" : whitespace.length;
}

const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function parseCanvas(text: string): ParsedCanvas {
  const trimmed = text.trim();
  const raw = trimmed === "" ? {} : JSON.parse(trimmed);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Not a JSON Canvas file: top level must be an object");
  }
  const data = raw as CanvasData;
  const format: Format = {
    style: trimmed === "" || /^\{\r?\n\t"[^"\n]+":(\[(\r?\n\t\t\{|\])|\{)/.test(trimmed) ? "obsidian" : "json",
    indent: trimmed === "" ? "\t" : detectIndent(text),
    trailingNewline: /\n$/.test(text),
    hadNodes: trimmed === "" || Array.isArray(data.nodes),
    hadEdges: trimmed === "" || Array.isArray(data.edges),
  };
  if (!Array.isArray(data.nodes)) data.nodes = [];
  if (!Array.isArray(data.edges)) data.edges = [];
  // Drop entries that are not objects; keep everything else untouched.
  data.nodes = data.nodes.filter((node) => node && typeof node === "object");
  data.edges = data.edges.filter((edge) => edge && typeof edge === "object");
  for (const node of data.nodes) {
    if (typeof node.id !== "string") node.id = newId();
    // Coerce geometry only when it is unusable, so valid files stay identical.
    if (!Number.isFinite(node.x)) node.x = finite(Number(node.x), 0);
    if (!Number.isFinite(node.y)) node.y = finite(Number(node.y), 0);
    if (!Number.isFinite(node.width)) node.width = finite(Number(node.width), 250);
    if (!Number.isFinite(node.height)) node.height = finite(Number(node.height), 60);
  }
  return { data, format, original: text };
}

export function serializeCanvas(data: CanvasData, format: Format): string {
  let out: CanvasData = data;
  // Files that had no nodes/edges keys stay that way while they are empty.
  if ((!format.hadNodes && data.nodes.length === 0) || (!format.hadEdges && data.edges.length === 0)) {
    out = { ...data };
    if (!format.hadNodes && data.nodes.length === 0) delete (out as Partial<CanvasData>).nodes;
    if (!format.hadEdges && data.edges.length === 0) delete (out as Partial<CanvasData>).edges;
  }
  const json = format.style === "obsidian" ? obsidianJson(out) : JSON.stringify(out, null, format.indent);
  return format.trailingNewline ? json + "\n" : json;
}

function obsidianJson(data: Record<string, unknown>): string {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => {
    const name = JSON.stringify(key);
    if (Array.isArray(value)) {
      if (!value.length) return `\t${name}:[]`;
      return `\t${name}:[\n${value.map((item) => "\t\t" + JSON.stringify(item)).join(",\n")}\n\t]`;
    }
    return `\t${name}:${JSON.stringify(value)}`;
  });
  return entries.length ? `{\n${entries.join(",\n")}\n}` : "{}";
}

// 16 hex chars, like Obsidian's ids.
export function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  return id;
}

export const PRESET_COLORS: Record<string, string> = {
  "1": "#fb464c",
  "2": "#e9973f",
  "3": "#e0de71",
  "4": "#44cf6e",
  "5": "#53dfdd",
  "6": "#a882ff",
};

export function resolveColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (PRESET_COLORS[color]) return PRESET_COLORS[color];
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
