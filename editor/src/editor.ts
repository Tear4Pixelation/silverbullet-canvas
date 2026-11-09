import type { CanvasData, CanvasEdge, CanvasNode, Format, Side } from "./model.ts";
import { clone, newId, parseCanvas, PRESET_COLORS, resolveColor, serializeCanvas } from "./model.ts";
import type { Point, Rect } from "./geometry.ts";
import { boundsOf, contains, curve, edgeGeometry, intersects, nearestSide, normal, sidePoint } from "./geometry.ts";
import { History } from "./history.ts";
import type { Host } from "./host.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { icon } from "./icons.ts";

const GRID = 20;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const LOD_ZOOM = 0.35;
const CULL_THRESHOLD = 120;
const DRAG_THRESHOLD = 4;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const MIME: Record<string, string> = { svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg" };

interface EdgeElements { group: SVGGElement; hit: SVGPathElement; line: SVGPathElement; arrows: SVGPathElement; label: HTMLElement | null }

type Gesture =
  | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number; moved: boolean; clearOnClick: boolean }
  | { kind: "move"; start: Point; origins: Map<string, Point>; moved: boolean; clickTarget: Element; clickId: string; shift: boolean; wasSelected: boolean }
  | { kind: "resize"; id: string; start: Point; origin: Rect }
  | { kind: "connect"; fromId: string; fromSide: Side; pointer: Point }
  | { kind: "marquee"; start: Point; additive: Set<string> }
  | { kind: "edgeClick"; id: string; shift: boolean }
  | { kind: "pinch"; distance: number; center: Point; zoom: number; viewX: number; viewY: number };

const svgNS = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string) => {
  const element = document.createElementNS(svgNS, tag);
  if (cls) element.setAttribute("class", cls);
  return element;
};
const div = (cls: string, parent?: HTMLElement) => {
  const element = document.createElement("div");
  element.className = cls;
  parent?.appendChild(element);
  return element;
};

export class CanvasEditor {
  private data: CanvasData = { nodes: [], edges: [] };
  private format: Format = { style: "obsidian", indent: "\t", trailingNewline: false, hadNodes: true, hadEdges: true };
  private original = "";
  private dirty = false;
  private readOnly = false;
  private snap = true;

  private nodeById = new Map<string, CanvasNode>();
  private edgeById = new Map<string, CanvasEdge>();
  private edgesByNode = new Map<string, Set<string>>();
  private nodeEls = new Map<string, HTMLElement>();
  private contentKeys = new Map<string, string>();
  private edgeEls = new Map<string, EdgeElements>();
  private selection = new Set<string>();
  private history = new History(() => this.data);

  private view = { x: 0, y: 0, zoom: 1 };
  private dirtyNodes = new Set<string>();
  private dirtyEdges = new Set<string>();
  private structureDirty = true;
  private viewDirty = true;
  private selectionDirty = true;
  private frame = 0;

  private gesture: Gesture | null = null;
  private pointers = new Map<number, Point>();
  private spaceHeld = false;
  private lastPointer: Point = { x: 0, y: 0 };
  private zoomTimer = 0;
  private pendingFit = false;
  // Cached so render passes never read layout (reads after style writes force reflow).
  private viewportSize = { width: 0, height: 0 };
  private frameVisibleRect: Rect | null = null;
  private editing: { id: string; textarea: HTMLTextAreaElement; isNew: boolean } | null = null;
  private clipboard: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;
  private fileCache = new Map<string, Promise<string | null>>();

  private viewport: HTMLElement;
  private world: HTMLElement;
  private groupLayer: HTMLElement;
  private edgeSvg: SVGSVGElement;
  private nodeLayer: HTMLElement;
  private labelLayer: HTMLElement;
  private tempEdge: SVGPathElement;
  private marquee: HTMLElement;
  private selectionTools: HTMLElement;
  private toolbar: HTMLElement;
  private zoomLabel!: HTMLElement;
  private emptyHint: HTMLElement;

  constructor(private root: HTMLElement, private host: Host) {
    root.classList.add("cv-root");
    root.innerHTML = "";
    this.viewport = div("cv-viewport", root);
    this.viewport.tabIndex = 0;
    this.world = div("cv-world", this.viewport);
    this.groupLayer = div("cv-layer cv-groups", this.world);
    this.edgeSvg = svg("svg", "cv-edges");
    this.world.appendChild(this.edgeSvg);
    this.tempEdge = svg("path", "cv-edge-line cv-temp-edge");
    this.nodeLayer = div("cv-layer cv-nodes", this.world);
    this.labelLayer = div("cv-layer cv-labels", this.world);
    this.marquee = div("cv-marquee", this.viewport);
    this.emptyHint = div("cv-empty", this.viewport);
    this.selectionTools = div("cv-seltools cv-bar", root);
    this.toolbar = div("cv-toolbar cv-bar", root);
    this.bindEvents();
  }

  // ---------- loading / saving ----------

  async load(text: string, keepView: boolean) {
    this.cancelEditing(false);
    const parsed = parseCanvas(text);
    this.data = parsed.data;
    this.format = parsed.format;
    this.original = text;
    this.dirty = false;
    this.history.reset();
    this.readOnly = await this.host.readOnly();
    this.root.classList.toggle("cv-readonly", this.readOnly);
    this.fileCache.clear();
    for (const id of [...this.selection]) if (!this.data.nodes.some((node) => node.id === id) && !this.data.edges.some((edge) => edge.id === id)) this.selection.delete(id);
    this.viewportSize = { width: this.viewport.clientWidth, height: this.viewport.clientHeight };
    this.rebuildAll();
    this.buildToolbar();
    if (!keepView) this.zoomToFit(false);
    this.requestRender();
  }

  // The exact original bytes come back while nothing was edited.
  serialize(): string {
    return this.dirty ? serializeCanvas(this.data, this.format) : this.original;
  }

  markSaved(text: string) {
    this.original = text;
    this.dirty = false;
  }

  isCurrent(text: string) { return text === this.serialize(); }

  focus() { this.viewport.focus({ preventScroll: true }); }

  // ---------- indexing ----------

  private rebuildAll() {
    this.nodeById.clear();
    this.edgeById.clear();
    this.edgesByNode.clear();
    for (const node of this.data.nodes) this.nodeById.set(node.id, node);
    for (const edge of this.data.edges) {
      this.edgeById.set(edge.id, edge);
      for (const nodeId of [edge.fromNode, edge.toNode]) {
        let set = this.edgesByNode.get(nodeId);
        if (!set) this.edgesByNode.set(nodeId, (set = new Set()));
        set.add(edge.id);
      }
    }
    // Drop DOM for objects that are gone.
    for (const [id, element] of this.nodeEls) if (!this.nodeById.has(id)) { element.remove(); this.nodeEls.delete(id); this.contentKeys.delete(id); }
    for (const [id, elements] of this.edgeEls) if (!this.edgeById.has(id)) { elements.group.remove(); elements.label?.remove(); this.edgeEls.delete(id); }
    for (const id of this.nodeById.keys()) this.dirtyNodes.add(id);
    for (const id of this.edgeById.keys()) this.dirtyEdges.add(id);
    this.structureDirty = true;
    this.selectionDirty = true;
  }

