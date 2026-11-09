import type { CanvasEdge, CanvasNode, Side } from "./model.ts";

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

const NORMALS: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
const SIDES = new Set<string>(["top", "right", "bottom", "left"]);
export const isSide = (side: unknown): side is Side => typeof side === "string" && SIDES.has(side);

export const ARROW_LENGTH = 14;
const ARROW_HALF_WIDTH = 6;

export function sidePoint(node: Rect, side: Side): Point {
  switch (side) {
    case "top": return { x: node.x + node.width / 2, y: node.y };
    case "bottom": return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left": return { x: node.x, y: node.y + node.height / 2 };
    case "right": return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

export function nearestSide(node: Rect, point: Point): Side {
  const distances: [Side, number][] = [
    ["top", Math.abs(point.y - node.y)],
    ["bottom", Math.abs(point.y - (node.y + node.height))],
    ["left", Math.abs(point.x - node.x)],
    ["right", Math.abs(point.x - (node.x + node.width))],
  ];
  distances.sort((first, second) => first[1] - second[1]);
  return distances[0][0];
}

function autoSides(from: Rect, to: Rect): [Side, Side] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ["right", "left"] : ["left", "right"];
  return dy > 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export interface EdgeGeometry { path: string; arrows: string; mid: Point }

function arrowAt(tip: Point, normal: Point): string {
  const base = { x: tip.x + normal.x * ARROW_LENGTH, y: tip.y + normal.y * ARROW_LENGTH };
  const perpendicular = { x: -normal.y * ARROW_HALF_WIDTH, y: normal.x * ARROW_HALF_WIDTH };
  return `M${tip.x},${tip.y}L${base.x + perpendicular.x},${base.y + perpendicular.y}L${base.x - perpendicular.x},${base.y - perpendicular.y}Z`;
}

export function controlOffset(start: Point, end: Point): number {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  return Math.min(Math.max(distance * 0.45, 40), 220);
}

// Cubic bezier leaving/entering along the side normals, Obsidian style.
export function curve(
  start: Point, startNormal: Point, end: Point, endNormal: Point | null,
  startArrow: boolean, endArrow: boolean,
): EdgeGeometry {
  const lineStart = startArrow ? { x: start.x + startNormal.x * ARROW_LENGTH, y: start.y + startNormal.y * ARROW_LENGTH } : start;
  const lineEnd = endArrow && endNormal ? { x: end.x + endNormal.x * ARROW_LENGTH, y: end.y + endNormal.y * ARROW_LENGTH } : end;
  const offset = controlOffset(lineStart, lineEnd);
  const control1 = { x: lineStart.x + startNormal.x * offset, y: lineStart.y + startNormal.y * offset };
  const control2 = endNormal ? { x: lineEnd.x + endNormal.x * offset, y: lineEnd.y + endNormal.y * offset } : lineEnd;
  const mid = {
    x: 0.125 * lineStart.x + 0.375 * control1.x + 0.375 * control2.x + 0.125 * lineEnd.x,
    y: 0.125 * lineStart.y + 0.375 * control1.y + 0.375 * control2.y + 0.125 * lineEnd.y,
  };
  let arrows = "";
  if (startArrow) arrows += arrowAt(start, startNormal);
  if (endArrow && endNormal) arrows += arrowAt(end, endNormal);
  return {
    path: `M${lineStart.x},${lineStart.y}C${control1.x},${control1.y} ${control2.x},${control2.y} ${lineEnd.x},${lineEnd.y}`,
    arrows,
    mid,
  };
}

export function edgeGeometry(edge: CanvasEdge, from: CanvasNode, to: CanvasNode): EdgeGeometry {
  const [autoFrom, autoTo] = autoSides(from, to);
  const fromSide = isSide(edge.fromSide) ? edge.fromSide : autoFrom;
  const toSide = isSide(edge.toSide) ? edge.toSide : autoTo;
  return curve(
    sidePoint(from, fromSide), NORMALS[fromSide],
    sidePoint(to, toSide), NORMALS[toSide],
    edge.fromEnd === "arrow", (edge.toEnd ?? "arrow") === "arrow",
  );
}

export function normal(side: Side): Point { return NORMALS[side]; }

export function intersects(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width && second.x < first.x + first.width &&
    first.y < second.y + second.height && second.y < first.y + first.height;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x); minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width); maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
