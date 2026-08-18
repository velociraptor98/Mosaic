import { useEffect, useRef, useState } from "react";
import { fuzzyScore } from "../../commands";
import { scriptFilePath } from "../../../shared/scripts";
import type { ScriptClass } from "../../scripts/parse";
import { isValidClassName, toClassName } from "../../scripts/stub";
import { useEditor, useScripts, useStoreVersion } from "../context";

function filterClasses(all: ScriptClass[], query: string): ScriptClass[] {
  const q = query.trim();
  if (!q) return all.slice(0, 40);
  return all
    .map((cls) => ({ cls, score: fuzzyScore(q, `${cls.name} ${cls.src}`) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((r) => r.cls);
}

/**
 * Attach from what the project actually has.
 *
 * The list is real exported classes that extend ScriptComponent, indexed from
 * the source tree — there is no free-text class name here, because an attach
 * that cannot resolve is not worth offering. When nothing matches, the typed
 * name becomes a new file instead: "Create script…" writes the stub, indexes
 * it and attaches it in one action.
 */
export function AttachScriptDialog({ onClose }: { onClose: () => void }) {
  const { store, workspace } = useEditor();
  useStoreVersion(store);
  useScripts(workspace.scripts);

  const registry = workspace.scripts;
  const relink = store.ui.scriptRelink;
  const targets = relink
    ? store.selection.filter((o) => o.id === relink.objectId)
    : store.selection;
  const object = targets[0] ?? store.selection[0];

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    setCursor(0);
    setConfirming(null);
  }, [query]);

  const close = () => {
    store.setUi({ scriptRelink: null });
    onClose();
  };

  const attached = new Set(
    (object ? store.scriptsFor(object) : []).map((s) => `${s.src}::${s.class}`),
  );

  // Recomputed every render rather than memoised: the index changes under the
  // dialog whenever the watcher re-indexes, and a list of classes is small.
  const candidates = filterClasses(registry.attachable(), query);

  const typedName = toClassName(query.trim());
  const canCreate =
    !relink && !!typedName && isValidClassName(typedName) && !registry.sources.has(scriptFilePath(typedName));

  const choose = (cls: ScriptClass) => {
    if (!object) return;
    if (relink) {
      store.relinkScript(relink.objectId, relink.index, cls);
      close();
      return;
    }
    const key = `${cls.src}::${cls.name}`;
    // Attaching the same class twice is legal — it is how you get two of a
    // thing — but it is almost never what was meant, so it asks first.
    if (attached.has(key) && confirming !== key) {
      setConfirming(key);
      return;
    }
    store.attachScript(targets.map((o) => o.id), cls);
    store.setUi({ inspectorTab: "scripts" });
    close();
  };

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const cls = await registry.create(typedName);
    setBusy(false);
    if (!cls) {
      setError(`Could not write ${scriptFilePath(typedName)}`);
      return;
    }
    store.attachScript(targets.map((o) => o.id), cls);
    store.setUi({ inspectorTab: "scripts" });
    store.setStatus(`Created ${scriptFilePath(typedName)} and attached ${cls.name}`);
    close();
  };

  const rows = candidates.length;
  const run = (index: number) => {
    if (index < rows) choose(candidates[index]);
    else if (canCreate) void create();
  };

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette script-palette">
        <header className="palette-head">
          <span>{relink ? "Relink script" : "Attach script"}</span>
          <span className="muted">
            {object ? object.name : "no selection"} · <kbd>esc</kbd>
          </span>
        </header>
        <input
          ref={inputRef}
          value={query}
          placeholder="Class name…   (indexed from src/**: exported classes extending ScriptComponent)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, rows - (canCreate ? 0 : 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(cursor);
            } else if (e.key === "Escape") {
              close();
            }
          }}
        />
        <ul>
          {candidates.map((cls, i) => {
            const key = `${cls.src}::${cls.name}`;
            const isAttached = attached.has(key);
            return (
              <li
                key={key}
                className={i === cursor ? "active" : ""}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(cls);
                }}
              >
                <span className="title">{cls.name}</span>
                <span className="subtitle">
                  {cls.src} · {cls.properties.length} propert{cls.properties.length === 1 ? "y" : "ies"}
                </span>
                {confirming === key ? (
                  <span className="tag warn">attach a second copy?</span>
                ) : (
                  isAttached && <span className="tag">attached</span>
                )}
              </li>
            );
          })}

          {rows === 0 && !canCreate && (
            <li className="empty">
              {relink
                ? "No classes to relink to — the index is empty."
                : registry.loading
                  ? "Indexing src/…"
                  : "Nothing matches, and that is not a valid class name."}
            </li>
          )}

          {canCreate && (
            <li
              className={cursor >= rows ? "active create" : "create"}
              onMouseEnter={() => setCursor(rows)}
              onMouseDown={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <span className="title">{busy ? "Creating…" : `Create script "${typedName}"…`}</span>
              <span className="subtitle">
                writes {scriptFilePath(typedName)} from the stub, indexes it and attaches it
              </span>
            </li>
          )}
        </ul>
        {error && <div className="banner error">{error}</div>}
        <footer className="palette-foot">
          Abstract and non-exported classes are indexed — a subclass needs them — but they are not
          offered here.
        </footer>
      </div>
    </div>
  );
}
