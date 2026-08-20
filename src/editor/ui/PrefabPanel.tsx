import { useState } from "react";
import {
  canInherit,
  getPath,
  isOverridden,
  resolvePrefab,
  variantDepth,
} from "../../shared/prefabs";
import { prefabUsage } from "../../shared/propagate";
import { exposureCatalog, partsOf, type ExposureEntry } from "../store/exposure";
import { prefabFilePath } from "../store/project";
import { useEditor, useScripts, useStoreVersion } from "./context";

/**
 * The Prefab tab, which shows one of three things depending on what you are
 * looking at:
 *
 *   - a prefab document open  -> its contents, its contract, its variants
 *   - an instance selected    -> what it inherits and what it claims
 *   - a plain object selected -> the offer to promote it
 */
export function PrefabPanel() {
  const { store, workspace } = useEditor();
  useStoreVersion(store);
  useScripts(workspace.scripts);

  if (store.prefabDoc) return <DefinitionView />;
  return <InstanceView />;
}

// ---------------------------------------------------------------- definition

function DefinitionView() {
  const { store, workspace } = useEditor();
  const doc = store.prefabDoc!;
  const resolved = store.prefabDocResolved();
  const [section, setSection] = useState<"contents" | "expose" | "variants">("contents");
  if (!resolved) return <div className="empty">This prefab has no definition to show.</div>;

  const usage = prefabUsage(store.project, doc.name);
  const total = usage.reduce((n, u) => n + u.count, 0);
  const catalog = exposureCatalog(resolved, workspace.scripts, doc.exposed);

  return (
    <div className="stack">
      <div className="kicker">{doc.base ? "VARIANT" : "PREFAB"}</div>
      <h3 className="panel-title">{doc.name}</h3>
      <div className="kv">
        <span>File</span>
        <code>{prefabFilePath(doc.name)}</code>
      </div>
      <div className="kv">
        <span>Instances</span>
        <code>
          {total} across {usage.length} scene(s)
        </code>
      </div>
      {doc.base && (
        <div className="kv">
          <span>Inherits</span>
          <code>{doc.base}</code>
        </div>
      )}

      <div className="segmented">
        {(["contents", "expose", "variants"] as const).map((id) => (
          <button
            key={id}
            className={section === id ? "active" : ""}
            onClick={() => setSection(id)}
          >
            {id === "expose" ? `Expose · ${doc.exposed.length}` : id}
          </button>
        ))}
      </div>

      {section === "contents" && <ContentsSection />}
      {section === "expose" && <ExposeSection catalog={catalog} />}
      {section === "variants" && <VariantsSection />}
    </div>
  );
}

/**
 * COMPOSE — composition IS the definition. Sprite, body, scripts and child
 * objects in one list, the same shape as a plain scene object, so nothing new
 * has to be learned to author a prefab.
 */
function ContentsSection() {
  const { store } = useEditor();
  const doc = store.prefabDoc!;
  const resolved = store.prefabDocResolved();
  const stage = store.prefabStage();
  if (!resolved) return null;
  const parts = partsOf(resolved.root);

  return (
    <>
      <div className="section-title">Parts</div>
      <div className="parts-list">
        {parts.map((part) => (
          <button
            key={part.lid}
            className={`part-row ${store.view.selection.includes(part.lid) ? "active" : ""}`}
            style={{ paddingLeft: 8 + part.depth * 14 }}
            onClick={() => store.setSelection([part.lid])}
          >
            <span className="glyph">{part.depth === 0 ? "◆" : part.kind === "nested prefab" ? "⬡" : "▦"}</span>
            <span className="name">{part.name}</span>
            <span className="meta">{part.detail}</span>
          </button>
        ))}
      </div>

      {stage && (
        <>
          <div className="section-title">Definition-only</div>
          <div className="readout">
            <span>
              bounds {Math.round(stage.bounds.width)} × {Math.round(stage.bounds.height)}
            </span>
            <span>
              origin {resolved.root.originX} / {resolved.root.originY}
            </span>
            {resolved.root.body && (
              <span>
                body{" "}
                {resolved.root.body.shape === "circle"
                  ? `r${resolved.root.body.radius}`
                  : `${resolved.root.body.width} × ${resolved.root.body.height}`}
              </span>
            )}
          </div>
          <div className="hint">
            Origin and body are drawn on the stage because they are the two things an instance
            cannot fix later. They are never overridable per instance.
          </div>
        </>
      )}

      <div className="hint">
        Drop an asset on the stage to add a part — on the isolated stage everything you place
        belongs to {doc.name}, so nothing can land in a level by accident.
      </div>
    </>
  );
}

/**
 * EXPOSE — decide what an instance may change.
 *
 * Not every value should be per-copy. Checking a field publishes it to
 * instances; unchecked fields stay locked to the definition and never appear
 * in a level inspector. This is the contract that keeps fifty slimes from
 * drifting into fifty different objects.
 */
