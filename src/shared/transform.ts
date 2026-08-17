import type { SceneData, SceneObject } from "./types";

/**
 * Hierarchy maths. Objects store a LOCAL transform relative to their parent;
 * reparenting preserves world position by recomputing local = world - parent.
 */

export interface WorldTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export function objectsById(scene: SceneData): Map<string, SceneObject> {
  return new Map(scene.objects.map((o) => [o.id, o]));
}

export function worldTransform(
  obj: SceneObject,
  index: Map<string, SceneObject>,
): WorldTransform {
  const chain: SceneObject[] = [];
  let cur: SceneObject | undefined = obj;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? index.get(cur.parentId) : undefined;
  }

  let x = 0;
  let y = 0;
  let rotation = 0;
  let scaleX = 1;
  let scaleY = 1;
  for (const node of chain) {
    const rad = (rotation * Math.PI) / 180;
    const lx = node.x * scaleX;
    const ly = node.y * scaleY;
    x += lx * Math.cos(rad) - ly * Math.sin(rad);
    y += lx * Math.sin(rad) + ly * Math.cos(rad);
    rotation += node.rotation;
    scaleX *= node.scaleX;
    scaleY *= node.scaleY;
  }
  return { x, y, rotation, scaleX, scaleY };
}

/** Convert a desired world position into a local one under `parentId`. */
export function worldToLocal(
  world: { x: number; y: number },
  parentId: string | null,
  index: Map<string, SceneObject>,
): { x: number; y: number } {
  if (!parentId) return { x: world.x, y: world.y };
  const parent = index.get(parentId);
  if (!parent) return { x: world.x, y: world.y };
  const pw = worldTransform(parent, index);
  const dx = world.x - pw.x;
  const dy = world.y - pw.y;
  const rad = (-pw.rotation * Math.PI) / 180;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  return { x: rx / (pw.scaleX || 1), y: ry / (pw.scaleY || 1) };
}

/** True when making `parentId` the parent of `id` would create a cycle. */
export function wouldCycle(
  id: string,
  parentId: string | null,
  index: Map<string, SceneObject>,
): boolean {
  let cur = parentId;
  const guard = new Set<string>();
  while (cur) {
    if (cur === id) return true;
    if (guard.has(cur)) return true;
    guard.add(cur);
    cur = index.get(cur)?.parentId ?? null;
  }
  return false;
}

export function descendantIds(id: string, scene: SceneData): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const o of scene.objects) {
      if (o.parentId === parent) {
        out.push(o.id);
        walk(o.id);
      }
    }
  };
  walk(id);
  return out;
}

/** Root-first ordering, so parents always exist before their children. */
export function topLevel(scene: SceneData): SceneObject[] {
  return scene.objects.filter((o) => !o.parentId);
}

export function childrenOf(scene: SceneData, id: string | null): SceneObject[] {
  return scene.objects.filter((o) => o.parentId === id);
}
