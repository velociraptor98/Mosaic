import type { RowKind } from "../../../shared/propagate";
import { prefabFilePath } from "../../store/project";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

const KIND_NOTE: Record<RowKind, string> = {
  moved: "the definition's new value reaches these instances",
  added: "new in the definition, so these instances gain it",
  removed: "gone from the definition, so these instances lose it",
  kept: "this instance overrode the field, so its own value stands",
  dropped: "the field is no longer exposed, so the override cannot survive",
  skipped: "this scene is not written — its instances keep the old definition",
};

/**
 * PROPAGATE — show what a definition change costs before it happens.
 *
 * Saving a prefab is the one edit that reaches into files the author is not
 * looking at, so it is the one edit that lists its consequences first: which
 * scenes, which instances, which values move. Overrides an instance set for
 * itself are never overwritten silently. Nothing is written until Push.
 */
export function PropagateDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const plan = store.ui.prefabPlan;
  if (!plan) return null;

  const close = () => {
    store.cancelPrefabPlan();
    onClose();
  };

  if (plan.unchanged) {
    return (
      <Dialog
        title={`Save ${plan.prefab}`}
        subtitle="Nothing to push."
        onClose={close}
        footer={
          <button className="primary" onClick={close}>
            Close
          </button>
        }
      >
        <div className="empty">
          The definition resolves to exactly what is already on disk — no scene would change.
        </div>
      </Dialog>
    );
  }

  const t = plan.totals;

  return (
    <Dialog
      wide
      title={`Push ${plan.prefab} to its instances`}
      subtitle={`${prefabFilePath(plan.prefab)} — ${t.instances} instance(s) across ${plan.scenes.length} scene(s).`}
      onClose={close}
      footer={
        <>
          <span className="dialog-foot-note">
            nothing is written until Push · Review each walks the scenes one at a time
          </span>
          <button className="ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="ghost"
            disabled={!t.scenes}
            onClick={() => {
              store.pushPrefabSave();
              store.startReview(plan);
              onClose();
            }}
          >
            Push + review each
          </button>
          <button
            className="primary"
            onClick={() => {
              store.pushPrefabSave();
              onClose();
            }}
          >
            Push
          </button>
        </>
      }
    >
      <div className="propagate-totals">
        <Total n={t.moved} label="values move" kind="moved" />
        <Total n={t.kept} label="overrides kept" kind="kept" />
        <Total n={t.dropped} label="overrides dropped" kind="dropped" />
        <Total n={t.scenes} label="scenes touched" kind="skipped" />
      </div>

      {plan.variants.length > 0 && (
        <div className="banner">
          {plan.variants.length} variant(s) resolve from this definition and move with it:{" "}
          <code>{plan.variants.join(", ")}</code>. Each keeps whatever it states for itself.
        </div>
      )}

      <div className="section-title">Consequences</div>
      <div className="propagate-rows">
        {plan.rows.map((row, i) => (
          <div key={i} className={`propagate-row ${row.kind}`} title={KIND_NOTE[row.kind]}>
            <span className="kind">{row.kind.toUpperCase()}</span>
            <span className="what">{row.what}</span>
            <span className="where">{row.where}</span>
          </div>
        ))}
        {!plan.rows.length && (
          <div className="empty">
            The definition changed, but no scene holds an instance of it yet — nothing to push.
          </div>
        )}
      </div>

      <div className="section-title">By scene</div>
      <div className="propagate-scenes">
        {plan.scenes.map((scene) => (
          <div key={scene.key} className={`propagate-scene ${scene.skipped ? "skipped" : ""}`}>
            <code>{scene.key}.scene.json</code>
            <span className="meta">{scene.instances} instance(s)</span>
            {scene.skipped ? (
              <span className="tag-outline warn">skipped — {scene.skipped}</span>
            ) : (
              <span className="meta">
                {scene.moved} moved · {scene.kept} kept · {scene.dropped} dropped
              </span>
            )}
          </div>
        ))}
      </div>

      {plan.scenes.some((s) => s.skipped) && (
        <p className="hint">
          A skipped scene is left exactly as it is, overrides and all. Reload the project to pick
          up what changed on disk, then push again.
        </p>
      )}
    </Dialog>
  );
}

function Total({ n, label, kind }: { n: number; label: string; kind: RowKind }) {
  return (
    <div className={`propagate-total ${kind} ${n === 0 ? "zero" : ""}`}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  );
}
