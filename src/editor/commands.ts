import { platform } from "./platform";
import type { Workspace } from "./project/workspace";
import type { ProjectStore } from "./store/project";
import type { Playtest } from "./phaser/playtest";

export type DialogName =
  | "palette"
  | "newscene"
  | "import"
  | "atlas"
  | "prefab"
  | "collision"
  | "attachscript"
  | "scripttrust"
  | "export"
  | "promote"
  | null;

export interface CommandContext {
  store: ProjectStore;
  playtest: Playtest;
  workspace: Workspace;
  openDialog: (name: DialogName) => void;
}

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Displayed next to the title in the palette. */
  binding?: string;
  run: () => void;
}

export interface PaletteEntry {
  id: string;
  title: string;
  subtitle: string;
  kind: "command" | "scene" | "asset" | "prefab";
  binding?: string;
  run: () => void;
}

const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";

/**
 * Everything reachable by menu is reachable by keystroke. Each command
 * declares its own undo behaviour by going through the store.
 */
export function buildCommands(ctx: CommandContext): Command[] {
  const { store, playtest, workspace, openDialog } = ctx;

  const projectCommands: Command[] = platform.canOpenProjects
    ? [
        { id: "project.open", title: "Open project folder…", category: "Project", binding: `${mod}O`, run: () => void workspace.pickAndOpen() },
        { id: "project.new", title: "New project folder…", category: "Project", binding: `${mod}⇧N`, run: () => void workspace.createAndOpen() },
        { id: "project.save", title: "Save project to disk", category: "Project", binding: `${mod}S`, run: () => void workspace.saveNow() },
        { id: "project.reload", title: "Reload project from disk", category: "Project", run: () => void workspace.reload() },
        { id: "project.close", title: "Close project", category: "Project", binding: `${mod}W`, run: () => workspace.close() },
        { id: "project.reveal", title: "Reveal project in file manager", category: "Project", run: () => workspace.reveal() },
        { id: "project.git", title: "Refresh git status", category: "Project", run: () => void workspace.refreshGit() },
      ]
    : [];

  return [
    ...projectCommands,
    { id: "palette.open", title: "Open command palette", category: "General", binding: `${mod}K`, run: () => openDialog("palette") },
    { id: "scene.new", title: "New scene…", category: "Scene", binding: `${mod}N`, run: () => openDialog("newscene") },
    { id: "scene.export", title: "Export scene…", category: "Scene", binding: `${mod}E`, run: () => openDialog("export") },
    { id: "asset.import", title: "Import assets…", category: "Assets", binding: `${mod}I`, run: () => openDialog("import") },
    { id: "asset.atlas", title: "Slice atlas…", category: "Assets", run: () => openDialog("atlas") },
    { id: "prefab.create", title: "Create prefab from selection…", category: "Prefabs", run: () => openDialog("prefab") },
    { id: "physics.matrix", title: "Edit collision matrix…", category: "Physics", run: () => openDialog("collision") },
    { id: "script.attach", title: "Attach script to selection…", category: "Scripts", run: () => openDialog("attachscript") },
    { id: "script.inspect", title: "Show scripts on selection", category: "Scripts", run: () => store.setUi({ inspectorTab: "scripts" }) },
    { id: "script.reindex", title: "Re-index scripts from disk", category: "Scripts", run: () => { const root = workspace.location?.root; if (root) void workspace.scripts.load(root); } },

    { id: "tool.select", title: "Tool: Select", category: "Tools", binding: "V", run: () => store.setUi({ tool: "select" }) },
    { id: "tool.place", title: "Tool: Place", category: "Tools", binding: "B", run: () => store.setUi({ tool: "place" }) },
    { id: "tool.brush", title: "Tool: Paint tiles", category: "Tools", binding: "P", run: () => store.setUi({ tool: "brush", inspectorTab: "tile" }) },
    { id: "tool.rect", title: "Tool: Rect fill", category: "Tools", binding: "R", run: () => store.setUi({ tool: "rect", inspectorTab: "tile" }) },
    { id: "tool.erase", title: "Tool: Erase tiles", category: "Tools", binding: "E", run: () => store.setUi({ tool: "erase", inspectorTab: "tile" }) },

    { id: "view.snap", title: "Toggle snapping", category: "View", binding: "S", run: () => store.setUi({ snap: !store.ui.snap }) },
    { id: "view.grid", title: "Toggle grid", category: "View", binding: "G", run: () => store.setUi({ showGrid: !store.ui.showGrid }) },
    { id: "view.bodies", title: "Toggle physics bodies", category: "View", binding: "F2", run: () => store.setUi({ showBodies: !store.ui.showBodies }) },
    { id: "view.anim", title: "Open animation editor", category: "View", run: () => store.setUi({ dockTab: "anim" }) },
    { id: "view.assets", title: "Open asset browser", category: "View", run: () => store.setUi({ dockTab: "assets" }) },

    { id: "edit.undo", title: "Undo", category: "Edit", binding: `${mod}Z`, run: () => store.undo() },
    { id: "edit.redo", title: "Redo", category: "Edit", binding: `${mod}⇧Z`, run: () => store.redo() },
    { id: "edit.duplicate", title: "Duplicate selection", category: "Edit", binding: `${mod}D`, run: () => store.duplicateObjects(store.view.selection) },
    { id: "edit.delete", title: "Delete selection", category: "Edit", binding: "⌫", run: () => store.deleteObjects(store.view.selection) },
    { id: "edit.group", title: "Group selection", category: "Edit", binding: `${mod}G`, run: () => store.groupSelection() },

    { id: "layer.tile", title: "Add tile layer", category: "Layers", run: () => store.addLayer("tile") },
    { id: "layer.object", title: "Add object layer", category: "Layers", run: () => store.addLayer("object") },

    { id: "play.run", title: playtest.playing ? "Stop play-test" : "Run play-test", category: "Play", binding: `${mod}⏎`, run: () => (playtest.playing ? stopAndPrompt(ctx) : startPlaytest(ctx)) },
    { id: "play.pause", title: "Pause / resume", category: "Play", binding: "F5", run: () => (playtest.paused ? playtest.resume() : playtest.pause()) },
    { id: "play.step", title: "Step one frame", category: "Play", binding: "F6", run: () => playtest.step() },
  ];
}

