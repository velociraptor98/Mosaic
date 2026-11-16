import { getPath } from "../../shared/prefabs";
import type { PrefabNode, ResolvedPrefab } from "../../shared/types";

/**
 * The exposure catalogue: every value a prefab COULD publish to its instances,
 * with the name a level designer would recognise it by.
 *
 * Exposure is the contract between the definition and the levels. Checking a
 * field publishes it; an unchecked field never appears in a level inspector at
 * all. So the list has to be readable as a contract — named for the class the
 * value belongs to, not for the JSON path it happens to live at.
 */

export type ExposureSource = "component" | "data";

export interface ExposureEntry {
  path: string;
  /** "Body.bounce" — how the field is named in the list. */
  label: string;
  /** "component field · num" */
  from: string;
  source: ExposureSource;
  /** The definition's value, shown beside the field. */
  value: unknown;
  /**
   * Set when an exposed path no longer exists in the definition. The entry
   * keeps its place, greyed, until someone resolves it.
   */
  orphaned?: boolean;
}

/** Component fields worth publishing, in the order the inspector shows them. */
const COMPONENT_FIELDS: { path: string; label: string; type: string }[] = [
  { path: "texture", label: "Sprite.texture", type: "texture key" },
  { path: "frame", label: "Sprite.frame", type: "frame name" },
  { path: "scaleX", label: "Transform.scaleX", type: "num" },
  { path: "scaleY", label: "Transform.scaleY", type: "num" },
  { path: "rotation", label: "Transform.rotation", type: "deg" },
  { path: "visible", label: "Object.visible", type: "bool" },
  { path: "group", label: "Object.group", type: "group" },
  { path: "playOnSpawn", label: "Animations.playOnSpawn", type: "anim key" },
  { path: "body.width", label: "Body.width", type: "num" },
  { path: "body.height", label: "Body.height", type: "num" },
  { path: "body.offsetX", label: "Body.offsetX", type: "num" },
  { path: "body.offsetY", label: "Body.offsetY", type: "num" },
  { path: "body.immovable", label: "Body.immovable", type: "bool" },
  { path: "body.allowGravity", label: "Body.allowGravity", type: "bool" },
  { path: "body.bounce", label: "Body.bounce", type: "num" },
];

/**
 * Every publishable field of a definition. The class's own editable fields are
 * not here: a placed instance sets those directly, without exposure.
 */
export function exposureCatalog(
  prefab: ResolvedPrefab,
  exposed: string[] = prefab.exposed,
): ExposureEntry[] {
  const root = prefab.root;
  const entries: ExposureEntry[] = [];

  for (const field of COMPONENT_FIELDS) {
    const value = getPath(root, field.path);
    if (value === undefined && !exposed.includes(field.path)) continue;
    entries.push({
      path: field.path,
      label: field.label,
      from: `component field · ${field.type}`,
      source: "component",
      value,
    });
  }

  for (const key of Object.keys(root.data ?? {})) {
    entries.push({
      path: `data.${key}`,
      label: `data.${key}`,
      from: "instance data · json",
      source: "data",
      value: root.data[key],
    });
  }

  // Anything exposed that the catalogue no longer knows about keeps its place,
  // greyed out, so the contract does not silently shrink.
  const known = new Set(entries.map((e) => e.path));
  for (const path of exposed) {
    if (known.has(path)) continue;
    entries.push({
      path,
      label: path,
      from: "no longer declared — resolve or unexpose",
      source: "component",
      value: undefined,
      orphaned: true,
    });
  }

  return entries;
}

/** Child parts of a definition, for the Contents list. */
export function partsOf(root: PrefabNode): {
  lid: string;
  name: string;
  kind: string;
  detail: string;
  depth: number;
}[] {
  const out: { lid: string; name: string; kind: string; detail: string; depth: number }[] = [];
  const visit = (node: PrefabNode, depth: number) => {
    out.push({
      lid: node.lid,
      name: node.name,
      kind: node.prefab ? "nested prefab" : node.type,
      detail: detailOf(node),
      depth,
    });
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
}

function detailOf(node: PrefabNode): string {
  const bits: string[] = [];
  if (node.prefab) bits.push(`instance of ${node.prefab} · sealed`);
  if (node.texture) bits.push(node.frame ? `${node.texture} · ${node.frame}` : node.texture);
  if (node.body) {
    bits.push(
      node.body.shape === "circle"
        ? `body r${node.body.radius}`
        : `body ${node.body.width} × ${node.body.height}`,
    );
  }
  if (node.playOnSpawn) bits.push(`plays ${node.playOnSpawn}`);
  return bits.join(" · ") || node.type;
}
