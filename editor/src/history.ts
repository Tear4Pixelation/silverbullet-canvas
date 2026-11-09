import type { CanvasData, CanvasEdge, CanvasNode } from "./model.ts";
import { clone } from "./model.ts";

// Patch-based undo: each step stores before/after copies of only the objects it
// touched, so memory stays flat on big canvases.

type Item = CanvasNode | CanvasEdge;
interface Entry { before: Item | null; beforeIndex: number; after: Item | null; afterIndex: number }
interface Step { nodes: Map<string, Entry>; edges: Map<string, Entry>; selection: string[] }

const LIMIT = 300;

export class History {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private open: Step | null = null;

  private data: () => CanvasData;

  constructor(data: () => CanvasData) { this.data = data; }

  reset() { this.undoStack = []; this.redoStack = []; this.open = null; }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  begin(selection: string[]) {
    if (!this.open) this.open = { nodes: new Map(), edges: new Map(), selection };
  }

  // Call before mutating, adding (pass the id before insert) or removing an object.
  touchNode(id: string) { this.touch("nodes", id); }
  touchEdge(id: string) { this.touch("edges", id); }

  private touch(kind: "nodes" | "edges", id: string) {
    if (!this.open) throw new Error("touch outside of a transaction");
    const map = this.open[kind];
    if (map.has(id)) return;
    const list = this.data()[kind] as Item[];
    const index = list.findIndex((item) => item.id === id);
    map.set(id, { before: index >= 0 ? clone(list[index]) : null, beforeIndex: index, after: null, afterIndex: -1 });
  }

  // Returns true when something actually changed.
  commit(): boolean {
    const step = this.open;
    this.open = null;
    if (!step) return false;
    let changed = false;
    for (const kind of ["nodes", "edges"] as const) {
      const list = this.data()[kind] as Item[];
      for (const [id, entry] of step[kind]) {
        const index = list.findIndex((item) => item.id === id);
        entry.after = index >= 0 ? clone(list[index]) : null;
        entry.afterIndex = index;
        if (JSON.stringify(entry.before) === JSON.stringify(entry.after) && entry.beforeIndex === entry.afterIndex) {
          step[kind].delete(id);
        } else {
          changed = true;
        }
      }
    }
    if (!changed) return false;
    this.undoStack.push(step);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  undo(): string[] | null { return this.move(this.undoStack, this.redoStack, "before"); }
  redo(): string[] | null { return this.move(this.redoStack, this.undoStack, "after"); }

  private move(from: Step[], to: Step[], side: "before" | "after"): string[] | null {
    const step = from.pop();
    if (!step) return null;
    for (const kind of ["nodes", "edges"] as const) {
      const list = this.data()[kind] as Item[];
      // Remove all touched objects, then reinsert in ascending index order.
      const touched = new Set(step[kind].keys());
      for (let i = list.length - 1; i >= 0; i--) if (touched.has(list[i].id)) list.splice(i, 1);
      const inserts = [...step[kind].values()]
        .map((entry) => ({ item: entry[side], index: side === "before" ? entry.beforeIndex : entry.afterIndex }))
        .filter((insert) => insert.item)
        .sort((first, second) => first.index - second.index);
      for (const insert of inserts) {
        list.splice(Math.min(insert.index, list.length), 0, clone(insert.item!));
      }
    }
    to.push(step);
    const ids = [...step.nodes.keys(), ...step.edges.keys()];
    return side === "before" ? step.selection : ids;
  }
}
