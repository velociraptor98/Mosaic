import {
  diffChildren,
  diffNodes,
  isOverridden,
  resolvePrefab,
  same,
  variantsOf,
} from "./prefabs";
import type { PrefabDef, ProjectData, SceneObject } from "./types";

/**
 * What a definition change costs, worked out BEFORE it happens.
 *
 * Saving a prefab is the one edit in the editor that reaches into files the
 * author is not looking at. So it is the one edit that has to say, in advance,
 * which scenes it touches, which instances move, and which values an instance
 * claimed for itself and therefore keeps. Nothing here writes anything.
 */

export type RowKind = "moved" | "kept" | "dropped" | "added" | "removed" | "skipped";

export interface PlanRow {
  kind: RowKind;
  /** The change, in the words the panel prints. */
  what: string;
  /** Who it lands on: an instance count, or one named instance. */
  where: string;
  path?: string;
  /** Scene keys this row touches — how "Review each" builds its queue. */
  scenes: string[];
  instanceIds: string[];
}

export interface ScenePlan {
  key: string;
  name: string;
  instances: number;
  moved: number;
  kept: number;
  dropped: number;
  /** Set when the scene will not be written, with the reason why. */
  skipped?: string;
}

export interface PropagationPlan {
  prefab: string;
  rows: PlanRow[];
  scenes: ScenePlan[];
  /** Variants that resolve from this prefab and therefore move with it. */
  variants: string[];
  totals: { moved: number; kept: number; dropped: number; instances: number; scenes: number };
  /** True when the definition itself is unchanged — nothing to push. */
  unchanged: boolean;
}

export interface PlanOptions {
  /** Reason a scene cannot be written, or null when it can. */
  readOnly?: (sceneKey: string) => string | null;
}

/** Every instance of any of `names`, with the scene it sits in. */
function instancesOf(
  project: ProjectData,
  names: Set<string>,
): { scene: string; sceneName: string; obj: SceneObject }[] {
  const out: { scene: string; sceneName: string; obj: SceneObject }[] = [];
  for (const scene of project.scenes) {
    for (const obj of scene.objects) {
      if (obj.prefab && names.has(obj.prefab)) {
        out.push({ scene: scene.key, sceneName: scene.name, obj });
      }
    }
  }
  return out;
}

function label(path: string, project: ProjectData, prefabName: string): string {
  // `scripts.0.props.chaseSpeed` reads as `SlimeAI.chaseSpeed` — the class the
  // value belongs to is what the author named it by.
  const script = /^scripts\.(\d+)\.props\.(.+)$/.exec(path);
  if (script) {
    const prefab = resolvePrefab(project, prefabName);
    const cls = prefab?.root.scripts?.[Number(script[1])]?.class;
    return cls ? `${cls}.${script[2]}` : path;
  }
  const enabled = /^scripts\.(\d+)\.enabled$/.exec(path);
  if (enabled) {
    const prefab = resolvePrefab(project, prefabName);
    const cls = prefab?.root.scripts?.[Number(enabled[1])]?.class;
    return cls ? `${cls} enabled` : path;
  }
  return path;
}