function ExposeSection({ catalog }: { catalog: ExposureEntry[] }) {
  const { store } = useEditor();
  const doc = store.prefabDoc!;
  const [confirming, setConfirming] = useState<{
    path: string;
    count: number;
    scenes: string[];
  } | null>(null);

  const toggle = (entry: ExposureEntry) => {
    const on = doc.exposed.includes(entry.path);
    if (!on) return store.toggleExposed(entry.path);
    // Unexposing drops overrides. Say how many, and where, before it happens.
    const impact = store.unexposeImpact(entry.path);
    if (!impact.count) return store.toggleExposed(entry.path);
    setConfirming({ path: entry.path, count: impact.count, scenes: impact.scenes });
  };

  return (
    <>
      <div className="section-title">
        Instance-editable fields
        <span className="count">
          {doc.exposed.length} of {catalog.length} exposed
        </span>
      </div>

      <div className="expose-list">
        {catalog.map((entry) => {
          const on = doc.exposed.includes(entry.path);
          return (
            <label
              key={entry.path}
              className={`expose-row ${on ? "on" : ""} ${entry.orphaned ? "orphaned" : ""}`}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(entry)} />
              <span className="expose-name">
                <strong>{entry.label}</strong>
                <em>{entry.from}</em>
              </span>
              <code className={`expose-value ${on ? "on" : ""}`}>
                {entry.value === undefined ? "—" : JSON.stringify(entry.value)}
              </code>
            </label>
          );
        })}
      </div>

      {confirming && (
        <div className="banner warn confirm">
          <strong>
            {confirming.count} instance(s) override <code>{confirming.path}</code>.
          </strong>
          <span>
            Unexposing it drops those overrides in {confirming.scenes.join(", ")} — they cannot be
            kept, because a level inspector would have no row to show them in.
          </span>
          <div className="row">
            <button className="ghost" onClick={() => setConfirming(null)}>
              Keep it exposed
            </button>
            <button
              className="danger"
              onClick={() => {
                store.toggleExposed(confirming.path);
                setConfirming(null);
              }}
            >
              Unexpose and drop {confirming.count}
            </button>
          </div>
        </div>
      )}

      {catalog.some((e) => e.orphaned) && (
        <div className="hint">
          A greyed row is exposed but no longer declared — the class dropped the{" "}
          <code>@property</code>, or the component went away. It keeps its place until you resolve
          it, rather than shrinking the contract behind your back.
        </div>
      )}

      <div className="hint">
        Exposed fields become the WHOLE instance inspector. Keep the list short, and named for the
        people who will place these in levels.
      </div>
    </>
  );
}

/**
 * VARIANTS — a variant inherits everything and states only its differences:
 * three fields, not a second copy of the object.
 */
