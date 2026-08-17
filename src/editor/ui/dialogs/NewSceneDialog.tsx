import { useState } from "react";
import { SCENE_TEMPLATES, type TemplateId } from "../../store/templates";
import { uniqueKey } from "../../store/ids";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

/**
 * Templates write a real scene file with the camera, tilemap layer and player
 * already wired, so a new level starts from a runnable state.
 */
export function NewSceneDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const [name, setName] = useState("Level 02");
  const [template, setTemplate] = useState<TemplateId>("platformer");

  const key = uniqueKey(name, store.project.scenes.map((s) => s.key));
  const collision = store.project.scenes.some((s) => s.key === name.replace(/[^\w]+/g, "_"));

  return (
    <Dialog
      title="New scene"
      subtitle="Writes src/scenes/<key>.scene.json and registers it in the manifest."
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => {
              store.createScene(name, template);
              onClose();
            }}
          >
            Create scene
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <p className="hint">
        File: <code>src/scenes/{key}.scene.json</code>
        {collision && " — key collision resolved before write"}
      </p>

      <div className="template-grid">
        {SCENE_TEMPLATES.map((t) => (
          <button
            key={t.id}
            className={`template ${template === t.id ? "active" : ""}`}
            onClick={() => setTemplate(t.id)}
          >
            <strong>{t.label}</strong>
            <span>{t.blurb}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
