/** Port of browser-use 0.13.10 dom/serializer/paint_order.py (MIT).
 * Keep the rectangle subtraction, equal-order batching, document boundaries,
 * transparent-background rule and 0.8 opacity threshold identical to upstream.
 */
import type { BrowserUseNode } from "./browser-use-serializer.js";
interface Node {
  original: BrowserUseNode;
  children: Node[];
}
interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
const contains = (a: Rect, b: Rect): boolean =>
  a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2;
const intersects = (a: Rect, b: Rect): boolean =>
  !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
function difference(a: Rect, b: Rect): Rect[] {
  const parts: Rect[] = [];
  if (a.y1 < b.y1) parts.push({ ...a, y2: b.y1 });
  if (b.y2 < a.y2) parts.push({ ...a, y1: b.y2 });
  const y1 = Math.max(a.y1, b.y1),
    y2 = Math.min(a.y2, b.y2);
  if (a.x1 < b.x1) parts.push({ x1: a.x1, y1, x2: b.x1, y2 });
  if (b.x2 < a.x2) parts.push({ x1: b.x2, y1, x2: a.x2, y2 });
  return parts;
}
class RectUnion {
  private rects: Rect[] = [];
  contains(rect: Rect): boolean {
    let stack = [rect];
    for (const other of this.rects) {
      stack = stack.flatMap((piece) =>
        contains(other, piece) ? [] : intersects(piece, other) ? difference(piece, other) : [piece],
      );
      if (!stack.length) return true;
    }
    return false;
  }
  add(rect: Rect): void {
    if (this.rects.length >= 5000 || this.contains(rect)) return;
    let pending = [rect];
    for (const other of this.rects)
      pending = pending.flatMap((piece) =>
        intersects(piece, other) ? difference(piece, other) : [piece],
      );
    this.rects.push(...pending);
  }
}
export function browserUsePaintOrder(root: Node): Set<BrowserUseNode> {
  const groups = new Map<number, Array<{ node: BrowserUseNode; context: string }>>();
  const collect = (n: Node, context: string): void => {
    const o = n.original;
    if (o.snapshot && o.paintOrder != null && o.bounds) {
      const group = groups.get(o.paintOrder) ?? [];
      group.push({ node: o, context });
      groups.set(o.paintOrder, group);
    }
    const childContext = ["iframe", "frame"].includes(o.nodeName.toLowerCase()) ? o.id : context;
    n.children.forEach((child) => collect(child, childContext));
  };
  collect(root, "main");
  const unions = new Map<string, RectUnion>();
  const ignored = new Set<BrowserUseNode>();
  for (const [, nodes] of [...groups].sort(([a], [b]) => b - a)) {
    const additions: Array<{ union: RectUnion; rect: Rect }> = [];
    for (const { node, context } of nodes) {
      const b = node.bounds!;
      const rect = { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
      const union = unions.get(context) ?? new RectUnion();
      unions.set(context, union);
      if (union.contains(rect)) ignored.add(node);
      const styles = node.computedStyles;
      if (
        styles &&
        Object.keys(styles).length &&
        ((styles["background-color"] ?? "rgba(0, 0, 0, 0)") === "rgba(0, 0, 0, 0)" ||
          Number(styles.opacity ?? "1") < 0.8)
      )
        continue;
      additions.push({ union, rect });
    }
    for (const { union, rect } of additions) union.add(rect);
  }
  return ignored;
}
