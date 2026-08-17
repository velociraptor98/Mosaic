import { useState } from "react";
import type { CollisionRule } from "../../../shared/types";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

const NEXT: Record<CollisionRule, CollisionRule> = {
  ignore: "collide",
  collide: "overlap",
  overlap: "ignore",
};

const GLYPH: Record<CollisionRule, string> = { ignore: "·", collide: "■", overlap: "◇" };

/**
 * Pair rules are authored once per project instead of scattered through
 * create(). Overlap pairs generate handler stubs on export.
 */
export function CollisionDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const [newGroup, setNewGroup] = useState("");
  const groups = store.project.groups;

  const rule = (a: string, b: string): CollisionRule =>
    (store.project.collision[a]?.[b] as CollisionRule) ?? "ignore";

  return (
    <Dialog
      title="Collision matrix"
      subtitle="Click a cell to cycle ignore → collide → overlap. The matrix is symmetric."
      onClose={onClose}
      wide
      footer={
        <button className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <table className="matrix">
        <thead>
          <tr>
            <th />
            {groups.map((g) => (
              <th key={g}>{g}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((a) => (
            <tr key={a}>
              <th>{a}</th>
              {groups.map((b) => {
                const r = rule(a, b);
                return (
                  <td key={b}>
                    <button
                      className={`cell ${r}`}
                      title={`${a} × ${b}: ${r}`}
                      onClick={() => store.setCollisionRule(a, b, NEXT[r])}
                    >
                      {GLYPH[r]}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="legend">
        <span>
          <b>■</b> collide — addCollider
        </span>
        <span>
          <b>◇</b> overlap — addOverlap + a handler stub on export
        </span>
        <span>
          <b>·</b> ignore
        </span>
      </div>

      <div className="row">
        <input
          value={newGroup}
          placeholder="new group name"
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            store.addGroup(newGroup);
            setNewGroup("");
          }}
        />
        <button
          className="ghost"
          onClick={() => {
            store.addGroup(newGroup);
            setNewGroup("");
          }}
        >
          Add group
        </button>
      </div>
    </Dialog>
  );
}