function show(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The consequences of replacing `project.prefabs` with `nextPrefabs`.
 *
 * Everything is computed against the CURRENT project: the plan is what would
 * happen, so the caller can show it and let the author decline.
 */
export function planPropagation(
  project: ProjectData,
  prefabName: string,
  nextPrefabs: PrefabDef[],
  options: PlanOptions = {},
): PropagationPlan {
  const next: ProjectData = { ...project, prefabs: nextPrefabs };

  // Editing a base moves its variants too, so they are part of the blast
  // radius even though nobody edited their files.
  const affected = new Set<string>([prefabName]);
  for (const variant of variantsOf(next, prefabName)) affected.add(variant.name);

  const rows: PlanRow[] = [];
  const perScene = new Map<string, ScenePlan>();
  const touched = new Set<string>();

  for (const scene of project.scenes) {
    perScene.set(scene.key, {
      key: scene.key,
      name: scene.name,
      instances: 0,
      moved: 0,
      kept: 0,
      dropped: 0,
      skipped: options.readOnly?.(scene.key) ?? undefined,
    });
  }

  const all = instancesOf(project, affected);
  for (const entry of all) perScene.get(entry.scene)!.instances += 1;

  let anyDefinitionChange = false;

  for (const name of affected) {
    const before = resolvePrefab(project, name);
    const after = resolvePrefab(next, name);
    if (!after) continue;
    if (!before) {
      anyDefinitionChange = true;
      continue;
    }

    const changes = diffNodes(before.root, after.root);
    const children = diffChildren(before.root, after.root);
    const unexposed = before.exposed.filter((p) => !after.exposed.includes(p));
    if (changes.length || children.length || unexposed.length) anyDefinitionChange = true;

    const mine = all.filter((e) => e.obj.prefab === name);

    for (const change of changes) {
      const overriding = mine.filter((e) => isOverridden(e.obj, change.path));
      const moving = mine.filter((e) => !isOverridden(e.obj, change.path));
      const text =
        change.kind === "added"
          ? `${label(change.path, next, name)} added · ${show(change.after)}`
          : change.kind === "removed"
            ? `${label(change.path, project, name)} removed`
            : `${label(change.path, next, name)}  ${show(change.before)} → ${show(change.after)}`;

      if (moving.length) {
        rows.push({
          kind: change.kind === "removed" ? "removed" : change.kind === "added" ? "added" : "moved",
          what: text,
          where: countLabel(moving.length, name, prefabName),
          path: change.path,
          scenes: [...new Set(moving.map((e) => e.scene))],
          instanceIds: moving.map((e) => e.obj.id),
        });
        for (const e of moving) {
          perScene.get(e.scene)!.moved += 1;
          touched.add(e.scene);
        }
      }
      for (const e of overriding) {
        rows.push({
          kind: "kept",
          what: `${label(change.path, next, name)} override ${show(e.obj.overrides?.[change.path])}`,
          where: `${e.sceneName} · ${e.obj.name}${name === prefabName ? "" : ` (${name})`}`,
          path: change.path,
          scenes: [e.scene],
          instanceIds: [e.obj.id],
        });
        perScene.get(e.scene)!.kept += 1;
        touched.add(e.scene);
      }
    }

    for (const child of children) {
      rows.push({
        kind: child.kind === "added" ? "added" : "removed",
        what: `child object "${child.name}" ${child.kind === "added" ? "added to" : "removed from"} the definition`,
        where: countLabel(mine.length, name, prefabName),
        scenes: [...new Set(mine.map((e) => e.scene))],
        instanceIds: mine.map((e) => e.obj.id),
      });
      for (const e of mine) touched.add(e.scene);
    }

    // An override on a path the definition no longer publishes cannot survive
    // — say so and count it rather than dropping it quietly.
    for (const path of unexposed) {
      const holders = mine.filter((e) => isOverridden(e.obj, path));
      if (!holders.length) continue;
      rows.push({
        kind: "dropped",
        what: `${label(path, project, name)} override (field unexposed)`,
        where: countLabel(holders.length, name, prefabName),
        path,
        scenes: [...new Set(holders.map((e) => e.scene))],
        instanceIds: holders.map((e) => e.obj.id),
      });
      for (const e of holders) {
        perScene.get(e.scene)!.dropped += 1;
        touched.add(e.scene);
      }
    }
  }

  for (const plan of perScene.values()) {
    if (plan.skipped && touched.has(plan.key)) {
      rows.push({
        kind: "skipped",
        what: `${plan.name} — ${plan.skipped}`,
        where: "—",
        scenes: [plan.key],
        instanceIds: [],
      });
    }
  }

  const scenes = [...perScene.values()].filter((s) => s.instances > 0 || touched.has(s.key));
  const order: RowKind[] = ["moved", "added", "removed", "kept", "dropped", "skipped"];
  rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  return {
    prefab: prefabName,
    rows,
    scenes,
    variants: [...affected].filter((n) => n !== prefabName),
    totals: {
      moved: scenes.reduce((n, s) => n + s.moved, 0),
      kept: scenes.reduce((n, s) => n + s.kept, 0),
      dropped: scenes.reduce((n, s) => n + s.dropped, 0),
      instances: all.length,
      scenes: [...touched].length,
    },
    unchanged: !anyDefinitionChange,
  };
}

function countLabel(n: number, name: string, prefabName: string): string {
  const suffix = name === prefabName ? "" : ` · ${name} (variant)`;
  return `${n} instance${n === 1 ? "" : "s"}${suffix}`;
}

/**
 * Overrides an exposure change would drop, before it is made. The confirm the
 * expose list shows is built from this: it names the count and the scenes.
 */
export function unexposeImpact(
  project: ProjectData,
  prefabName: string,
  path: string,
): { count: number; scenes: string[]; instances: string[] } {
  const affected = new Set<string>([prefabName]);
  for (const variant of variantsOf(project, prefabName)) affected.add(variant.name);
  const holders = instancesOf(project, affected).filter((e) => isOverridden(e.obj, path));
  return {
    count: holders.length,
    scenes: [...new Set(holders.map((e) => e.sceneName))],
    instances: holders.map((e) => e.obj.id),
  };
}

/** Instances of a prefab (and its variants), for the usage list. */
export function prefabUsage(
  project: ProjectData,
  prefabName: string,
): { scene: string; sceneName: string; count: number }[] {
  const affected = new Set<string>([prefabName]);
  for (const variant of variantsOf(project, prefabName)) affected.add(variant.name);
  const counts = new Map<string, { scene: string; sceneName: string; count: number }>();
  for (const entry of instancesOf(project, affected)) {
    const row = counts.get(entry.scene) ?? {
      scene: entry.scene,
      sceneName: entry.sceneName,
      count: 0,
    };
    row.count += 1;
    counts.set(entry.scene, row);
  }
  return [...counts.values()];
}

/** True when two definitions would resolve to the same thing. */
export function definitionsMatch(a: PrefabDef, b: PrefabDef): boolean {
  return same(a, b);
}