function VariantsSection() {
  const { store } = useEditor();
  const doc = store.prefabDoc!;
  const [name, setName] = useState("");
  const variants = store.variantsOf(doc.name);
  const def = store.prefabDocDef();
  const depth = variantDepth(store.project, doc.name);
  const allowed = canInherit(store.project, doc.name);

  return (
    <>
      {doc.base && (
        <>
          <div className="section-title">What {doc.name} claims for itself</div>
          {Object.entries(def?.diff ?? {}).length === 0 ? (
            <div className="hint">
              Nothing yet — {doc.name} is {doc.base} exactly. Change a field on the stage and it
              becomes the one thing this variant says.
            </div>
          ) : (
            Object.entries(def?.diff ?? {}).map(([path, value]) => (
              <div key={path} className="override-row">
                <code>{path}</code>
                <span>{JSON.stringify(value)}</span>
                <span className="muted">
                  base {JSON.stringify(getPath(resolvePrefab(store.project, doc.base!)?.root, path))}
                </span>
                <button
                  className="mini"
                  title="Drop this claim so the base's value flows through again"
                  onClick={() => store.clearVariantDiff(doc.name, path)}
                >
                  ⟲
                </button>
              </div>
            ))
          )}
          <div className="hint">
            Everything not listed is inherited. Fixing the walk animation on {doc.base} fixes it
            here too.
          </div>
        </>
      )}

      <div className="section-title">Variants of {doc.name}</div>
      {variants.length === 0 && <div className="hint">No variants yet.</div>}
      {variants.map((variant) => (
        <div key={variant.name} className="variant-row">
          <span className="glyph">◈</span>
          <span className="name">{variant.name}</span>
          <span className="meta">
            {Object.keys(variant.diff ?? {}).length} field(s) differ
            {variant.base !== doc.name ? ` · via ${variant.base}` : ""}
          </span>
          <button className="mini" onClick={() => store.openPrefab(variant.name)}>
            edit
          </button>
        </div>
      ))}

      <div className="section-title">New variant</div>
      {allowed ? (
        <div className="row">
          <input
            value={name}
            placeholder={`${doc.name}_Big`}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="ghost"
            disabled={!name.trim()}
            onClick={() => {
              if (store.createVariant(doc.name, name.trim())) setName("");
            }}
          >
            Create
          </button>
        </div>
      ) : (
        <div className="banner warn">
          {doc.name} is already {depth} level(s) deep. A variant of a variant is allowed; a variant
          of that is not — past two levels nobody can say what a value came from.
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ instance

/**
 * PLACE — what a level may say about one copy. Only exposed fields are
 * editable here; everything else is edited in the prefab document.
 */
function InstanceView() {
  const { store, openDialog } = useEditor();
  const selection = store.selection;

  if (!selection.length) {
    return (
      <div className="stack">
        <div className="empty">
          Select an object, then promote it. A prefab starts as something already on screen.
        </div>
        <div className="section-title">Prefabs in this project</div>
        {store.project.prefabs.length === 0 && <div className="hint">None yet.</div>}
        {store.project.prefabs.map((prefab) => (
          <div key={prefab.name} className="variant-row">
            <span className="glyph">{prefab.base ? "◈" : "◆"}</span>
            <span className="name">{prefab.name}</span>
            <span className="meta">
              {prefab.base ? `variant of ${prefab.base}` : `${prefab.exposed.length} exposed`}
            </span>
            <button className="mini" onClick={() => store.openPrefab(prefab.name)}>
              edit
            </button>
          </div>
        ))}
      </div>
    );
  }

  const obj = selection[0];
  const prefab = resolvePrefab(store.project, obj.prefab);

  if (obj.prefab && !prefab) {
    return (
      <div className="stack">
        <div className="banner error">
          The definition for <code>{obj.prefab}</code> is missing. This instance keeps its position
          and its overrides — nothing has been thrown away — and draws as a placeholder until the
          file comes back.
        </div>
        <div className="section-title">Overrides held for it</div>
        {Object.entries(obj.overrides ?? {}).map(([path, value]) => (
          <div key={path} className="override-row">
            <code>{path}</code>
            <span>{JSON.stringify(value)}</span>
          </div>
        ))}
        <button className="ghost" onClick={() => store.unpackInstance(obj.id)}>
          Unpack into a plain object
        </button>
      </div>
    );
  }

  if (!prefab) {
    return (
      <div className="stack">
        <div className="empty">
          {selection.length} plain object(s) selected. Promoting one writes a definition and
          rewrites the object in place as its first instance.
        </div>
        <button className="primary" onClick={() => openDialog("prefab")}>
          Create prefab from selection…
        </button>
      </div>
    );
  }

  const overrides = Object.entries(obj.overrides ?? {});
  const usage = prefabUsage(store.project, prefab.chain[0]);
  const total = usage.reduce((n, u) => n + u.count, 0);

  return (
    <div className="stack">
      <div className="kicker">INSTANCE</div>
      <h3 className="panel-title">{obj.name}</h3>
      <div className="kv">
        <span>Definition</span>
        <code>{prefabFilePath(prefab.name)}</code>
      </div>
      {prefab.chain.length > 1 && (
        <div className="kv">
          <span>Inherits</span>
          <code>{prefab.chain.join(" → ")}</code>
        </div>
      )}
      <div className="kv">
        <span>Family</span>
        <code>
          {total} instance(s) across {usage.length} scene(s)
        </code>
      </div>

      <button className="ghost" onClick={() => store.openPrefab(prefab.name)}>
        ◆ Edit prefab definition…
      </button>
      <div className="hint">
        Editing the definition opens it alone on an empty stage. Every instance in the project is
        downstream of it — the save panel says exactly which, before anything is written.
      </div>

      <div className="section-title">
        Exposed fields
        <span className="count">{prefab.exposed.length}</span>
      </div>
      <div className="chips">
        {prefab.exposed.length === 0 && (
          <span className="empty">
            Nothing is overridable. Everything about this object comes from {prefab.name}.
          </span>
        )}
        {prefab.exposed.map((path) => (
          <span key={path} className={`chip ${isOverridden(obj, path) ? "on" : ""}`}>
            {path}
          </span>
        ))}
      </div>

      <div className="section-title">Overrides on {obj.name}</div>
      {overrides.length === 0 && (
        <div className="hint">
          Every field is linked to the definition. Editing an exposed field here records an
          override; untouched fields keep updating with the prefab.
        </div>
      )}
      {overrides.map(([path, value]) => (
        <div key={path} className="override-row">
          <code>{path}</code>
          <span>{JSON.stringify(value)}</span>
          <span className="muted">was {JSON.stringify(getPath(prefab.root, path))}</span>
          <button
            className="mini"
            title="Revert to the definition's value"
            onClick={() => store.revertOverride(obj.id, path)}
          >
            ⟲
          </button>
        </div>
      ))}

      <div className="row">
        <button className="ghost" onClick={() => store.applyInstanceToPrefab(obj.id)}>
          Apply to {prefab.base ? "variant" : "prefab"}
        </button>
        <button className="ghost" onClick={() => store.unpackInstance(obj.id)}>
          Unpack instance
        </button>
      </div>
      <div className="hint">
        Applying pushes this instance's overrides into the definition; every other instance picks
        them up except where it overrides the same field.
      </div>
    </div>
  );
}
