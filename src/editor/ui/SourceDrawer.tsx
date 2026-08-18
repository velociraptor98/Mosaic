import { useEffect, useState } from "react";
import { platform } from "../platform";
import { useEditor, useScripts, useStoreVersion } from "./context";

/**
 * Peek the file without leaving the scene.
 *
 * Read-only by design: the declarations the inspector is rendering are
 * highlighted so the mapping from field to code is obvious, and editing
 * happens in the user's real editor, one click away. The drawer shows the text
 * you opened — when the file changes underneath you it offers a reload rather
 * than moving the code you are reading.
 */
export function SourceDrawer() {
  const { store, workspace } = useEditor();
  useStoreVersion(store);
  useScripts(workspace.scripts);

  const view = store.ui.sourceView;
  const registry = workspace.scripts;
  const [shown, setShown] = useState<string | null>(null);

  const current = view ? registry.sourceOf(view.src) : null;

  // Opening a different file always shows that file's current text.
  useEffect(() => {
    setShown(view ? (registry.sourceOf(view.src) ?? null) : null);
  }, [view?.src, registry, view]);

  if (!view) return null;
  if (current === null && shown === null) {
    return (
      <aside className="source-drawer">
        <header>
          <code>{view.src}</code>
          <button className="mini" onClick={() => store.setUi({ sourceView: null })}>
            ✕
          </button>
        </header>
        <div className="empty">This file is not in the index — it may have been deleted.</div>
      </aside>
    );
  }

  const text = shown ?? current ?? "";
  const stale = current !== null && current !== shown;
  const cls = registry.index.classes.find((c) => c.src === view.src && c.name === view.className);
  const highlighted = new Set<number>();
  for (const property of cls ? registry.properties(cls) : []) {
    if (property.line >= 1) {
      for (let line = property.line; line <= property.endLine; line++) highlighted.add(line);
    }
  }

  const lines = text.split(/\r?\n/);

  return (
    <aside className="source-drawer">
      <header>
        <code title={view.src}>{view.src}</code>
        <span className="tag">read only</span>
        {platform.canOpenProjects && (
          <button
            className="mini"
            title="Open at the first property declaration"
            onClick={() => void registry.openExternal(view.src, cls?.properties[0]?.line ?? cls?.line)}
          >
            Open in editor ↗
          </button>
        )}
        <button className="mini" onClick={() => store.setUi({ sourceView: null })}>
          ✕
        </button>
      </header>

      {stale && (
        <div className="banner warn">
          {view.src} changed on disk. The field list already re-indexed; this text has not.
          <button className="mini" onClick={() => setShown(current)}>
            Reload
          </button>
        </div>
      )}

      <div className="source-code">
        {lines.map((line, i) => (
          <div key={i} className={`source-line ${highlighted.has(i + 1) ? "hl" : ""}`}>
            <span className="n">{i + 1}</span>
            <span className="t">{line || " "}</span>
          </div>
        ))}
      </div>

      <footer>
        highlighted lines are the <code>@property</code> declarations the inspector is rendering
      </footer>
    </aside>
  );
}
