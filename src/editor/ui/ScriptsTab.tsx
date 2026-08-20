import { useState } from "react";
import { isExposed, isOverridden, resolvePrefab } from "../../shared/prefabs";
import {
  SCRIPT_LIST_PATH,
  convertValue,
  fitsType,
  scriptEnabledPath,
  scriptPropPath,
  scriptsOf,
} from "../../shared/scripts";
import type {
  ProjectData,
  ResolvedPrefab,
  SceneObject,
  ScriptRef,
} from "../../shared/types";
import { platform } from "../platform";
import type { ScriptProperty } from "../scripts/parse";
import type { ScriptResolution } from "../scripts/registry";
import { CheckField, NumberField, SelectField, TextField } from "./fields";
import { isTrusted, trustRoot } from "../scripts/runtime";
import { useEditor, useScriptRuntime, useScripts, useStoreVersion } from "./context";

/**
 * Workflow — reading the code behind an object.
 *
 * Selection answers "what runs on this?" before it answers "where is it": the
 * list is execution order, the fields are the ones the class marked
 * `@property`, and every value shown lives in the scene file while every field
 * shown lives in the class. Editing source happens in the user's own editor —
 * this panel is a reader with an "Open in…" button, not a code editor.
 */
export function ScriptsTab() {
  const { store, workspace, openDialog } = useEditor();
  useStoreVersion(store);
  useScripts(workspace.scripts);

  const selection = store.selection;
  if (!selection.length) {
    return (
      <div className="empty">
        Select an object to see the behaviour attached to it. Scripts are classes in your own
        source tree; Mosaic reads their <code>@property</code> declarations and stores the values
        you set here in the scene file.
      </div>
    );
  }

  if (!platform.canOpenProjects) {
    return (
      <div className="empty">
        Script components need a project folder to read classes from. The browser build has no
        folder — open the desktop app to attach behaviour.
      </div>
    );
  }

  const obj = selection[0];
  const scripts = store.scriptsFor(obj);
  const registry = workspace.scripts;
  const prefab = resolvePrefab(store.project, obj.prefab);
  const ownsList = !!obj.overrides && SCRIPT_LIST_PATH in obj.overrides;
  const inherited = !!prefab && !ownsList;

  // Two of the same class are legal and numbered, so the rows stay tellable
  // apart without reading the path.
  const ordinals = new Map<string, number>();
  const rows = scripts.map((ref, index) => {
    const seen = (ordinals.get(ref.class) ?? 0) + 1;
    ordinals.set(ref.class, seen);
    return { ref, index, ordinal: seen, resolution: registry.resolve(ref) };
  });
  const duplicates = new Set(
    [...ordinals.entries()].filter(([, n]) => n > 1).map(([name]) => name),
  );

  return (
    <div className="stack scripts-panel">
      <div className="section-title">
        Scripts <span className="count">{scripts.length}</span>
        <button className="mini add" onClick={() => openDialog("attachscript")}>
          + Add
        </button>
      </div>

      {selection.length > 1 && (
        <div className="hint">
          {selection.length} objects selected — the list below is {obj.name}'s. Adding attaches to
          all of them.
        </div>
      )}

      {registry.loading && <div className="hint">Indexing src/…</div>}

      {scripts.length === 0 && (
        <div className="empty">
          No scripts on {obj.name}. An object with no behaviour shows this section, not a hidden
          one — nothing about it is implied by absence.
        </div>
      )}

      {rows.map((row) => (
        <ScriptRow
          key={`${row.ref.class}-${row.index}`}
          obj={obj}
          row={row}
          duplicate={duplicates.has(row.ref.class)}
          inherited={inherited}
          prefab={prefab}
        />
      ))}

      <RuntimeBanner />

      {scripts.length > 0 && (
        <div className="hint">
          Rows run top to bottom — <strong>update() is called in list order</strong>, and the order
          is written back to the scene file. The checkbox is enabled state, not deletion: a
          disabled script keeps its values and is still constructed at runtime.
        </div>
      )}
    </div>
  );
}

