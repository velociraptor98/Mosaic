import { useState } from "react";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

/**
 * Stopping restores the pre-play snapshot exactly, and offers to promote any
 * runtime tweaks worth keeping. Promotion is one undoable transaction.
 */
export function PromoteDialog({ onClose }: { onClose: () => void }) {
  const { playtest } = useEditor();
  const pending = playtest.pending;
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(pending.map((p) => `${p.id}:${p.path}`)),
  );

  const toggle = (key: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Dialog
      title="Keep runtime edits?"
      subtitle="The scene has been restored from its pre-play snapshot. These edits were made while it ran."
      onClose={onClose}
      footer={
        <>
          <button
            className="ghost"
            onClick={() => {
              playtest.discard();
              onClose();
            }}
          >
            Discard all
          </button>
          <button
            className="primary"
            onClick={() => {
              playtest.promote(pending.filter((p) => chosen.has(`${p.id}:${p.path}`)));
              onClose();
            }}
          >
            Promote {chosen.size} edit(s)
          </button>
        </>
      }
    >
      {pending.map((edit) => {
        const key = `${edit.id}:${edit.path}`;
        return (
          <label key={key} className="promote-row">
            <input type="checkbox" checked={chosen.has(key)} onChange={() => toggle(key)} />
            <strong>{edit.name}</strong>
            <code>{edit.path}</code>
            <span className="muted">{JSON.stringify(edit.previous)}</span>
            <span>→ {JSON.stringify(edit.value)}</span>
          </label>
        );
      })}
    </Dialog>
  );
}