  // ---------- transactions ----------

  private transact(mutate: () => void) {
    if (this.readOnly) return;
    this.history.begin([...this.selection]);
    mutate();
    if (this.history.commit()) {
      this.dirty = true;
      this.host.changed();
    }
    this.requestRender();
  }

  private touchNode(node: CanvasNode) {
    this.history.touchNode(node.id);
    this.dirtyNodes.add(node.id);
    for (const edgeId of this.edgesByNode.get(node.id) ?? []) this.dirtyEdges.add(edgeId);
    this.selectionDirty = true;
  }

  private touchEdge(edge: CanvasEdge) {
    this.history.touchEdge(edge.id);
    this.dirtyEdges.add(edge.id);
    this.selectionDirty = true;
  }

  private addNode(node: CanvasNode) {
    this.history.touchNode(node.id);
    this.data.nodes.push(node);
    this.rebuildAll();
  }

  private addEdge(edge: CanvasEdge) {
    this.history.touchEdge(edge.id);
    this.data.edges.push(edge);
    this.rebuildAll();
  }

  private undo() { this.applyHistory(this.history.undo()); }
  private redo() { this.applyHistory(this.history.redo()); }

  private applyHistory(selection: string[] | null) {
    if (!selection || this.readOnly) return;
    this.cancelEditing(false);
    this.rebuildAll();
    this.selection = new Set(selection.filter((id) => this.nodeById.has(id) || this.edgeById.has(id)));
    this.dirty = true;
    this.host.changed();
    this.requestRender();
  }

  // ---------- coordinates ----------

  private toWorld(clientX: number, clientY: number): Point {
    const rect = this.viewport.getBoundingClientRect();
    return { x: (clientX - rect.left - this.view.x) / this.view.zoom, y: (clientY - rect.top - this.view.y) / this.view.zoom };
  }

  private toScreen(point: Point): Point {
    return { x: point.x * this.view.zoom + this.view.x, y: point.y * this.view.zoom + this.view.y };
  }

  private snapValue(value: number, bypass = false) {
    return this.snap && !bypass ? Math.round(value / GRID) * GRID : Math.round(value);
  }

  // ---------- view ----------

  setZoom(zoom: number, anchor?: Point) {
    const rect = this.viewport.getBoundingClientRect();
    const screenAnchor = anchor ?? { x: rect.width / 2, y: rect.height / 2 };
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const worldX = (screenAnchor.x - this.view.x) / this.view.zoom;
    const worldY = (screenAnchor.y - this.view.y) / this.view.zoom;
    this.view.zoom = clamped;
    this.view.x = screenAnchor.x - worldX * clamped;
    this.view.y = screenAnchor.y - worldY * clamped;
    this.markZooming();
    this.viewDirty = true;
    this.requestRender();
  }

