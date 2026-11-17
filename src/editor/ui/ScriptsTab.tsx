import { findPrefab, resolvePrefab } from "../../shared/prefabs";
import type { SceneObject } from "../../shared/types";
import { className, isGeneratedPath, prefabClassPath } from "../export/generate";
import { platform } from "../platform";
import type { ScriptProperty } from "../scripts/parse";
import { CheckField, NumberField, SelectField, TextField } from "./fields";
import { useEditor, useScripts, useStoreVersion } from "./context";

/**
 * Workflow — reading the code behind an object.
 *
 * A prefab is backed by a class in your own source tree. This tab lists the
 * fields that class marks \`@editable\`, and every value shown lives in the
 * scene file while every field shown lives in the class. Editing source
 * happens in your own editor: this panel is a reader with an "Open" button,
 * not a code editor.
 */
export function ScriptsTab() {
  const { store, workspace } = useEditor();
  useStoreVersion(store);
  useScripts(workspace.scripts);

  const selection = store.selection;
  if (!selection.length) {
    return (
      <div className="empty">
        Select an object to see its class. Mosaic reads the fields a class marks{" "}
        <code>@editable</code> and stores the values you set here in the scene file.
      </div>
    );
  }

  if (!platform.canOpenProjects) {
    return (
      <div className="empty">
        Class fields are read from a project folder. The browser build has no folder — open the
        desktop app to see them.
      </div>
    );
  }

  const obj = selection[0];
  if (!obj.prefab && !store.prefabDoc) {
    return (
      <div className="empty">
        {obj.name} is a plain sprite, with no class of its own. Make it a prefab to give it one:
        behaviour then goes in that class, the way it would on any Phaser sprite subclass.
      </div>
    );
  }

  return (
    <div className="stack scripts-panel">
      {selection.length > 1 && (
        <div className="hint">
          {selection.length} objects selected — showing {obj.name}'s class.
        </div>
      )}
      {workspace.scripts.loading && <div className="hint">Indexing src/…</div>}
      <ClassProps obj={obj} />
    </div>
  );
}

/**
 * The object's own class, and the fields it publishes.
 *
 * A prefab is backed by a class in the project — an ordinary Phaser sprite
 * subclass. Anything that class marks `@editable` is listed here, and a value
 * set here is assigned to the field after the constructor runs. Nothing is
 * attached to anything: the class simply has fields, and this gives them
 * values.
 *
 * On a root prefab's own definition the fields are read-only. That class IS
 * the definition, so its defaults are the initialisers in code, and that is
 * what `new` gives. Setting a different default here would make placed
 * instances disagree with every one made in code. A variant's definition stays
 * editable: its values become field initialisers on the variant's class.
 */