/**
 * What the compiled half is doing right now: whether this project is trusted to
 * run its own code, whether it compiled, and what is running.
 */
function RuntimeBanner() {
  const { store, workspace, playtest } = useEditor();
  const runtime = workspace.scriptRuntime;
  useScriptRuntime(runtime);
  const root = workspace.location?.root;
  const trusted = isTrusted(root);

  if (!root) return null;

  if (!trusted) {
    return (
      <div className="banner warn">
        Play-test will run the scene without behaviour: this project has not been trusted to
        compile and run its own code.
        <button
          className="mini"
          onClick={() => {
            trustRoot(root);
            store.setStatus(`Scripts enabled for ${workspace.location?.name ?? root}`);
            runtime.reset();
          }}
        >
          Enable for this project
        </button>
      </div>
    );
  }

  if (runtime.status === "error") {
    return (
      <div className="banner error">
        <strong>Scripts did not compile.</strong>
        <pre className="compile-error">{runtime.error}</pre>
      </div>
    );
  }

  if (playtest.playing && runtime.status === "ready") {
    return (
      <div className="banner volatile">
        Running {Object.keys(runtime.classes).length} class(es) from your source. Editing a script
        recompiles it and restarts the scene on the new code.
      </div>
    );
  }

  if (runtime.status === "building") return <div className="hint">Compiling scripts…</div>;
  return null;
}

interface Row {
  ref: ScriptRef;
  index: number;
  ordinal: number;
  resolution: ScriptResolution;
}