/**
 * RUN, through the one door every entry point uses.
 *
 * A scene with behaviour on a project that has not been trusted asks first —
 * pressing play should never be the moment someone else's code starts running.
 */
export function startPlaytest(ctx: CommandContext): void {
  if (ctx.playtest.needsTrust()) {
    ctx.openDialog("scripttrust");
    return;
  }
  ctx.playtest.start();
}

export function stopAndPrompt(ctx: CommandContext): void {
  const pending = ctx.playtest.stop();
  if (pending.length) ctx.openDialog("promote");
}

/**
 * Fuzzy query over commands, scenes, assets and prefabs. Prefixes scope the
 * search: `scene:`, `asset:`, `prefab:`, `>` for commands only.
 */
export function searchPalette(query: string, ctx: CommandContext): PaletteEntry[] {
  const { store, openDialog } = ctx;
  let scope: PaletteEntry["kind"] | null = null;
  let q = query.trim();
  if (q.startsWith(">")) {
    scope = "command";
    q = q.slice(1).trim();
  } else if (q.toLowerCase().startsWith("scene:")) {
    scope = "scene";
    q = q.slice(6).trim();
  } else if (q.toLowerCase().startsWith("asset:")) {
    scope = "asset";
    q = q.slice(6).trim();
  } else if (q.toLowerCase().startsWith("prefab:")) {
    scope = "prefab";
    q = q.slice(7).trim();
  }

  const entries: PaletteEntry[] = [];

  if (!scope || scope === "command") {
    for (const cmd of buildCommands(ctx)) {
      entries.push({
        id: cmd.id,
        title: cmd.title,
        subtitle: cmd.category,
        kind: "command",
        binding: cmd.binding,
        run: cmd.run,
      });
    }
  }
  if (!scope || scope === "scene") {
    for (const scene of store.project.scenes) {
      entries.push({
        id: `scene:${scene.key}`,
        title: scene.name,
        subtitle: `Scene · ${scene.key}${store.isDirty(scene.key) ? " · modified" : ""}`,
        kind: "scene",
        run: () => store.activateScene(scene.key),
      });
    }
  }
  if (!scope || scope === "asset") {
    for (const asset of store.project.assets) {
      entries.push({
        id: `asset:${asset.id}`,
        title: asset.key,
        subtitle: `${asset.kind} · ${asset.path}`,
        kind: "asset",
        run: () => {
          store.setUi({
            dockTab: "assets",
            tool: "place",
            placement: { kind: "asset", id: asset.id },
          });
        },
      });
    }
  }
  if (!scope || scope === "prefab") {
    for (const prefab of store.project.prefabs) {
      entries.push({
        id: `prefab:${prefab.name}`,
        title: prefab.name,
        subtitle: `Prefab · ${prefab.exposed.length} exposed`,
        kind: "prefab",
        run: () =>
          store.setUi({ tool: "place", placement: { kind: "prefab", id: prefab.name } }),
      });
    }
  }
  if (!scope && !q) entries.push({
    id: "help.dialogs",
    title: "Tip: type scene:, asset:, prefab: or > to scope the search",
    subtitle: "Palette",
    kind: "command",
    run: () => openDialog(null),
  });

  if (!q) return entries.slice(0, 40);

  return entries
    .map((entry) => ({ entry, score: fuzzyScore(q, `${entry.title} ${entry.subtitle}`) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((r) => r.entry);
}

/** Subsequence match; consecutive hits and word starts score higher. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    score += found === 0 || t[found - 1] === " " ? 3 : 1;
    score += streak;
    streak = found === ti ? streak + 1 : 0;
    ti = found + 1;
  }
  return score;
}
