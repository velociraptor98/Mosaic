import { useMemo, useState } from "react";
import { getPath } from "../../../shared/prefabs";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

/** Candidate override paths, offered from the shared shape of the selection. */
const CANDIDATE_PATHS = [
  "texture",
  "frame",
  "scaleX",
  "scaleY",
  "rotation",
  "visible",
  "group",
  "playOnSpawn",
  "body.width",
  "body.height",
  "body.immovable",
];

/**
 * Choose which properties instances may override. Everything else is owned by
 * the definition and updates everywhere at once.
 */
export function PrefabDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const selection = store.selection;
  const [name, setName] = useState(() => {
    const base = selection[0]?.type ?? "Prefab";
    return base.charAt(0).toUpperCase() + base.slice(1);
  });

  const dataPaths = useMemo(() => {
    const keys = new Set<string>();
    for (const obj of selection) for (const k of Object.keys(obj.data ?? {})) keys.add(`data.${k}`);
    return [...keys];
  }, [selection]);

  const [exposed, setExposed] = useState<string[]>(dataPaths);
  const taken = store.project.prefabs.some((p) => p.name === name);

  const toggle = (path: string) =>
    setExposed((e) => (e.includes(path) ? e.filter((p) => p !== path) : [...e, path]));

  if (!selection.length) {
    return (
      <Dialog title="Create prefab" onClose={onClose}>
        <div className="empty">
          Select the repeated objects first — marquee them on the canvas or shift-click in the
          Outliner.
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Create prefab"
      subtitle={`${selection.length} selected object(s) become instances of this definition.`}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!name.trim() || taken}
            onClick={() => {
              store.createPrefab(name.trim(), exposed, selection.map((o) => o.id));
              onClose();
            }}
          >
            Create prefab
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <p className="hint">
        Writes <code>prefabs/{name || "Name"}.prefab.json</code>
        {taken && " — that name is taken"}
      </p>

      <div className="section-title">Instances may override</div>
      <div className="expose-grid">
        {[...dataPaths, ...CANDIDATE_PATHS].map((path) => {
          const values = selection.map((o) => JSON.stringify(getPath(o, path)));
          const differs = new Set(values).size > 1;
          return (
            <label key={path} className={`expose ${exposed.includes(path) ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={exposed.includes(path)}
                onChange={() => toggle(path)}
              />
              <code>{path}</code>
              {differs && <span className="meta">differs across selection</span>}
            </label>
          );
        })}
      </div>
      <p className="hint">
        Fields that already differ across the selection are recorded as per-instance overrides
        automatically, so nothing is silently flattened.
      </p>
    </Dialog>
  );
}