  // Keep the world layer promoted only while zooming, so text re-rasterizes crisply afterwards.
  private markZooming() {
    this.world.classList.add("cv-zooming");
    clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.world.classList.remove("cv-zooming"), 180);
  }

  zoomToFit(animate = true, ids?: string[]) {
    const nodes = ids ? ids.map((id) => this.nodeById.get(id)).filter(Boolean) as CanvasNode[] : this.data.nodes;
    const bounds = boundsOf(nodes);
    const rect = this.viewport.getBoundingClientRect();
    // Not laid out yet (hidden iframe): fit once the ResizeObserver sees a size.
    this.pendingFit = rect.width === 0 || rect.height === 0;
    if (this.pendingFit && !ids) return;
    if (!bounds) {
      this.view = { x: rect.width / 2, y: rect.height / 2, zoom: 1 };
    } else {
      const padding = 60;
      const zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min((rect.width - padding * 2) / bounds.width, (rect.height - padding * 2) / bounds.height)));
      this.view = {
        zoom,
        x: rect.width / 2 - (bounds.x + bounds.width / 2) * zoom,
        y: rect.height / 2 - (bounds.y + bounds.height / 2) * zoom,
      };
    }
    if (animate) this.markZooming();
    this.viewDirty = true;
    this.requestRender();
  }

  // ---------- rendering ----------

  private requestRender() {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private render() {
    this.frameVisibleRect = this.computeVisibleRect();
    if (this.structureDirty) this.renderStructure();
    for (const id of this.dirtyNodes) this.renderNode(id);
    this.dirtyNodes.clear();
    for (const id of this.dirtyEdges) this.renderEdge(id);
    this.dirtyEdges.clear();
    if (this.viewDirty) this.renderView();
    if (this.selectionDirty || this.viewDirty) this.renderSelection();
    this.viewDirty = false;
    this.selectionDirty = false;
    this.structureDirty = false;
  }

  private renderStructure() {
    // Groups go into their own layer behind edges, biggest first so nested ones stay clickable.
    const groups = this.data.nodes.filter((node) => node.type === "group").sort((first, second) => second.width * second.height - first.width * first.height);
    const others = this.data.nodes.filter((node) => node.type !== "group");
    const order = (layer: HTMLElement, nodes: CanvasNode[]) => {
      let cursor = layer.firstChild;
      for (const node of nodes) {
        const element = this.nodeElement(node);
        if (element === cursor) cursor = cursor.nextSibling;
        else layer.insertBefore(element, cursor);
      }
    };
    order(this.groupLayer, groups);
    order(this.nodeLayer, others);
    for (const edge of this.data.edges) this.edgeElements(edge);
    this.emptyHint.textContent = this.data.nodes.length ? "" : this.readOnly ? "Empty canvas" : "Double-click to add a card";
    this.emptyHint.hidden = this.data.nodes.length > 0;
  }

  private nodeElement(node: CanvasNode): HTMLElement {
    let element = this.nodeEls.get(node.id);
    if (!element) {
      element = document.createElement("div");
      element.dataset.id = node.id;
      this.nodeEls.set(node.id, element);
      this.dirtyNodes.add(node.id);
    }
    return element;
  }

  private renderNode(id: string) {
    const node = this.nodeById.get(id);
    const element = this.nodeEls.get(id);
    if (!node || !element) return;
    const type = ["text", "file", "link", "group"].includes(node.type) ? node.type : "unknown";
    element.className = `cv-node cv-${type}` + (this.selection.has(id) ? " cv-selected" : "") + (node.color ? " cv-colored" : "") + (this.editing?.id === id ? " cv-editing" : "");
    element.style.transform = `translate(${node.x}px,${node.y}px)`;
    element.style.width = `${node.width}px`;
    element.style.height = `${node.height}px`;
    const color = resolveColor(node.color);
    if (color) element.style.setProperty("--cv-color", color); else element.style.removeProperty("--cv-color");

    // Big canvases: off-screen cards are hidden and their content is only built once they
    // come into view (and not at all while zoomed out to the low-detail level).
    const visibleRect = this.frameVisibleRect;
    const visible = !visibleRect || intersects(visibleRect, node) || this.selection.has(id);
    const display = visible ? "" : "none";
    if (element.style.display !== display) element.style.display = display;
    const key = JSON.stringify([type, node.text, node.file, node.subpath, node.url, node.label, node.background]);
    if (type !== "group" && (!visible || (visibleRect && this.view.zoom < LOD_ZOOM))) {
      if (this.contentKeys.has(id) && this.contentKeys.get(id) !== key) this.contentKeys.delete(id);
      return;
    }
    if (this.contentKeys.get(id) === key || this.editing?.id === id) return;
    this.contentKeys.set(id, key);
    element.innerHTML = this.nodeContent(node, type);
    if (!this.readOnly) {
      element.insertAdjacentHTML("beforeend",
        '<div class="cv-connector" data-side="top"></div><div class="cv-connector" data-side="right"></div>' +
        '<div class="cv-connector" data-side="bottom"></div><div class="cv-connector" data-side="left"></div><div class="cv-resize"></div>');
    }
    if (type === "file") this.loadFilePreview(node, element);
  }

  private nodeContent(node: CanvasNode, type: string): string {
    switch (type) {
      case "text":
        return `<div class="cv-content cv-markdown">${renderMarkdown(node.text ?? "")}</div>`;
      case "group":
        return `<div class="cv-group-label">${escapeHtml(node.label ?? "")}</div>`;
      case "link": {
        const url = node.url ?? "";
        let host = url;
        try { host = new URL(url).hostname; } catch { /* keep raw */ }
        return `<div class="cv-content cv-linkcard"><div class="cv-linkhost">${icon("link", 14)} ${escapeHtml(host)}</div><a class="cv-url" href="${escapeHtml(url)}">${escapeHtml(url)}</a></div>`;
      }
      case "file": {
        const file = node.file ?? "";
        const name = file.split("/").pop() ?? file;
        const display = name.replace(/\.md$/i, "") + (node.subpath ?? "");
        return `<div class="cv-file-title" title="${escapeHtml(file)}">${icon(IMAGE_EXT.test(file) ? "image" : "file", 13)}<span>${escapeHtml(display)}</span></div><div class="cv-content cv-filebody"><div class="cv-muted">${escapeHtml(file)}</div></div>`;
      }
      default:
        return `<div class="cv-content cv-muted">${escapeHtml(String(node.type))} node</div>`;
    }
  }

  private loadFilePreview(node: CanvasNode, element: HTMLElement) {
    const file = node.file ?? "";
    const isImage = IMAGE_EXT.test(file);
    const isPage = /\.md$/i.test(file);
    if (!isImage && !isPage) return;
    let pending = this.fileCache.get(file);
    if (!pending) {
      pending = this.host.readFile(file).then((bytes) => {
        if (!bytes) return null;
        if (isImage) {
          const extension = file.split(".").pop()!.toLowerCase();
          return URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[extension] ?? `image/${extension}` }));
        }
        const text = new TextDecoder().decode(bytes);
        return renderMarkdown(text.length > 20000 ? text.slice(0, 20000) + "\n\n…" : text);
      });
      this.fileCache.set(file, pending);
    }
    pending.then((result) => {
      const body = element.querySelector(".cv-filebody");
      if (!result || !body || this.nodeById.get(node.id)?.file !== file) return;
      if (isImage) {
        body.className = "cv-content cv-filebody cv-imagebody";
        body.innerHTML = `<img src="${result}" alt="" draggable="false">`;
      } else {
        body.className = "cv-content cv-filebody cv-markdown";
        body.innerHTML = result;
      }
    });
  }

  private edgeElements(edge: CanvasEdge): EdgeElements {
    let elements = this.edgeEls.get(edge.id);
    if (!elements) {
      const group = svg("g", "cv-edge");
      group.dataset.id = edge.id;
      const hit = svg("path", "cv-edge-hit");
      const line = svg("path", "cv-edge-line");
      const arrows = svg("path", "cv-edge-arrows");
      group.append(hit, line, arrows);
      this.edgeSvg.appendChild(group);
      elements = { group, hit, line, arrows, label: null };
      this.edgeEls.set(edge.id, elements);
      this.dirtyEdges.add(edge.id);
    }
    return elements;
  }

  private renderEdge(id: string) {
    const edge = this.edgeById.get(id);
    const elements = this.edgeEls.get(id);
    if (!edge || !elements) return;
    const from = this.nodeById.get(edge.fromNode);
    const to = this.nodeById.get(edge.toNode);
    if (!from || !to) { elements.group.style.display = "none"; elements.label?.remove(); elements.label = null; return; }
    elements.group.style.display = "";
    const geometry = edgeGeometry(edge, from, to);
    elements.hit.setAttribute("d", geometry.path);
    elements.line.setAttribute("d", geometry.path);
    elements.arrows.setAttribute("d", geometry.arrows);
    const color = resolveColor(edge.color);
    elements.group.setAttribute("class", "cv-edge" + (this.selection.has(id) ? " cv-selected" : ""));
    if (color) elements.group.style.setProperty("--cv-color", color); else elements.group.style.removeProperty("--cv-color");
    if (edge.label) {
      if (!elements.label) {
        elements.label = div("cv-edge-label", this.labelLayer);
        elements.label.dataset.edge = id;
      }
      elements.label.textContent = edge.label;
      elements.label.style.transform = `translate(${geometry.mid.x}px,${geometry.mid.y}px) translate(-50%,-50%)`;
      elements.label.classList.toggle("cv-selected", this.selection.has(id));
      if (color) elements.label.style.setProperty("--cv-color", color); else elements.label.style.removeProperty("--cv-color");
    } else if (elements.label) {
      elements.label.remove();
      elements.label = null;
    }
  }

  private renderView() {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    let gridSize = GRID * zoom;
    while (gridSize < 10) gridSize *= 5;
    this.viewport.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    this.root.classList.toggle("cv-lod", zoom < LOD_ZOOM);
    this.root.classList.toggle("cv-nogrid", zoom < 0.2);
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    this.cull();
  }

  // World rect worth rendering on big canvases (null: render everything).
  private computeVisibleRect(): Rect | null {
    if (this.data.nodes.length < CULL_THRESHOLD) return null;
    const { width, height } = this.viewportSize;
    if (!width || !height) return { x: 0, y: 0, width: 0, height: 0 }; // not measured yet: build nothing
    const margin = 300 / this.view.zoom;
    return {
      x: -this.view.x / this.view.zoom - margin,
      y: -this.view.y / this.view.zoom - margin,
      width: width / this.view.zoom + margin * 2,
      height: height / this.view.zoom + margin * 2,
    };
  }

  // Hide far off-screen nodes on big canvases; the browser then skips their layout and paint.
  private cull() {
    const visibleRect = this.frameVisibleRect;
    const detailed = this.view.zoom >= LOD_ZOOM;
    for (const node of this.data.nodes) {
      const element = this.nodeEls.get(node.id);
      if (!element) continue;
      const visible = !visibleRect || intersects(visibleRect, node) || this.selection.has(node.id);
      if (visible && detailed && !this.contentKeys.has(node.id)) { this.renderNode(node.id); continue; }
      const display = visible ? "" : "none";
      if (element.style.display !== display) element.style.display = display;
    }
  }

  private renderSelection() {
    for (const [id, element] of this.nodeEls) element.classList.toggle("cv-selected", this.selection.has(id));
    for (const [id, elements] of this.edgeEls) {
      const selected = this.selection.has(id);
      elements.group.classList.toggle("cv-selected", selected);
      elements.label?.classList.toggle("cv-selected", selected);
    }
    this.renderSelectionTools();
    this.updateToolbarState();
  }

  // ---------- selection tools ----------

  private selectedNodes() { return [...this.selection].map((id) => this.nodeById.get(id)).filter(Boolean) as CanvasNode[]; }
  private selectedEdges() { return [...this.selection].map((id) => this.edgeById.get(id)).filter(Boolean) as CanvasEdge[]; }

  private renderSelectionTools() {
    const nodes = this.selectedNodes();
    const edges = this.selectedEdges();
    const tools = this.selectionTools;
    if ((!nodes.length && !edges.length) || this.gesture?.kind === "move" || this.gesture?.kind === "resize" || this.editing) {
      tools.hidden = true;
      return;
    }
    const key = [...this.selection].join() + (this.readOnly ? "r" : "w");
    if (tools.dataset.key !== key) {
      tools.dataset.key = key;
      const buttons: string[] = [];
      if (!this.readOnly) {
        buttons.push(`<button data-act="color" data-color="" class="cv-swatch" title="No color"></button>`);
        for (const [preset, color] of Object.entries(PRESET_COLORS)) {
          buttons.push(`<button data-act="color" data-color="${preset}" class="cv-swatch" style="--cv-color:${color}" title="Color ${preset}"></button>`);
        }
        buttons.push(`<button data-act="customColor" class="cv-swatch cv-swatch-custom" title="Custom color"></button>`);
        buttons.push('<span class="cv-sep"></span>');
      }
      const single = nodes.length + edges.length === 1;
      if (single && nodes[0]?.type === "text" && !this.readOnly) buttons.push(`<button data-act="edit" title="Edit (Enter)">${icon("edit")}</button>`);
      if (single && (nodes[0]?.type === "file" || nodes[0]?.type === "link")) buttons.push(`<button data-act="open" title="Open">${icon("open")}</button>`);
      if (!this.readOnly && single && (edges[0] || nodes[0]?.type === "group")) buttons.push(`<button data-act="label" title="Edit label">${icon("edit")}</button>`);
      if (!this.readOnly && edges.length) {
        buttons.push(`<button data-act="ends" data-ends="none" title="Line">${icon("line")}</button>`);
        buttons.push(`<button data-act="ends" data-ends="to" title="Arrow">${icon("arrowRight")}</button>`);
        buttons.push(`<button data-act="ends" data-ends="both" title="Both ends">${icon("arrowBoth")}</button>`);
      }
      if (nodes.length > 1) buttons.push(`<button data-act="zoomSel" title="Zoom to selection">${icon("fit")}</button>`);
      if (!this.readOnly) buttons.push(`<button data-act="delete" title="Delete (Del)">${icon("trash")}</button>`);
      tools.innerHTML = buttons.join("");
    }
    tools.hidden = tools.childElementCount === 0;
    if (tools.hidden) return;

    const rects: Rect[] = nodes.slice();
    for (const edge of edges) {
      const from = this.nodeById.get(edge.fromNode), to = this.nodeById.get(edge.toNode);
      if (from && to) { const mid = edgeGeometry(edge, from, to).mid; rects.push({ x: mid.x, y: mid.y, width: 0, height: 0 }); }
    }
    const bounds = boundsOf(rects);
    if (!bounds) { tools.hidden = true; return; }
    const topLeft = this.toScreen({ x: bounds.x, y: bounds.y });
    const bottomRight = this.toScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
    const width = tools.offsetWidth, height = tools.offsetHeight;
    const viewportRect = this.viewport.getBoundingClientRect();
    let left = (topLeft.x + bottomRight.x) / 2 - width / 2;
    let top = topLeft.y - height - 14;
    if (top < 8) top = Math.min(bottomRight.y + 14, viewportRect.height - height - 64);
    left = Math.max(8, Math.min(left, viewportRect.width - width - 8));
    top = Math.max(8, top);
    tools.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }

  private selectionAction(button: HTMLElement) {
    const action = button.dataset.act;
    const nodes = this.selectedNodes();
    const edges = this.selectedEdges();
    switch (action) {
      case "color": {
        const color = button.dataset.color || undefined;
        this.setColor(nodes, edges, color);
        break;
      }
      case "customColor": {
        const input = document.createElement("input");
        input.type = "color";
        input.value = resolveColor(nodes[0]?.color ?? edges[0]?.color) ?? "#888888";
        input.addEventListener("input", () => this.setColor(this.selectedNodes(), this.selectedEdges(), input.value));
        input.click();
        break;
      }
      case "edit": if (nodes[0]) this.startEditing(nodes[0].id, false); break;
      case "open": if (nodes[0]) this.openNode(nodes[0]); break;
      case "label": void this.editLabel(); break;
      case "ends": {
        const ends = button.dataset.ends;
        this.transact(() => {
          for (const edge of edges) {
            this.touchEdge(edge);
            if (ends === "both") edge.fromEnd = "arrow"; else if (edge.fromEnd !== undefined) edge.fromEnd = "none";
            if (ends === "none") edge.toEnd = "none"; else if (edge.toEnd !== undefined) edge.toEnd = "arrow";
          }
        });
        break;
      }
      case "zoomSel": this.zoomToFit(true, nodes.map((node) => node.id)); break;
      case "delete": this.deleteSelection(); break;
    }
  }

  private setColor(nodes: CanvasNode[], edges: CanvasEdge[], color: string | undefined) {
    this.transact(() => {
      for (const node of nodes) { this.touchNode(node); if (color) node.color = color; else delete node.color; this.contentKeys.delete(node.id); }
      for (const edge of edges) { this.touchEdge(edge); if (color) edge.color = color; else delete edge.color; }
    });
  }

  private async editLabel() {
    const edge = this.selectedEdges()[0];
    const group = edge ? undefined : this.selectedNodes().find((node) => node.type === "group");
    const target = edge ?? group;
    if (!target) return;
    const value = await this.host.prompt(edge ? "Edge label" : "Group label", target.label ?? "");
    if (value === null) return;
    this.transact(() => {
      if (edge) this.touchEdge(edge); else this.touchNode(group!);
      if (value) target.label = value; else delete target.label;
    });
    this.focus();
  }

  // ---------- toolbar ----------

  private buildToolbar() {
    const parts: string[] = [];
    if (!this.readOnly) {
      parts.push(
        `<button data-tool="text" title="Add card (double-click canvas)">${icon("card")}</button>`,
        `<button data-tool="file" title="Add page or document">${icon("file")}</button>`,
        `<button data-tool="link" title="Add web link">${icon("link")}</button>`,
        `<button data-tool="group" title="Add group (wraps selection)">${icon("group")}</button>`,
        '<span class="cv-sep"></span>',
      );
    }
    parts.push(
      `<button data-tool="zoomOut" title="Zoom out (-)">${icon("zoomOut")}</button>`,
      `<button data-tool="zoomReset" class="cv-zoom" title="Reset zoom (Shift+0)">100%</button>`,
      `<button data-tool="zoomIn" title="Zoom in (+)">${icon("zoomIn")}</button>`,
      `<button data-tool="fit" title="Zoom to fit (Shift+1)">${icon("fit")}</button>`,
    );
    if (!this.readOnly) {
      parts.push(
        '<span class="cv-sep"></span>',
        `<button data-tool="undo" title="Undo (Ctrl+Z)">${icon("undo")}</button>`,
        `<button data-tool="redo" title="Redo (Ctrl+Shift+Z)">${icon("redo")}</button>`,
        `<button data-tool="snap" title="Snap to grid">${icon("grid")}</button>`,
      );
    }
    this.toolbar.innerHTML = parts.join("");
    this.zoomLabel = this.toolbar.querySelector(".cv-zoom")!;
    this.viewDirty = true;
  }

  private updateToolbarState() {
    this.toolbar.querySelector<HTMLButtonElement>('[data-tool="undo"]')?.toggleAttribute("disabled", !this.history.canUndo);
    this.toolbar.querySelector<HTMLButtonElement>('[data-tool="redo"]')?.toggleAttribute("disabled", !this.history.canRedo);
    this.toolbar.querySelector('[data-tool="snap"]')?.classList.toggle("cv-active", this.snap);
  }

  private viewCenter(): Point {
    const rect = this.viewport.getBoundingClientRect();
    return this.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  private async toolAction(tool: string) {
    const center = this.viewCenter();
    switch (tool) {
      case "text": this.createTextNode(center, true); break;
      case "file": {
        const file = await this.host.pickFile();
        if (file) this.createNode({ type: "file", file }, center, IMAGE_EXT.test(file) ? 400 : 400, IMAGE_EXT.test(file) ? 300 : 400);
        this.focus();
        break;
      }
      case "link": {
        const url = await this.host.prompt("Link URL", "https://");
        if (url && url !== "https://") this.createNode({ type: "link", url }, center, 400, 120);
        this.focus();
        break;
      }
      case "group": this.createGroup(center); break;
      case "zoomIn": this.setZoom(this.view.zoom * 1.25); break;
      case "zoomOut": this.setZoom(this.view.zoom / 1.25); break;
      case "zoomReset": this.setZoom(1); break;
      case "fit": this.zoomToFit(); break;
      case "undo": this.undo(); break;
      case "redo": this.redo(); break;
      case "snap": this.snap = !this.snap; this.updateToolbarState(); break;
    }
  }

  // ---------- creation ----------

  private createNode(fields: Partial<CanvasNode>, center: Point, width: number, height: number): CanvasNode {
    const node = {
      id: newId(),
      type: "text",
      ...fields,
      x: this.snapValue(center.x - width / 2),
      y: this.snapValue(center.y - height / 2),
      width,
      height,
    } as CanvasNode;
    // Obsidian writes id/type/text first; keep that key order.
    const { id, type, text, ...rest } = node;
    const ordered: CanvasNode = { id, type, ...(text !== undefined ? { text } : {}), ...rest };
    this.transact(() => this.addNode(ordered));
    this.selection = new Set([ordered.id]);
    this.selectionDirty = true;
    return this.nodeById.get(ordered.id)!;
  }

  private createTextNode(center: Point, edit: boolean): CanvasNode {
    const node = this.createNode({ type: "text", text: "" }, center, 260, 80);
    if (edit) this.startEditing(node.id, true);
    return node;
  }

  private createGroup(center: Point) {
    const selected = this.selectedNodes();
    const bounds = boundsOf(selected);
    if (bounds) {
      const padding = 40;
      const rect = { x: bounds.x - padding, y: bounds.y - padding - 20, width: bounds.width + padding * 2, height: bounds.height + padding * 2 + 20 };
      const node: CanvasNode = { id: newId(), type: "group", x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), label: "Group" };
      this.transact(() => this.addNode(node));
      this.selection = new Set([node.id]);
    } else {
      this.createNode({ type: "group", label: "Group" }, center, 600, 400);
    }
    this.selectionDirty = true;
    this.requestRender();
  }

  // ---------- text editing ----------

  private startEditing(id: string, isNew: boolean) {
    if (this.readOnly) return;
    this.cancelEditing(true);
    const node = this.nodeById.get(id);
    if (!node || node.type !== "text") return;
    this.render(); // make sure the element exists
    const element = this.nodeEls.get(id)!;
    const textarea = document.createElement("textarea");
    textarea.className = "cv-textarea";
    textarea.value = node.text ?? "";
    textarea.spellcheck = true;
    element.querySelector(".cv-content")?.replaceWith(textarea);
    element.classList.add("cv-editing");
    this.editing = { id, textarea, isNew };
    this.selection = new Set([id]);
    this.selectionDirty = true;
    this.requestRender();
    textarea.addEventListener("blur", () => this.finishEditing());
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        this.finishEditing();
        this.focus();
      }
      event.stopPropagation();
    });
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  private finishEditing() { this.cancelEditing(true); }

  private cancelEditing(commit: boolean) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const node = this.nodeById.get(editing.id);
    const element = this.nodeEls.get(editing.id);
    element?.classList.remove("cv-editing");
    this.contentKeys.delete(editing.id);
    this.dirtyNodes.add(editing.id);
    if (commit && node) {
      const text = editing.textarea.value;
      if (editing.isNew && !text.trim()) {
        this.transact(() => this.removeObjects(new Set([node.id])));
      } else if (text !== (node.text ?? "")) {
        this.transact(() => { this.touchNode(node); node.text = text; });
      }
    }
    this.selectionDirty = true;
    this.requestRender();
  }

  // ---------- deletion / clipboard ----------

  private removeObjects(ids: Set<string>) {
    for (const node of this.data.nodes) if (ids.has(node.id)) {
      this.history.touchNode(node.id);
      for (const edgeId of this.edgesByNode.get(node.id) ?? []) ids.add(edgeId);
    }
    for (const edge of this.data.edges) if (ids.has(edge.id)) this.history.touchEdge(edge.id);
    this.data.nodes = this.data.nodes.filter((node) => !ids.has(node.id));
    this.data.edges = this.data.edges.filter((edge) => !ids.has(edge.id));
    for (const id of ids) this.selection.delete(id);
    this.rebuildAll();
  }

  private deleteSelection() {
    if (!this.selection.size) return;
    this.transact(() => this.removeObjects(new Set(this.selection)));
  }

  private copySelection(): string | null {
    const nodes = this.selectedNodes();
    if (!nodes.length && !this.selectedEdges().length) return null;
    const ids = new Set(nodes.map((node) => node.id));
    // Include nodes inside selected groups, and edges between copied nodes.
    for (const group of nodes.filter((node) => node.type === "group")) {
      for (const node of this.data.nodes) if (!ids.has(node.id) && contains(group, node)) { ids.add(node.id); nodes.push(node); }
    }
    const edges = this.data.edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode));
    this.clipboard = { nodes: clone(nodes), edges: clone(edges) };
    return JSON.stringify(this.clipboard);
  }

  private paste(payload: { nodes: CanvasNode[]; edges: CanvasEdge[] }, at: Point) {
    const bounds = boundsOf(payload.nodes);
    if (!bounds) return;
    const dx = this.snapValue(at.x - (bounds.x + bounds.width / 2));
    const dy = this.snapValue(at.y - (bounds.y + bounds.height / 2));
    const idMap = new Map<string, string>();
    const nodes = clone(payload.nodes).map((node) => {
      idMap.set(node.id, newId());
      return { ...node, id: idMap.get(node.id)!, x: Math.round(node.x + dx), y: Math.round(node.y + dy) };
    });
    const edges = clone(payload.edges)
      .filter((edge) => idMap.has(edge.fromNode) && idMap.has(edge.toNode))
      .map((edge) => ({ ...edge, id: newId(), fromNode: idMap.get(edge.fromNode)!, toNode: idMap.get(edge.toNode)! }));
    this.transact(() => {
      for (const node of nodes) { this.history.touchNode(node.id); this.data.nodes.push(node); }
      for (const edge of edges) { this.history.touchEdge(edge.id); this.data.edges.push(edge); }
      this.rebuildAll();
    });
    this.selection = new Set(nodes.map((node) => node.id));
    this.selectionDirty = true;
    this.requestRender();
  }

  private handlePaste(event: ClipboardEvent) {
    if (this.readOnly || this.editing || isTextInput(event.target)) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const at = this.lastPointerInside() ? this.lastPointer : this.viewCenter();
    event.preventDefault();
    try {
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.nodes)) {
        this.paste({ nodes: parsed.nodes.filter((node: unknown) => node && typeof node === "object"), edges: Array.isArray(parsed.edges) ? parsed.edges : [] }, at);
        return;
      }
    } catch { /* not canvas JSON */ }
    if (!text.trim()) { if (this.clipboard) this.paste(this.clipboard, at); return; }
    if (/^https?:\/\/\S+$/.test(text.trim())) this.createNode({ type: "link", url: text.trim() }, at, 400, 120);
    else this.createNode({ type: "text", text }, at, 300, Math.min(400, 60 + text.split("\n").length * 24));
  }

  private lastPointerInside() {
    const rect = this.viewport.getBoundingClientRect();
    const screen = this.toScreen(this.lastPointer);
    return screen.x >= 0 && screen.y >= 0 && screen.x <= rect.width && screen.y <= rect.height;
  }

  // ---------- opening ----------

  private openNode(node: CanvasNode) {
    if (node.type === "file" && node.file) this.host.navigate(node.file, node.subpath);
    else if (node.type === "link" && node.url) this.host.openUrl(node.url);
  }

  // ---------- events ----------

  private bindEvents() {
    const viewport = this.viewport;
    viewport.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    viewport.addEventListener("pointermove", (event) => this.onPointerMove(event));
    viewport.addEventListener("pointerup", (event) => this.onPointerUp(event));
    viewport.addEventListener("pointercancel", (event) => this.onPointerUp(event));
    viewport.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    viewport.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    // Links are handled on pointerup; never let the iframe navigate itself.
    document.addEventListener("click", (event) => {
      if ((event.target as Element).closest?.("a")) event.preventDefault();
    }, true);
    viewport.addEventListener("contextmenu", (event) => { if (!isTextInput(event.target)) event.preventDefault(); });
    this.toolbar.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-tool]");
      if (button) void this.toolAction(button.dataset.tool!);
    });
    this.selectionTools.addEventListener("pointerdown", (event) => event.preventDefault());
    this.selectionTools.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-act]");
      if (button) this.selectionAction(button);
    });
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => { if (event.key === " ") { this.spaceHeld = false; this.root.classList.remove("cv-panning"); } });
    window.addEventListener("blur", () => { this.spaceHeld = false; });
    document.addEventListener("paste", (event) => this.handlePaste(event));
    document.addEventListener("copy", (event) => {
      if (this.editing || isTextInput(event.target)) return;
      const json = this.copySelection();
      if (json) { event.clipboardData?.setData("text/plain", json); event.preventDefault(); }
    });
    document.addEventListener("cut", (event) => {
      if (this.editing || isTextInput(event.target) || this.readOnly) return;
      const json = this.copySelection();
      if (json) { event.clipboardData?.setData("text/plain", json); event.preventDefault(); this.deleteSelection(); }
    });
    new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      this.viewportSize = { width: box.width, height: box.height };
      if (this.pendingFit) this.zoomToFit(false);
      this.viewDirty = true;
      this.requestRender();
    }).observe(viewport);
  }

  private onPointerDown(event: PointerEvent) {
    const target = event.target as Element;
    if (isTextInput(target)) return;
    const screen = this.screenPoint(event);
    this.pointers.set(event.pointerId, screen);
    this.lastPointer = this.toWorld(event.clientX, event.clientY);
    if (this.editing) this.finishEditing();
    this.viewport.focus({ preventScroll: true });
    this.viewport.setPointerCapture(event.pointerId);

    if (this.pointers.size === 2) {
      const [first, second] = [...this.pointers.values()];
      this.cancelGesture();
      this.gesture = { kind: "pinch", distance: Math.hypot(first.x - second.x, first.y - second.y), center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }, zoom: this.view.zoom, viewX: this.view.x, viewY: this.view.y };
      return;
    }
    if (this.pointers.size > 2) return;

    const world = this.lastPointer;
    const panGesture = (clearOnClick: boolean): Gesture => ({ kind: "pan", startX: event.clientX, startY: event.clientY, viewX: this.view.x, viewY: this.view.y, moved: false, clearOnClick });
    if (event.button === 1 || event.button === 2 || this.spaceHeld) {
      event.preventDefault();
      this.gesture = panGesture(false);
      this.root.classList.add("cv-panning");
      return;
    }
    if (event.button !== 0) return;

    const connector = target.closest<HTMLElement>(".cv-connector");
    const nodeElement = target.closest<HTMLElement>(".cv-node");
    if (connector && nodeElement && !this.readOnly) {
      this.gesture = { kind: "connect", fromId: nodeElement.dataset.id!, fromSide: connector.dataset.side as Side, pointer: world };
      this.edgeSvg.appendChild(this.tempEdge);
      this.updateTempEdge();
      return;
    }
    if (target.closest(".cv-resize") && nodeElement && !this.readOnly) {
      const node = this.nodeById.get(nodeElement.dataset.id!)!;
      this.history.begin([...this.selection]);
      this.touchNode(node);
      this.gesture = { kind: "resize", id: node.id, start: world, origin: { x: node.x, y: node.y, width: node.width, height: node.height } };
      return;
    }
    if (nodeElement) {
      const id = nodeElement.dataset.id!;
      const wasSelected = this.selection.has(id);
      if (event.shiftKey) {
        if (wasSelected) this.selection.delete(id); else this.selection.add(id);
      } else if (!wasSelected) {
        this.selection = new Set([id]);
      }
      this.selectionDirty = true;
      this.requestRender();
      this.gesture = { kind: "move", start: world, origins: new Map(), moved: false, clickTarget: target, clickId: id, shift: event.shiftKey, wasSelected };
      return;
    }
    const edgeElement = target.closest<SVGGElement>(".cv-edge") ?? target.closest<HTMLElement>(".cv-edge-label");
    if (edgeElement) {
      const id = (edgeElement as HTMLElement).dataset.id ?? (edgeElement as HTMLElement).dataset.edge!;
      this.gesture = { kind: "edgeClick", id, shift: event.shiftKey };
      return;
    }
    if (event.shiftKey) {
      this.gesture = { kind: "marquee", start: world, additive: new Set(this.selection) };
      return;
    }
    this.gesture = panGesture(true);
  }

  private screenPoint(event: PointerEvent): Point {
    const rect = this.viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerMove(event: PointerEvent) {
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, this.screenPoint(event));
    const world = this.toWorld(event.clientX, event.clientY);
    this.lastPointer = world;
    const gesture = this.gesture;
    if (!gesture) return;

    switch (gesture.kind) {
      case "pinch": {
        if (this.pointers.size < 2) return;
        const [first, second] = [...this.pointers.values()];
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, gesture.zoom * distance / gesture.distance));
        const worldX = (gesture.center.x - gesture.viewX) / gesture.zoom;
        const worldY = (gesture.center.y - gesture.viewY) / gesture.zoom;
        this.view = { zoom, x: center.x - worldX * zoom, y: center.y - worldY * zoom };
        this.markZooming();
        this.viewDirty = true;
        break;
      }
      case "pan": {
        const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
        if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        gesture.moved = true;
        this.root.classList.add("cv-panning");
        this.view.x = gesture.viewX + dx;
        this.view.y = gesture.viewY + dy;
        this.viewDirty = true;
        break;
      }
      case "move": {
        if (this.readOnly) return;
        const dx = world.x - gesture.start.x, dy = world.y - gesture.start.y;
        if (!gesture.moved) {
          if (Math.hypot(dx, dy) * this.view.zoom < DRAG_THRESHOLD) return;
          gesture.moved = true;
          this.beginMove(gesture);
        }
        const bypass = event.altKey;
        // Snap the primary node; everything else keeps its relative offset.
        const primary = gesture.origins.get(gesture.clickId) ?? gesture.origins.values().next().value!;
        const snappedX = this.snapValue(primary.x + dx, bypass) - primary.x;
        const snappedY = this.snapValue(primary.y + dy, bypass) - primary.y;
        for (const [id, origin] of gesture.origins) {
          const node = this.nodeById.get(id)!;
          node.x = Math.round(origin.x + snappedX);
          node.y = Math.round(origin.y + snappedY);
          this.dirtyNodes.add(id);
          for (const edgeId of this.edgesByNode.get(id) ?? []) this.dirtyEdges.add(edgeId);
        }
        break;
      }
      case "resize": {
        const node = this.nodeById.get(gesture.id)!;
        const bypass = event.altKey;
        const minimum = node.type === "group" ? 100 : 40;
        node.width = Math.max(minimum, this.snapValue(gesture.origin.x + gesture.origin.width + world.x - gesture.start.x, bypass) - node.x);
        node.height = Math.max(minimum / 2, this.snapValue(gesture.origin.y + gesture.origin.height + world.y - gesture.start.y, bypass) - node.y);
        this.dirtyNodes.add(node.id);
        for (const edgeId of this.edgesByNode.get(node.id) ?? []) this.dirtyEdges.add(edgeId);
        break;
      }
      case "connect": {
        gesture.pointer = world;
        this.updateTempEdge();
        const hover = this.nodeAt(event.clientX, event.clientY);
        for (const element of this.nodeLayer.querySelectorAll(".cv-drop-target")) element.classList.remove("cv-drop-target");
        for (const element of this.groupLayer.querySelectorAll(".cv-drop-target")) element.classList.remove("cv-drop-target");
        if (hover && hover.id !== gesture.fromId) this.nodeEls.get(hover.id)?.classList.add("cv-drop-target");
        return;
      }
      case "marquee": {
        const rect = normalizeRect(gesture.start, world);
        const topLeft = this.toScreen(rect);
        Object.assign(this.marquee.style, {
          display: "block",
          transform: `translate(${topLeft.x}px,${topLeft.y}px)`,
          width: `${rect.width * this.view.zoom}px`,
          height: `${rect.height * this.view.zoom}px`,
        });
        const selection = new Set(gesture.additive);
        for (const node of this.data.nodes) {
          if (node.type === "group" ? contains(rect, node) : intersects(rect, node)) selection.add(node.id);
        }
        this.selection = selection;
        this.selectionDirty = true;
        break;
      }
    }
    this.requestRender();
  }

  private beginMove(gesture: Extract<Gesture, { kind: "move" }>) {
    this.history.begin([...this.selection]);
    const moving = new Set<string>();
    for (const node of this.selectedNodes()) {
      moving.add(node.id);
      // Dragging a group carries everything inside it.
      if (node.type === "group") for (const other of this.data.nodes) if (other.id !== node.id && contains(node, other)) moving.add(other.id);
    }
    for (const id of moving) {
      const node = this.nodeById.get(id)!;
      this.touchNode(node);
      gesture.origins.set(id, { x: node.x, y: node.y });
    }
    this.root.classList.add("cv-dragging");
    this.selectionDirty = true;
  }

  private onPointerUp(event: PointerEvent) {
    this.pointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === "pinch") {
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    this.gesture = null;
    this.root.classList.remove("cv-panning", "cv-dragging");
    const world = this.toWorld(event.clientX, event.clientY);

    switch (gesture.kind) {
      case "pan":
        if (!gesture.moved && gesture.clearOnClick && this.selection.size) {
          this.selection.clear();
          this.selectionDirty = true;
        }
        break;
      case "move":
        if (gesture.moved) {
          this.commitOpen();
        } else {
          const link = gesture.clickTarget.closest<HTMLElement>("a, .cv-file-title");
          if (link && event.type === "pointerup") this.followLink(link, gesture.clickId);
          else if (!gesture.shift && gesture.wasSelected && this.selection.size > 1) {
            this.selection = new Set([gesture.clickId]);
            this.selectionDirty = true;
          }
        }
        break;
      case "resize":
        this.commitOpen();
        break;
      case "connect":
        this.tempEdge.remove();
        for (const element of this.world.querySelectorAll(".cv-drop-target")) element.classList.remove("cv-drop-target");
        if (event.type === "pointerup") this.finishConnect(gesture, world, event);
        break;
      case "marquee":
        this.marquee.style.display = "none";
        break;
      case "edgeClick":
        if (gesture.shift) {
          if (this.selection.has(gesture.id)) this.selection.delete(gesture.id); else this.selection.add(gesture.id);
        } else {
          this.selection = new Set([gesture.id]);
        }
        this.selectionDirty = true;
        break;
    }
    this.requestRender();
  }

  private commitOpen() {
    if (this.history.commit()) {
      this.dirty = true;
      this.host.changed();
    }
    this.selectionDirty = true;
  }

  private cancelGesture() {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind === "move" && gesture.moved) this.commitOpen();
    if (gesture.kind === "resize") this.commitOpen();
    if (gesture.kind === "connect") this.tempEdge.remove();
    if (gesture.kind === "marquee") this.marquee.style.display = "none";
    this.root.classList.remove("cv-panning", "cv-dragging");
  }

  private followLink(link: HTMLElement, nodeId: string) {
    if (link.classList.contains("cv-file-title")) {
      const node = this.nodeById.get(nodeId);
      if (node) this.openNode(node);
      return;
    }
    const page = link.dataset.page;
    if (page) { this.host.navigate(page.replace(/&amp;/g, "&")); return; }
    const href = link.getAttribute("href");
    if (href) this.host.openUrl(href);
  }

  private nodeAt(clientX: number, clientY: number): CanvasNode | null {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const nodeElement = (element as HTMLElement).closest?.<HTMLElement>(".cv-node");
      if (nodeElement) return this.nodeById.get(nodeElement.dataset.id!) ?? null;
    }
    return null;
  }

  private updateTempEdge() {
    const gesture = this.gesture;
    if (gesture?.kind !== "connect") return;
    const from = this.nodeById.get(gesture.fromId);
    if (!from) return;
    const geometry = curve(sidePoint(from, gesture.fromSide), normal(gesture.fromSide), gesture.pointer, null, false, false);
    this.tempEdge.setAttribute("d", geometry.path);
  }

  private finishConnect(gesture: Extract<Gesture, { kind: "connect" }>, world: Point, event: PointerEvent) {
    const from = this.nodeById.get(gesture.fromId);
    if (!from) return;
    const target = this.nodeAt(event.clientX, event.clientY);
    if (target && target.id === from.id) return;
    const distance = Math.hypot(world.x - sidePoint(from, gesture.fromSide).x, world.y - sidePoint(from, gesture.fromSide).y);
    if (!target && distance * this.view.zoom < 30) return;

    this.history.begin([...this.selection]);
    let toNode = target;
    if (!toNode) {
      // Dropped on empty canvas: create a card there, like Obsidian.
      const width = 260, height = 80;
      const opposite = normal(gesture.fromSide);
      const center = { x: world.x + opposite.x * width / 2, y: world.y + opposite.y * height / 2 };
      toNode = { id: newId(), type: "text", text: "", x: this.snapValue(center.x - width / 2), y: this.snapValue(center.y - height / 2), width, height };
      this.addNode(toNode);
    }
    const edge: CanvasEdge = {
      id: newId(),
      fromNode: from.id,
      fromSide: gesture.fromSide,
      toNode: toNode.id,
      toSide: target ? nearestSide(toNode, world) : oppositeSide(gesture.fromSide),
    };
    this.addEdge(edge);
    this.commitOpen();
    if (!target) this.startEditing(toNode.id, true);
    else { this.selection = new Set([edge.id]); this.selectionDirty = true; }
  }

  private onDoubleClick(event: MouseEvent) {
    // Pointer capture retargets dblclick to the viewport; look up what is really under the pointer.
    const target = document.elementFromPoint(event.clientX, event.clientY) ?? (event.target as Element);
    if (isTextInput(target)) return;
    const nodeElement = target.closest<HTMLElement>(".cv-node");
    if (nodeElement) {
      const node = this.nodeById.get(nodeElement.dataset.id!);
      if (!node) return;
      if (node.type === "text") this.startEditing(node.id, false);
      else if (node.type === "group" && target.closest(".cv-group-label")) { this.selection = new Set([node.id]); void this.editLabel(); }
      else if (node.type === "group" && !this.readOnly) this.createTextNode(this.toWorld(event.clientX, event.clientY), true);
      else this.openNode(node);
      return;
    }
    const edgeElement = target.closest<HTMLElement>(".cv-edge-label") ?? target.closest(".cv-edge");
    if (edgeElement) {
      const id = (edgeElement as HTMLElement).dataset.id ?? (edgeElement as HTMLElement).dataset.edge!;
      this.selection = new Set([id]);
      void this.editLabel();
      return;
    }
    if (!this.readOnly) this.createTextNode(this.toWorld(event.clientX, event.clientY), true);
  }

  private onWheel(event: WheelEvent) {
    const target = event.target as Element;
    // Let selected cards scroll their own content.
    const content = target.closest<HTMLElement>(".cv-selected .cv-content, .cv-textarea");
    if (content && !event.ctrlKey && !event.metaKey && content.scrollHeight > content.clientHeight + 1) return;
    event.preventDefault();
    const rect = this.viewport.getBoundingClientRect();
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    if (event.ctrlKey || event.metaKey) {
      this.setZoom(this.view.zoom * Math.exp(-event.deltaY * unit * 0.0025), anchor);
    } else {
      this.view.x -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
      this.view.y -= (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
      this.viewDirty = true;
      this.requestRender();
    }
  }

  private onKeyDown(event: KeyboardEvent) {
    if (this.editing || isTextInput(event.target) || event.defaultPrevented) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const handled = () => { event.preventDefault(); event.stopPropagation(); };

    if (key === " " && !mod) { this.spaceHeld = true; this.root.classList.add("cv-panning"); handled(); return; }
    if (mod && key.toLowerCase() === "z") { handled(); if (event.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && key.toLowerCase() === "y") { handled(); this.redo(); return; }
    if (mod && key.toLowerCase() === "a") {
      handled();
      this.selection = new Set(this.data.nodes.map((node) => node.id));
      this.selectionDirty = true;
      this.requestRender();
      return;
    }
    if (mod && key.toLowerCase() === "d" && !this.readOnly) {
      handled();
      if (this.copySelection() && this.clipboard) {
        const bounds = boundsOf(this.clipboard.nodes)!;
        this.paste(this.clipboard, { x: bounds.x + bounds.width / 2 + GRID * 2, y: bounds.y + bounds.height / 2 + GRID * 2 });
      }
      return;
    }
    if (mod) return;
    if (key === "Delete" || key === "Backspace") { if (this.selection.size) { handled(); this.deleteSelection(); } return; }
    if (key === "Escape") { if (this.selection.size) { handled(); this.selection.clear(); this.selectionDirty = true; this.requestRender(); } return; }
    if (key === "Enter") {
      const nodes = this.selectedNodes();
      if (nodes.length === 1) {
        handled();
        if (nodes[0].type === "text") this.startEditing(nodes[0].id, false);
        else if (nodes[0].type === "group") void this.editLabel();
        else this.openNode(nodes[0]);
      }
      return;
    }
    if (key === "!" || (event.shiftKey && event.code === "Digit1")) { handled(); this.zoomToFit(); return; }
    if (key === ")" || (event.shiftKey && event.code === "Digit0")) { handled(); this.setZoom(1); return; }
    if (key === "+" || key === "=") { handled(); this.setZoom(this.view.zoom * 1.25); return; }
    if (key === "-" || key === "_") { handled(); this.setZoom(this.view.zoom / 1.25); return; }
    const arrows: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    if (arrows[key] && this.selectedNodes().length && !this.readOnly) {
      handled();
      const step = event.shiftKey ? GRID * 5 : this.snap ? GRID : 1;
      this.transact(() => {
        for (const node of this.selectedNodes()) {
          this.touchNode(node);
          node.x += arrows[key].x * step;
          node.y += arrows[key].y * step;
        }
      });
    }
  }
}

function normalizeRect(first: Point, second: Point): Rect {
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(first.x - second.x), height: Math.abs(first.y - second.y) };
}

function oppositeSide(side: Side): Side {
  return ({ top: "bottom", bottom: "top", left: "right", right: "left" } as const)[side];
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
}
