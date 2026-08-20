import { objectSize } from "../../shared/size";
import {
  ensureLids,
  newLid,
  prefabBounds,
  walkNodes,
} from "../../shared/prefabs";
import type {
  ObjectLayer,
  PrefabNode,
  ProjectData,
  ResolvedPrefab,
  SceneData,
  SceneObject,
} from "../../shared/types";

/**
 * The isolated stage.
 *
 * Prefab edit mode is not a second editor: the definition is turned into a
 * one-layer SceneData, and every tool the editor already has — the canvas,
 * the outliner, the inspector, drag, undo — operates on it unchanged. What
 * makes it "prefab edit mode" is that the stage is empty apart from the
 * object, so nothing you drag can accidentally land in a level, and that the
 * document is written back to the definition rather than to a scene.
 *
 * Local ids are the hinge: a node's `lid` becomes the scene object's `id` and
 * comes back as the same `lid` on save, so overrides and the propagation plan
 * keep pointing at the same part across an edit session.
 */

export const PREFAB_LAYER_ID = "prefab-stage";

export function prefabDocKey(name: string): string {
  return `prefab:${name}`;
}

export function isPrefabDocKey(key: string): boolean {
  return key.startsWith("prefab:");
}

/** The drawn size of a part, for the bounds outline the stage shows. */
export function nodeSize(project: ProjectData, node: PrefabNode): { width: number; height: number } {
  return objectSize(project, node);
}

export interface StageGeometry {
  width: number;
  height: number;
  /** Where the prefab's own origin sits on the stage. */
  anchorX: number;
  anchorY: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * A stage sized around the object with room to work, snapped to the grid so
 * the object still sits on whole cells. Never smaller than a few cells: an
 * empty prefab should still give you somewhere to drop the first part.
 */
export function stageFor(project: ProjectData, root: PrefabNode): StageGeometry {
  const bounds = prefabBounds(root, (node) => nodeSize(project, node));
  const grid = project.config.tile || 32;
  const pad = grid * 3;
  const width = Math.max(grid * 10, roundTo(bounds.width + pad * 2, grid));
  const height = Math.max(grid * 8, roundTo(bounds.height + pad * 2, grid));
  return {
    width,
    height,
    anchorX: roundTo(width / 2 - (bounds.x + bounds.width / 2), 1) + bounds.x + bounds.width / 2,
    anchorY: roundTo(height / 2 - (bounds.y + bounds.height / 2), 1) + bounds.y + bounds.height / 2,
    bounds,
  };
}

function roundTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export interface PrefabDocScene {
  scene: SceneData;
  /** The scene object standing in for the definition's root node. */
  rootId: string;
  geometry: StageGeometry;
}

/**
 * Definition tree -> editable scene. The root lands on the stage anchor;
 * children keep the local offsets they had, because those offsets are the
 * definition.
 */
export function prefabToScene(
  project: ProjectData,
  prefab: ResolvedPrefab,
): PrefabDocScene {
  const root = ensureLids(structuredClone(prefab.root));
  const geometry = stageFor(project, root);

  const layer: ObjectLayer = {
    id: PREFAB_LAYER_ID,
    kind: "object",
    name: "Prefab",
    visible: true,
    locked: false,
  };

  const objects: SceneObject[] = [];
  const visit = (node: PrefabNode, parentId: string | null) => {
    const { children: _children, lid, ...rest } = node;
    objects.push({
      ...(rest as unknown as SceneObject),
      id: lid,
      layerId: layer.id,
      parentId,
      x: parentId === null ? geometry.anchorX : node.x,
      y: parentId === null ? geometry.anchorY : node.y,
    });
    for (const child of node.children ?? []) visit(child, lid);
  };
  visit(root, null);

  const scene: SceneData = {
    key: prefabDocKey(prefab.name),
    name: `${prefab.name}.prefab`,
    settings: {
      width: geometry.width,
      height: geometry.height,
      backgroundColor: "#f2f2f3",
      gravityY: 0,
      gridSize: project.config.tile || 32,
    },
    layers: [layer],
    objects,
  };

  return { scene, rootId: root.lid, geometry };
}

/**
 * Editable scene -> definition tree. The root's position is dropped: an
 * instance owns x/y, so a prefab root's own coordinates are always 0 and the
 * stage anchor is a viewing convenience, not data.
 */
export function sceneToPrefabNode(scene: SceneData, rootId: string): PrefabNode {
  const byId = new Map(scene.objects.map((o) => [o.id, o]));
  const rootObj = byId.get(rootId) ?? scene.objects.find((o) => !o.parentId);
  if (!rootObj) {
    throw new Error("prefab document has no root object");
  }

  // Anything the author added at the top level belongs to the prefab too —
  // adopt it rather than losing it, and keep its position on the stage.
  const adopted = scene.objects.filter((o) => !o.parentId && o.id !== rootObj.id);

  const build = (obj: SceneObject, local: { x: number; y: number }): PrefabNode => {
    const {
      id,
      layerId: _layerId,
      parentId: _parentId,
      ...rest
    } = structuredClone(obj);
    const children = scene.objects
      .filter((o) => o.parentId === id)
      .map((child) => build(child, { x: child.x, y: child.y }));
    return {
      ...(rest as unknown as Omit<PrefabNode, "lid" | "children">),
      x: local.x,
      y: local.y,
      lid: id || newLid(),
      children,
    };
  };

  const root = build(rootObj, { x: 0, y: 0 });
  for (const extra of adopted) {
    root.children.push(build(extra, { x: extra.x - rootObj.x, y: extra.y - rootObj.y }));
  }
  // The root of a definition is never itself an instance of something else.
  delete root.prefab;
  delete root.overrides;
  return root;
}

/** Local ids present in a tree — what an exposure path may still address. */
export function lidsOf(root: PrefabNode): Set<string> {
  return new Set(walkNodes(root).map((n) => n.lid));
}