function ClassProps({ obj }: { obj: SceneObject }) {
  const { store, workspace } = useEditor();
  const registry = workspace.scripts;
  const doc = store.prefabDoc;
  // In prefab edit mode the root IS the definition, so what is set here is the
  // default every instance starts from.
  const editingDefinition = !!doc && doc.rootId === obj.id;
  const name = editingDefinition ? doc.name : obj.prefab;
  const prefab = resolvePrefab(store.project, name);
  if (!name || !prefab) return null;
  const codeOwnsDefaults = editingDefinition && !findPrefab(store.project, name)?.base;

  const where = prefab.source
    ? {
        src: prefab.source.module,
        cls: prefab.source.export === "default" ? prefab.name : prefab.source.export,
      }
    : { src: prefabClassPath(prefab.name, workspace.language, store.project.config.paths), cls: className(prefab.name) };
  const cls =
    registry.index.byKey.get(`${where.src}::${where.cls}`) ??
    registry.index.classes.find((c) => c.name === where.cls && !isGeneratedPath(c.src));
  const properties = cls ? registry.properties(cls) : [];
  const defaults = (editingDefinition ? {} : prefab.root.props) ?? {};
  const own = obj.props ?? {};
  const declared = new Set(properties.map((p) => p.name));
  const stale = Object.keys(own).filter((key) => !declared.has(key));

  return (
    <>
      <div className="section-title">
        {where.cls} <span className="count">class</span>
        {cls && (
          <button className="mini add" onClick={() => void registry.openExternal(cls.src, cls.line)}>
            Open ↗
          </button>
        )}
      </div>
      {!cls && (
        <div className="hint">
          <code>{where.src}</code> is not on disk yet — it is written the next time the project
          saves, and from then on it is yours.
        </div>
      )}
      {cls && properties.length === 0 && (
        <div className="hint">
          Add <code>@editable</code> to a field's doc comment in <code>{cls.src}</code> and it
          appears here, for every {prefab.name} you place.
        </div>
      )}
      {codeOwnsDefaults && properties.length > 0 && (
        <div className="hint">
          These defaults are the field values in <code>{cls?.src ?? where.src}</code>, which is
          what <code>new {where.cls}(…)</code> gives. Change them there, set them on a placed
          instance, or make a variant to tune them here.
        </div>
      )}
      {codeOwnsDefaults &&
        properties
          .filter((p) => Object.prototype.hasOwnProperty.call(own, p.name))
          .map((p) => (
            <div key={`legacy-${p.name}`} className="override-row stale">
              <code>{p.name}</code>
              <span>
                {JSON.stringify(own[p.name])} set here before. Placed instances still get it, but{" "}
                <code>new</code> gives {JSON.stringify(p.default)}. Move it into code.
              </span>
              <button
                className="mini"
                title="Drop the value set here, so placed instances use the default in code."
                onClick={() => store.clearClassProp(obj.id, p.name)}
              >
                ×
              </button>
            </div>
          ))}
      {properties.map((property) => {
        const has = Object.prototype.hasOwnProperty.call(own, property.name);
        const value = has
          ? own[property.name]
          : property.name in defaults
            ? defaults[property.name]
            : property.default;
        const label = property.label ?? property.name;
        const set = (next: unknown) => store.setClassProp(obj.id, property.name, next);
        const common = {
          label,
          marked: has,
          onRevert: () => store.clearClassProp(obj.id, property.name),
        };
        if (codeOwnsDefaults) {
          const shown = !property.codeOnly
            ? JSON.stringify(property.default)
            : property.type === "function"
              ? "callback"
              : "object";
          return (
            <div className="field readonly" key={property.name} title={property.hint}>
              <span className="field-label">{label}</span>
              <code className="muted">{shown} · from code</code>
            </div>
          );
        }
        if (property.codeOnly) {
          return (
            <div className="field readonly" key={property.name}>
              <span className="field-label">{label}</span>
              <code className="muted">
                {property.type === "function" ? "callback" : "object"} · code only
              </code>
            </div>
          );
        }
        switch (property.type) {
          case "number":
            return (
              <NumberField
                key={property.name}
                {...common}
                value={typeof value === "number" ? value : 0}
                step={property.step ?? 1}
                onCommit={(v) => set(clamp(v, property))}
              />
            );
          case "boolean":
            return <CheckField key={property.name} {...common} value={value === true} onCommit={set} />;
          case "enum":
            return (
              <SelectField
                key={property.name}
                {...common}
                value={typeof value === "string" ? value : ""}
                options={(property.options ?? []).map((o) => ({ value: o, label: o }))}
                onCommit={set}
              />
            );
          default:
            return (
              <TextField
                key={property.name}
                label={label}
                value={value === undefined || value === null ? "" : String(value)}
                onCommit={set}
              />
            );
        }
      })}
      {stale.map((key) => (
        <div key={key} className="override-row stale">
          <code>{key}</code>
          <span>{JSON.stringify(own[key])}</span>
          <button
            className="mini"
            title="The class no longer declares this field. Drop the value."
            onClick={() => store.clearClassProp(obj.id, key)}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}

function clamp(value: number, property: ScriptProperty): number {
  let out = value;
  if (typeof property.min === "number") out = Math.max(property.min, out);
  if (typeof property.max === "number") out = Math.min(property.max, out);
  return out;
}