function ScriptRow({
  obj,
  row,
  duplicate,
  inherited,
  prefab,
}: {
  obj: SceneObject;
  row: Row;
  duplicate: boolean;
  inherited: boolean;
  prefab: ResolvedPrefab | undefined;
}) {
  const { store, workspace, openDialog } = useEditor();
  const [open, setOpen] = useState(false);
  const registry = workspace.scripts;
  const { ref, index, resolution } = row;
  const cls = resolution.cls;
  const properties = cls ? registry.properties(cls) : [];
  const parseError = cls ? registry.errorFor(cls.src) : undefined;

  const enabledOverridden = isOverridden(obj, scriptEnabledPath(index));
  const overriddenCount = properties.filter(
    (p) => overrideState(obj, index, p.name, prefab ? store.project : null).marked,
  ).length;

  const note = !ref.enabled
    ? "skipped at runtime"
    : overriddenCount
      ? `${overriddenCount} value(s) differ from prefab`
      : inherited
        ? "values from the prefab"
        : Object.keys(ref.props).length
          ? "values from this scene"
          : "values from code defaults";

  // A script the object depends on is worth flagging when it is switched off:
  // the class that names it will still run and will not find it.
  const dependents = ref.enabled
    ? []
    : store
        .scriptsFor(obj)
        .filter((other, i) => {
          if (i === index || !other.enabled) return false;
          const source = registry.sourceOf(other.src);
          return !!source && new RegExp(`\\b${ref.class}\\b`).test(source);
        })
        .map((other) => other.class);

  return (
    <div
      className={`script-row ${ref.enabled ? "" : "disabled"} ${resolution.status === "missing" ? "missing" : ""}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/mosaic-script", String(index))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/mosaic-script"));
        if (Number.isInteger(from) && from !== index) store.moveScript(obj.id, from, index - from);
      }}
    >
      <div className="script-head" onClick={() => setOpen((o) => !o)}>
        <input
          type="checkbox"
          checked={ref.enabled}
          title={ref.enabled ? "Disable (keeps its values)" : "Enable"}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => store.setScriptEnabled(obj.id, index, e.target.checked)}
        />
        <span className="cls">
          {ref.class}
          {duplicate && <span className="ordinal"> #{row.ordinal}</span>}
          {enabledOverridden && <span className="marker" title="enabled state overrides the prefab" />}
        </span>
        <span className="path" title={ref.src}>
          {ref.src}
        </span>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <button
          className="mini"
          title="Move earlier in the run order"
          onClick={(e) => {
            e.stopPropagation();
            store.moveScript(obj.id, index, -1);
          }}
        >
          ↑
        </button>
        <button
          className="mini"
          title="Move later in the run order"
          onClick={(e) => {
            e.stopPropagation();
            store.moveScript(obj.id, index, 1);
          }}
        >
          ↓
        </button>
        <button
          className="mini danger"
          title="Detach this script"
          onClick={(e) => {
            e.stopPropagation();
            store.detachScript(obj.id, index);
          }}
        >
          ×
        </button>
      </div>

      <div className="script-note">{note}</div>

      {resolution.status === "missing" && (
        <div className="banner error">
          <strong>{ref.class}</strong> does not resolve. The class may have been renamed or
          deleted — the reference is kept in the scene file either way.
          <button
            className="mini"
            onClick={() => {
              store.setUi({ scriptRelink: { objectId: obj.id, index } });
              openDialog("attachscript");
            }}
          >
            Relink…
          </button>
        </div>
      )}

      {resolution.status === "moved" && cls && (
        <div className="banner warn">
          Found <code>{cls.name}</code> in {cls.src} instead.
          <button className="mini" onClick={() => store.relinkScript(obj.id, index, cls)}>
            Relink to it
          </button>
        </div>
      )}

      {parseError && (
        <div className="banner warn">
          {cls?.src} did not parse cleanly ({parseError}) — the fields below are the last good
          reading of it.
        </div>
      )}

      {dependents.length > 0 && (
        <div className="banner warn">
          {dependents.join(", ")} names {ref.class} in its source, and {ref.class} is disabled.
        </div>
      )}

      {open && (
        <div className="script-body">
          {cls && properties.length === 0 && (
            <div className="hint">
              {cls.name} declares no <code>@property</code> fields — everything on it is private to
              your code.
            </div>
          )}
          {properties.map((property) => (
            <PropertyField
              key={property.name}
              obj={obj}
              index={index}
              script={ref}
              property={property}
              prefab={prefab}
            />
          ))}

          <StaleValues obj={obj} index={index} refValue={ref} properties={properties} />

          <div className="row">
            {cls && (
              <button
                className="ghost"
                onClick={() =>
                  store.setUi({ sourceView: { src: cls.src, className: cls.name } })
                }
              >
                View source
              </button>
            )}
            {cls && (
              <button className="ghost" onClick={() => void registry.openExternal(cls.src, cls.line)}>
                Open in editor ↗
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Where a value came from. `marked` is the filled dot the design uses for an
 * override; `upstream` tints it when the prefab has authored its own value
 * under the instance's, so shadowing a deliberate change is visible.
 */
function overrideState(
  obj: SceneObject,
  index: number,
  name: string,
  project: ProjectData | null,
): { marked: boolean; upstream: unknown } {
  if (!project) return { marked: false, upstream: undefined };
  const prefab = resolvePrefab(project, obj.prefab);
  if (!prefab) return { marked: false, upstream: undefined };
  const upstream = scriptsOf(prefab.root)[index]?.props?.[name];
  if (isOverridden(obj, scriptPropPath(index, name))) return { marked: true, upstream };
  // The instance may own the whole list (it reordered, added or removed one);
  // then a value counts as overridden when it differs from the definition's.
  const owned = obj.overrides?.[SCRIPT_LIST_PATH] as ScriptRef[] | undefined;
  if (!owned) return { marked: false, upstream: undefined };
  const mine = owned[index]?.props?.[name];
  return { marked: JSON.stringify(mine) !== JSON.stringify(upstream), upstream };
}

function PropertyField({
  obj,
  index,
  script,
  property,
  prefab,
}: {
  obj: SceneObject;
  index: number;
  script: ScriptRef;
  property: ScriptProperty;
  prefab: ResolvedPrefab | undefined;
}) {
  const { store } = useEditor();
  const label = property.label ?? property.name;
  const set = (value: unknown) => store.setScriptProp(obj.id, index, property.name, value);
  const has = Object.prototype.hasOwnProperty.call(script.props, property.name);
  const value = has ? script.props[property.name] : property.default;

  const state = overrideState(obj, index, property.name, prefab ? store.project : null);
  /**
   * A script value on an instance is editable only if the prefab published it.
   * The field is shown locked rather than hidden, so it is clear that the
   * value exists and where it is owned.
   */
  const locked =
    prefab && !isExposed(prefab, scriptPropPath(index, property.name))
      ? `Owned by ${prefab.name} — expose ${script.class}.${property.name} in prefab edit mode to set it per instance.`
      : undefined;
  const revert = () => {
    if (isOverridden(obj, scriptPropPath(index, property.name))) {
      store.revertOverride(obj.id, scriptPropPath(index, property.name));
    } else {
      store.clearScriptProp(obj.id, index, property.name);
    }
  };

  if (property.codeOnly) {
    return (
      <div className="field readonly">
        <span className="field-label">{label}</span>
        <code className="muted">
          {property.type === "function" ? "callback" : "object"} · code only
        </code>
      </div>
    );
  }

  // A value the scene holds that no longer fits the declared type is offered a
  // conversion rather than being coerced silently or thrown away.
  if (has && !fitsType(property.type, value)) {
    const converted = convertValue(property.type, value);
    return (
      <div className="banner warn field-conflict">
        <code>{property.name}</code> holds {JSON.stringify(value)}, but the class now declares it{" "}
        <strong>{property.type}</strong>.
        {converted !== null && (
          <button className="mini" onClick={() => set(converted)}>
            Convert to {JSON.stringify(converted)}
          </button>
        )}
        <button className="mini" onClick={() => store.clearScriptProp(obj.id, index, property.name)}>
          Use the default
        </button>
      </div>
    );
  }

  const common = {
    label,
    // On a plain object a value set in the scene is still "not the default",
    // and the same revert affordance takes it back to the class's value.
    marked: state.marked || (has && !prefab),
    onRevert: revert,
    locked,
  };

  switch (property.type) {
    case "number":
      return (
        <NumberField
          {...common}
          value={typeof value === "number" ? value : 0}
          step={property.step ?? 1}
          onCommit={(v) => set(clamp(v, property))}
        />
      );
    case "boolean":
      return (
        <CheckField {...common} value={value === true} onCommit={(v) => set(v)} />
      );
    case "enum":
      return (
        <SelectField
          {...common}
          value={typeof value === "string" ? value : ""}
          options={(property.options ?? []).map((o) => ({ value: o, label: o }))}
          onCommit={(v) => set(v)}
        />
      );
    default:
      return (
        <TextField
          label={label}
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={property.type === "ref" ? "name of the object / layer" : undefined}
          onCommit={(v) => set(v)}
        />
      );
  }
}

function clamp(value: number, property: ScriptProperty): number {
  let out = value;
  if (typeof property.min === "number") out = Math.max(property.min, out);
  if (typeof property.max === "number") out = Math.min(property.max, out);
  return out;
}

/**
 * Values the class no longer declares. They are kept and flagged rather than
 * deleted: a field commented out for an afternoon should not cost the tuning
 * that went into it.
 */
function StaleValues({
  obj,
  index,
  refValue,
  properties,
}: {
  obj: SceneObject;
  index: number;
  refValue: ScriptRef;
  properties: ScriptProperty[];
}) {
  const { store } = useEditor();
  const declared = new Set(properties.map((p) => p.name));
  const stale = Object.entries(refValue.props ?? {}).filter(([name]) => !declared.has(name));
  if (!stale.length) return null;

  return (
    <>
      <div className="section-title">No longer declared</div>
      {stale.map(([name, value]) => (
        <div key={name} className="override-row stale">
          <code>{name}</code>
          <span>{JSON.stringify(value)}</span>
          <button
            className="mini"
            title="Drop this value from the scene file"
            onClick={() => store.clearScriptProp(obj.id, index, name)}
          >
            ×
          </button>
        </div>
      ))}
      <div className="hint">
        Kept in the scene file, not written to the class. Restore the field and the value comes
        back with it.
      </div>
    </>
  );
}
