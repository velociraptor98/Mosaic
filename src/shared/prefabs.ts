import type {
  PrefabDef,
  PrefabNode,
  ProjectData,
  ResolvedPrefab,
  SceneObject,
} from "./types";

/**
 * Prefab resolution, in two layers.
 *
 * INHERITANCE: a variant stores a base and a diff, never a second copy of the
 * object. `resolvePrefab` walks the base chain and applies each diff in turn,
 * so a fix on the base reaches every variant except where one deliberately
 * disagreed.
 *
 * INSTANCES: an instance stores only {prefab, transform, overrides}.
 * `resolveObject` lays the resolved definition down first and the instance's
 * overrides on top, so editing the definition updates every instance except
 * the fields that instance has explicitly claimed.
 */

/** Properties an instance always owns, whatever the prefab says. */
export const INSTANCE_OWNED = new Set([
  "id",
  "name",
  "layerId",
  "parentId",
  "x",
  "y",
  "prefab",
  "overrides",
]);

/** Node-only bookkeeping that must never be copied onto a scene object. */
const NODE_ONLY = new Set(["children", "lid"]);

/**
 * A variant of a variant is allowed; a variant of THAT is not. Two levels is
 * enough to say "big" and "big frozen" without the chain becoming a hierarchy
 * nobody can hold in their head.
 */
export const VARIANT_DEPTH_LIMIT = 2;

export function getPath(target: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[part];
  }, target);
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = node[parts[i]];
    if (next === null || typeof next !== "object") node[parts[i]] = {};
    node = node[parts[i]] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/** Deletes a leaf, and any now-empty containers the path walked through. */
export function deletePath(target: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  const chain: Record<string, unknown>[] = [target];
  for (let i = 0; i < parts.length - 1; i++) {
    const next = chain[i][parts[i]];
    if (next === null || typeof next !== "object") return;
    chain.push(next as Record<string, unknown>);
  }
  delete chain[chain.length - 1][parts[parts.length - 1]];
}

export function findPrefab(project: ProjectData, name: string | undefined): PrefabDef | undefined {
  if (!name) return undefined;
  return project.prefabs.find((p) => p.name === name);
}

// ---------------------------------------------------------------------------
// Local ids — how a part of a prefab is addressed
// ---------------------------------------------------------------------------

let lidCounter = 0;

export function newLid(): string {
  lidCounter += 1;
  return `n${Date.now().toString(36)}${lidCounter.toString(36)}`;
}

