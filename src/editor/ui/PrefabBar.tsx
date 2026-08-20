import { prefabFilePath } from "../store/project";
import { useEditor, useStoreVersion, useWorkspace } from "./context";

/**
 * The bar across the top of prefab edit mode.
 *
 * It is the whole reminder of context: you are editing the DEFINITION, and
 * every instance in the project is downstream of it. Nothing here is a tool —
 * the bar exists so that no one edits a definition thinking they are editing
 * one copy of it.
 */
export function PrefabBar() {
  const { store, workspace } = useEditor();
  useStoreVersion(store);
  useWorkspace(workspace);

  const doc = store.prefabDoc;
  if (!doc) return null;

  const dirty = store.isDirty(doc.scene.key);
  const variants = store.variantsOf(doc.name);
  const note = doc.base
    ? `inherits ${doc.base} · ${Object.keys(store.prefabDocDef()?.diff ?? {}).length} field(s) differ`
    : variants.length
      ? `${variants.length} variant(s) resolve from this base`
      : dirty
        ? "scene documents are unaffected until save"
        : "no unsaved changes";

  return (
    <div className="prefab-bar">
      <span className="glyph">◆</span>
      <strong>prefab edit mode</strong>
      <code>{prefabFilePath(doc.name)}</code>
      {doc.base && <span className="tag-outline">variant</span>}
      {dirty && <span className="tag-outline">modified</span>}

      <span className="prefab-bar-note">{note}</span>

      <button
        className="primary"
        onClick={() => store.planPrefabSave(workspace.writeBlockedReason)}
        title="Shows what the change costs before anything is written"
      >
        Save prefab…
      </button>
      <button
        className="ghost"
        onClick={() => {
          if (store.closePrefab()) return;
          // closePrefab refuses while there is unsaved work; saying so once is
          // enough, and the author can still discard on purpose.
        }}
      >
        Back to scene
      </button>
      {dirty && (
        <button
          className="danger ghost"
          onClick={() => store.closePrefab(true)}
          title="Leave without saving — the definition on disk is unchanged"
        >
          Discard
        </button>
      )}
    </div>
  );
}

/**
 * "Review each" in progress: the scenes a push touched, walked one at a time
 * with the affected instances already selected.
 */
export function ReviewBar() {
  const { store } = useEditor();
  useStoreVersion(store);
  const review = store.ui.review;
  if (!review) return null;

  return (
    <div className="prefab-bar review">
      <span className="glyph">▸</span>
      <strong>reviewing {review.prefab}</strong>
      <code>
        scene {review.index + 1} of {review.scenes.length} · {review.scenes[review.index]}
      </code>
      <span className="prefab-bar-note">
        the instances this push touched are selected — nothing else has been changed
      </span>
      <button className="ghost" onClick={() => store.showReviewStep(review.index - 1)} disabled={review.index === 0}>
        ← Previous
      </button>
      <button className="primary" onClick={() => store.showReviewStep(review.index + 1)}>
        {review.index + 1 === review.scenes.length ? "Done" : "Next scene →"}
      </button>
      <button className="ghost" onClick={() => store.endReview()}>
        Stop
      </button>
    </div>
  );
}
