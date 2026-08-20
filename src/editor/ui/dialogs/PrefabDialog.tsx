import { useMemo, useState } from "react";
import { prefabFilePath } from "../../store/project";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

/**
 * PROMOTE — a prefab starts as something already on screen.
 *
 * You build the object in the scene first, then promote it. This dialog names
 * the file, shows where it lands, and says what happens to the thing you
 * selected: it BECOMES the first instance rather than being replaced by a
 * copy of itself. Its id survives, so anything referencing it still resolves.
 */
export function PrefabDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const selection = store.selection;
  const check = store.promoteCheck(selection.map((o) => o.id));

  const [name, setName] = useState(() => {
    const base = check.root?.name ?? selection[0]?.type ?? "Prefab";
    return base.replace(/[^\w]+/g, "_").replace(/^(\w)/, (m) => m.toUpperCase());
  });
  const [keepAsInstance, setKeepAsInstance] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(true);
  const [openAfter, setOpenAfter] = useState(true);
  const [replace, setReplace] = useState(false);

  const clean = name.trim();
  const collision = store.project.prefabs.find((p) => p.name === clean);
  const numbered = useMemo(() => {
    let n = 2;
    while (store.project.prefabs.some((p) => p.name === `${clean}_${n}`)) n += 1;
    return `${clean}_${n}`;
  }, [store.project.prefabs, clean]);

  if (!selection.length) {
    return (
      <Dialog title="Create prefab from selection" onClose={onClose}>
        <div className="empty">
          Select the object first. A prefab is made FROM something already on screen — build it in
          the scene, then promote it.
        </div>
      </Dialog>
    );
  }

  const blocked = !check.ok || !clean || (!!collision && !replace);

  return (
    <Dialog
      title="Create prefab from selection"
      subtitle={
        check.ok
          ? `${check.root!.name} becomes the definition, and stays in this scene as its first instance.` +
            (check.siblings.length
              ? ` ${check.siblings.length} other selected object(s) are relinked as instances of it.`
              : "")
          : undefined
      }
      onClose={onClose}
      footer={
        <>
          <span className="dialog-foot-note">
            writes 1 file ·{" "}
            {keepAsInstance
              ? `rewrites ${1 + check.siblings.length} scene node(s)`
              : "leaves the scene alone"}
          </span>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={blocked}
            onClick={() => {
              const made = store.createPrefab({
                name: clean,
                objectId: check.root!.id,
                exposed: seedExposure(check.root!),
                includeChildren,
                keepAsInstance,
                siblingIds: check.siblings.map((o) => o.id),
                replace,
              });
              onClose();
              if (made && openAfter) store.openPrefab(made.name);
            }}
          >
            {collision && replace ? "Replace prefab" : "Create prefab"}
          </button>
        </>
      }
    >
      {!check.ok && (
        <div className="banner error">
          {check.reason}. A prefab has one root — promoting a selection with two parents would
          have to invent one.
        </div>
      )}

      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>

      <div className="kv">
        <span>Save to</span>
        <code>{prefabFilePath(clean || "Untitled")}</code>
      </div>

      {collision && (
        <div className="banner warn">
          <span>That name is taken by an existing prefab.</span>
          <div className="row">
            <button className={`chip toggle ${replace ? "on" : ""}`} onClick={() => setReplace(!replace)}>
              Replace {clean}
            </button>
            <button
              className="chip"
              onClick={() => {
                setName(numbered);
                setReplace(false);
              }}
            >
              Use {numbered}
            </button>
          </div>
        </div>
      )}

      <div className="section-title">Options</div>
      <PromoteOption
        on={keepAsInstance}
        onToggle={() => setKeepAsInstance(!keepAsInstance)}
        label="Keep the selected object as an instance"
        note="no duplicate is created in the scene — the node you selected is rewritten in place, keeping its id"
      />
      <PromoteOption
        on={includeChildren}
        onToggle={() => setIncludeChildren(!includeChildren)}
        label={`Include child objects (${check.children.length})`}
        note={check.children.map((c) => c.name).join(", ") || "this object has no children"}
        disabled={!check.children.length}
      />
      <PromoteOption
        on={openAfter}
        onToggle={() => setOpenAfter(!openAfter)}
        label="Open prefab edit mode after creating"
        note="edit the definition on an empty stage, and decide what instances may change"
      />

      {check.siblings.length > 0 && (
        <div className="banner">
          {check.siblings.length} other selected object(s) become instances too. Where one of them
          already differs on an exposed field, that difference is recorded as ITS override — so
          nothing is silently flattened to {check.root!.name}'s values.
        </div>
      )}

      {check.unresolved.length > 0 && (
        <div className="banner warn">
          <strong>{check.unresolved.length} unresolvable link(s).</strong> These point at objects
          the prefab will not contain, so they will not resolve once it is placed in another scene:
          <ul className="tight-list">
            {check.unresolved.map((u, i) => (
              <li key={i}>
                <code>{u.property}</code> on {u.object} → <code>{u.target}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="hint">
        Per-instance <code>data</code> keys start exposed, because those are per-copy by nature.
        Everything else stays locked to the definition until you publish it in the{" "}
        <strong>Expose</strong> list in prefab edit mode — that list is the contract, and it is
        what keeps fifty of these from drifting into fifty different objects.
      </p>
    </Dialog>
  );
}

function PromoteOption({
  on,
  onToggle,
  label,
  note,
  disabled,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  note: string;
  disabled?: boolean;
}) {
  return (
    <label className={`promote-option ${on && !disabled ? "on" : ""} ${disabled ? "disabled" : ""}`}>
      <input type="checkbox" checked={on && !disabled} disabled={disabled} onChange={onToggle} />
      <span>
        <strong>{label}</strong>
        <em>{note}</em>
      </span>
    </label>
  );
}

/**
 * What a brand-new prefab publishes: its per-instance data keys, and nothing
 * else. Fifty slimes should start identical — divergence is opted into, field
 * by field, in the Expose list.
 */
function seedExposure(root: { data?: Record<string, unknown> }): string[] {
  return Object.keys(root.data ?? {}).map((key) => `data.${key}`);
}