/** Depth-first walk over a node and its descendants, parents first. */
export function walkNodes(root: PrefabNode): PrefabNode[] {
  const out: PrefabNode[] = [];
  const visit = (node: PrefabNode) => {
    out.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return out;
}

export function nodeByLid(root: PrefabNode, lid: string): PrefabNode | undefined {
  return walkNodes(root).find((n) => n.lid === lid);
}

/**
 * Gives every node a local id, in place. Folders written by an older build
 * have none, so this runs on load as well as on authoring.
 */
export function ensureLids(root: PrefabNode): PrefabNode {
  for (const node of walkNodes(root)) {
    node.children = node.children ?? [];
    if (!node.lid) node.lid = newLid();
  }
  return root;
}

/** "Sprite" / "Enemies/HitFlash" — the path shown when two children share a name. */
export function nodePath(root: PrefabNode, lid: string): string {
  const trail: string[] = [];
  const walk = (node: PrefabNode, above: string[]): boolean => {
    const here = [...above, node.name];
    if (node.lid === lid) {
      trail.push(...here);
      return true;
    }
    return (node.children ?? []).some((c) => walk(c, here));
  };
  walk(root, []);
  return trail.join(" / ");
}

// ---------------------------------------------------------------------------
// Inheritance — base prefabs and their variants
// ---------------------------------------------------------------------------

export type ChainResult =
  | { ok: true; chain: PrefabDef[] }
  | { ok: false; reason: "missing" | "cycle" | "too-deep"; at: string };

/**
 * The inheritance chain, base first. Rejects a cycle and a chain deeper than
 * the limit rather than resolving something nobody could reason about.
 */
export function prefabChain(project: ProjectData, name: string): ChainResult {
  const chain: PrefabDef[] = [];
  const seen = new Set<string>();
  let current = findPrefab(project, name);
  if (!current) return { ok: false, reason: "missing", at: name };

  while (current) {
    if (seen.has(current.name)) return { ok: false, reason: "cycle", at: current.name };
    seen.add(current.name);
    chain.unshift(current);
    if (!current.base) break;
    const next = findPrefab(project, current.base);
    if (!next) return { ok: false, reason: "missing", at: current.base };
    current = next;
  }

  // chain.length - 1 is how many variant hops there are above the base.
  if (chain.length - 1 > VARIANT_DEPTH_LIMIT) {
    return { ok: false, reason: "too-deep", at: chain[chain.length - 1].name };
  }
  return { ok: true, chain };
}

/** How deep a prefab sits: 0 for a base, 1 for its variant, and so on. */
export function variantDepth(project: ProjectData, name: string): number {
  const result = prefabChain(project, name);
  return result.ok ? result.chain.length - 1 : 0;
}

/** Whether `name` may take `base` as its base without a cycle or an over-deep chain. */
export function canInherit(project: ProjectData, base: string, name?: string): boolean {
  if (name && base === name) return false;
  const result = prefabChain(project, base);
  if (!result.ok) return false;
  if (name && result.chain.some((p) => p.name === name)) return false;
  return result.chain.length - 1 < VARIANT_DEPTH_LIMIT;
}

/**
 * A prefab with its inheritance applied. The base supplies the tree; each
 * variant in turn writes only the paths it claims, so an unrelated change on
 * the base still flows through.
 */
export function resolvePrefab(
  project: ProjectData,
  name: string | undefined,
): ResolvedPrefab | undefined {
  if (!name) return undefined;
  const result = prefabChain(project, name);
  if (!result.ok) return undefined;

  const base = result.chain[0];
  if (!base.root) return undefined;

  const root = ensureLids(structuredClone(base.root));
  const exposed = new Set(base.exposed ?? []);

  for (const link of result.chain.slice(1)) {
    for (const [path, value] of Object.entries(link.diff ?? {})) {
      setPath(root as unknown as Record<string, unknown>, path, structuredClone(value));
    }
    for (const path of link.exposed ?? []) exposed.add(path);
  }

  return {
    name,
    exposed: [...exposed],
    root,
    base: result.chain.length > 1 ? result.chain[result.chain.length - 1].base : undefined,
    chain: result.chain.map((p) => p.name),
  };
}

/** Every prefab that inherits from `name`, at any depth. */
export function variantsOf(project: ProjectData, name: string): PrefabDef[] {
  return project.prefabs.filter((p) => {
    if (p.name === name || !p.base) return false;
    const result = prefabChain(project, p.name);
    return result.ok && result.chain.some((link) => link.name === name);
  });
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * The object as it should render / export: the resolved definition's fields,
 * then the instance's own transform, then its overrides on top.
 */
export function resolveObject(project: ProjectData, obj: SceneObject): SceneObject {
  const prefab = resolvePrefab(project, obj.prefab);
  if (!prefab) return obj;

  const resolved = structuredClone(obj) as unknown as Record<string, unknown>;
  const node = prefab.root as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    if (NODE_ONLY.has(key)) continue;
    if (INSTANCE_OWNED.has(key)) continue;
    resolved[key] = structuredClone(value);
  }
  for (const [path, value] of Object.entries(obj.overrides ?? {})) {
    setPath(resolved, path, structuredClone(value));
  }
  return resolved as unknown as SceneObject;
}

/**
 * Every object in a scene, resolved. Use this to build the index for world
 * transforms: a prefab instance keeps a stale copy of the definition's scale
 * and rotation on itself, so walking the raw objects would compose the wrong
 * transform whenever a definition has changed since the instance was made.
 */
export function resolvedIndex(
  project: ProjectData,
  scene: { objects: SceneObject[] },
): Map<string, SceneObject> {
  return new Map(scene.objects.map((o) => [o.id, resolveObject(project, o)]));
}

/** The value the definition would supply for a path, ignoring overrides. */
export function definitionValue(prefab: ResolvedPrefab, path: string): unknown {
  return getPath(prefab.root, path);
}

export function isOverridden(obj: SceneObject, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj.overrides ?? {}, path);
}

/** Whether an instance is allowed to change this path in a level. */
export function isExposed(prefab: ResolvedPrefab | undefined, path: string): boolean {
  if (!prefab) return true;
  if (INSTANCE_OWNED.has(path.split(".")[0])) return true;
  return prefab.exposed.includes(path);
}

