import type { PrefabDef, PrefabNode, ProjectData, SceneObject } from "./types";

/**
 * Prefab resolution: definition <- overrides, shallow per property path.
 *
 * An instance stores only {prefab, transform, overrides}. Everything else is
 * owned by the definition, so editing the definition updates every instance
 * except the fields that instance has explicitly overridden.
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

export function findPrefab(project: ProjectData, name: string | undefined): PrefabDef | undefined {
  if (!name) return undefined;
  return project.prefabs.find((p) => p.name === name);
}

/**
 * The object as it should render / export: the prefab definition's fields,
 * then the instance's own transform, then its overrides on top.
 */
export function resolveObject(project: ProjectData, obj: SceneObject): SceneObject {
  const prefab = findPrefab(project, obj.prefab);
  if (!prefab) return obj;

  const resolved = structuredClone(obj) as unknown as Record<string, unknown>;
  const node = prefab.root as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    if (key === "children") continue;
    if (INSTANCE_OWNED.has(key)) continue;
    resolved[key] = structuredClone(value);
  }
  for (const [path, value] of Object.entries(obj.overrides ?? {})) {
    setPath(resolved, path, structuredClone(value));
  }
  return resolved as unknown as SceneObject;
}

/** The value the definition would supply for a path, ignoring overrides. */
export function definitionValue(prefab: PrefabDef, path: string): unknown {
  return getPath(prefab.root, path);
}

export function isOverridden(obj: SceneObject, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj.overrides ?? {}, path);
}

/** Turn a scene object into a prefab template node. */
export function toPrefabNode(obj: SceneObject, children: SceneObject[] = []): PrefabNode {
  const {
    id: _id,
    layerId: _layerId,
    parentId: _parentId,
    prefab: _prefab,
    overrides: _overrides,
    ...rest
  } = structuredClone(obj);
  return { ...rest, children: children.map((c) => toPrefabNode(c)) };
}

/**
 * Child nodes of a prefab instance, positioned in world space. These render
 * as part of the instance and are not individually selectable — the instance
 * is the unit of editing.
 */
export function instanceChildren(
  prefab: PrefabDef,
  instance: SceneObject,
): { node: PrefabNode; x: number; y: number }[] {
  return prefab.root.children.map((node) => ({
    node,
    x: instance.x + node.x,
    y: instance.y + node.y,
  }));
}
