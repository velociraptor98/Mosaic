import { useMemo, useState } from "react";
import { objectSize } from "../../../shared/size";
import { Dialog } from "./Dialog";
import { useEditor, useStoreVersion } from "../context";

/**
 * Fill grid — the wall, the row of pickups, the floor.
 *
 * A level is data, not a loop, so this does not add a "repeat" to the scene
 * format: it still writes one object per cell, and every one stays selectable
 * and movable afterwards. What it removes is the sixty clicks.
 *
 * Spacing defaults to the selection's own size, because the overwhelmingly
 * common grid is things laid edge to edge.
 */
export function GridDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  useStoreVersion(store);

  const selection = store.selection;
  const bounds = useMemo(() => {
    if (!selection.length) return { width: store.project.config.tile, height: store.project.config.tile };
    // The whole selection's footprint, so a grid of a pair spaces by the pair.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const obj of selection) {
      const size = objectSize(store.project, obj);
      minX = Math.min(minX, obj.x - size.width / 2);
      minY = Math.min(minY, obj.y - size.height / 2);
      maxX = Math.max(maxX, obj.x + size.width / 2);
      maxY = Math.max(maxY, obj.y + size.height / 2);
    }
    return { width: Math.round(maxX - minX), height: Math.round(maxY - minY) };
  }, [selection, store]);

  const [cols, setCols] = useState(10);
  const [rows, setRows] = useState(6);
  const [dx, setDx] = useState(bounds.width);
  const [dy, setDy] = useState(bounds.height);

  const perCell = selection.length;
  const total = Math.max(1, cols) * Math.max(1, rows) * perCell;
  const added = total - perCell;

  const fill = () => {
    store.fillGrid(
      selection.map((o) => o.id),
      { cols, rows, dx, dy },
    );
    onClose();
  };

  const num = (value: number, set: (n: number) => void, min: number) => (
    <input
      type="number"
      value={value}
      min={min}
      onChange={(e) => set(Number(e.target.value))}
      onFocus={(e) => e.target.select()}
    />
  );

  return (
    <Dialog
      title="Fill grid"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!perCell || added <= 0} onClick={fill}>
            {added > 0 ? `Add ${added}` : "Nothing to add"}
          </button>
        </>
      }
    >
      <div className="stack">
        {!perCell ? (
          <p className="muted">Nothing selected.</p>
        ) : (
          <>
            <div className="kv">
              <span>Stamping</span>
              <code>
                {perCell === 1 ? selection[0].name : `${perCell} objects`}
                {selection[0].prefab ? ` · ${selection[0].prefab}` : ""}
              </code>
            </div>

            <div className="grid2">
              <label className="field">
                <span>Columns</span>
                {num(cols, setCols, 1)}
              </label>
              <label className="field">
                <span>Rows</span>
                {num(rows, setRows, 1)}
              </label>
              <label className="field">
                <span>Step X</span>
                {num(dx, setDx, -9999)}
              </label>
              <label className="field">
                <span>Step Y</span>
                {num(dy, setDy, -9999)}
              </label>
            </div>

            <div className="section-title">Result</div>
            <div className="kv">
              <span>Objects</span>
              <code>
                {total} total · {added} added
              </code>
            </div>
            <div className="kv">
              <span>Covers</span>
              <code>
                {Math.abs(dx) * (cols - 1) + bounds.width} × {Math.abs(dy) * (rows - 1) + bounds.height} px
              </code>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