/** Turn a scene object into a prefab template node. */
export function toPrefabNode(obj: SceneObject, children: PrefabNode[] = []): PrefabNode {
  const { id: _id, layerId: _layerId, parentId: _parentId, ...rest } = structuredClone(obj);
  return { ...rest, lid: newLid(), children };
}

/**
 * Child nodes of a prefab instance, positioned in world space. These render
 * as part of the instance and are not individually selectable — the instance
 * is the unit of editing.
 */
export function instanceChildren(
  prefab: ResolvedPrefab,
  instance: SceneObject,
): { node: PrefabNode; x: number; y: number }[] {
  return (prefab.root.children ?? []).map((node) => ({
    node,
    x: instance.x + node.x,
    y: instance.y + node.y,
  }));
}

/**
 * The box a prefab occupies around its origin, from its parts' own sizes.
 * Drawn on the isolated stage because bounds and origin are the two things an
 * instance cannot fix later.
 */
export function prefabBounds(
  root: PrefabNode,
  sizeOf: (node: PrefabNode) => { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (node: PrefabNode, ox: number, oy: number) => {
    const x = ox + (node === root ? 0 : node.x);
    const y = oy + (node === root ? 0 : node.y);
    const size = sizeOf(node);
    const w = size.width * Math.abs(node.scaleX || 1);
    const h = size.height * Math.abs(node.scaleY || 1);
    minX = Math.min(minX, x - w * node.originX);
    minY = Math.min(minY, y - h * node.originY);
    maxX = Math.max(maxX, x + w * (1 - node.originX));
    maxY = Math.max(maxY, y + h * (1 - node.originY));
    for (const child of node.children ?? []) visit(child, x, y);
  };
  visit(root, 0, 0);

  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---------------------------------------------------------------------------
// Diffing — what a definition change costs
// ---------------------------------------------------------------------------

/**
 * Leaf paths of a node's own fields, addressed the way an override is. Child
 * nodes are excluded: they are compared structurally, by local id.
 */
export function flattenNode(node: PrefabNode): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const visit = (value: unknown, path: string) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length) {
        for (const [key, child] of entries) visit(child, path ? `${path}.${key}` : key);
        return;
      }
    }
    if (path) out.set(path, value);
  };

  for (const [key, value] of Object.entries(node)) {
    if (NODE_ONLY.has(key)) continue;
    // Scripts are an ordered list whose entries are addressed by index, and
    // `props` inside one is the level an override writes at.
    if (key === "scripts" && Array.isArray(value)) {
      value.forEach((script, i) => visit(script, `scripts.${i}`));
      continue;
    }
    visit(value, key);
  }
  return out;
}

export interface PathChange {
  path: string;
  before: unknown;
  after: unknown;
  /** Set when the path exists on only one side. */
  kind: "changed" | "added" | "removed";
}

/** Property-level differences between two definition trees' roots. */
export function diffNodes(before: PrefabNode, after: PrefabNode): PathChange[] {
  const a = flattenNode(before);
  const b = flattenNode(after);
  const out: PathChange[] = [];
  for (const [path, value] of b) {
    if (!a.has(path)) out.push({ path, before: undefined, after: value, kind: "added" });
    else if (!same(a.get(path), value)) {
      out.push({ path, before: a.get(path), after: value, kind: "changed" });
    }
  }
  for (const [path, value] of a) {
    if (!b.has(path)) out.push({ path, before: value, after: undefined, kind: "removed" });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export interface ChildChange {
  lid: string;
  name: string;
  kind: "added" | "removed";
}

/** Which children a definition change adds or drops, by local id. */
export function diffChildren(before: PrefabNode, after: PrefabNode): ChildChange[] {
  const a = new Map(walkNodes(before).slice(1).map((n) => [n.lid, n]));
  const b = new Map(walkNodes(after).slice(1).map((n) => [n.lid, n]));
  const out: ChildChange[] = [];
  for (const [lid, node] of b) if (!a.has(lid)) out.push({ lid, name: node.name, kind: "added" });
  for (const [lid, node] of a) if (!b.has(lid)) out.push({ lid, name: node.name, kind: "removed" });
  return out;
}

/**
 * Value equality that does not depend on key order.
 *
 * A definition is rebuilt from the document on every read, so its keys come
 * back in a different order than the file wrote them. Comparing the raw JSON
 * would report that as a change, and the propagation panel would offer to
 * push an edit nobody made.
 */
export function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

export function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
