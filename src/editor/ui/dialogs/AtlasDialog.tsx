import { useEffect, useMemo, useState } from "react";
import { autoDetectFrames, imageDataOf, nameFrames, sliceGrid } from "../../assets/slice";
import { uid } from "../../store/ids";
import type { AssetDef, AssetFrame } from "../../../shared/types";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

/**
 * Grid slicing with margin and spacing, or auto-detect by transparency. The
 * overlay draws the real frame boundaries over the art before you commit.
 */
export function AtlasDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const candidates = store.project.assets.filter(
    (a) => a.kind !== "audio" && a.url && !a.generated,
  );
  const [assetId, setAssetId] = useState(candidates[0]?.id ?? "");
  const asset = store.project.assets.find((a) => a.id === assetId);

  const [mode, setMode] = useState<"grid" | "auto">("grid");
  const [fw, setFw] = useState(32);
  const [fh, setFh] = useState(32);
  const [margin, setMargin] = useState(0);
  const [spacing, setSpacing] = useState(0);
  const [alpha, setAlpha] = useState(8);
  const [pattern, setPattern] = useState("frame_{i}");
  const [pad, setPad] = useState(0);
  const [pivotX, setPivotX] = useState(0.5);
  const [pivotY, setPivotY] = useState(0.5);
  const [autoBoxes, setAutoBoxes] = useState<Omit<AssetFrame, "name">[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (mode !== "auto" || !asset?.url) return;
    let cancelled = false;
    void imageDataOf(asset.url).then((data) => {
      if (cancelled || !data) return;
      setAutoBoxes(autoDetectFrames(data, alpha));
    });
    return () => {
      cancelled = true;
    };
  }, [mode, asset?.url, alpha]);

  const frames: AssetFrame[] = useMemo(() => {
    if (!asset) return [];
    const boxes =
      mode === "grid"
        ? sliceGrid(asset.width, asset.height, { frameWidth: fw, frameHeight: fh, margin, spacing })
        : autoBoxes;
    return nameFrames(boxes, pattern, 0, pad).map((f) => ({ ...f, pivotX, pivotY }));
  }, [asset, mode, fw, fh, margin, spacing, autoBoxes, pattern, pad, pivotX, pivotY]);

  const commit = () => {
    if (!asset) return;
    const existing = store.project.assets.find(
      (a) => a.kind === "atlas" && a.path === asset.path.replace(/\.\w+$/, ".atlas.png"),
    );
    if (existing) {
      store.updateAsset(existing.id, { frames }, "Re-slice atlas");
      onClose();
      return;
    }
    const atlas: AssetDef = {
      id: uid("asset"),
      key: `${asset.key}_atlas`,
      kind: "atlas",
      path: asset.path.replace(/\.\w+$/, ".atlas.png"),
      url: asset.url,
      width: asset.width,
      height: asset.height,
      frames,
    };
    store.importAssets([atlas]);
    store.setStatus(`Wrote ${atlas.key}.atlas.json — ${frames.length} frames, Phaser JSON-hash shape`);
    onClose();
  };

  const scale = asset && asset.width > 520 ? 520 / asset.width : 1;

  return (
    <Dialog
      title="Atlas slicer"
      subtitle="Frame boundaries are drawn over the real art before anything is written."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!frames.length} onClick={commit}>
            Create atlas ({frames.length} frames)
          </button>
        </>
      }
    >
      <div className="atlas-layout">
        <div className="atlas-canvas">
          {asset ? (
            <div
              className="atlas-image"
              style={{
                backgroundImage: `url(${asset.url})`,
                width: asset.width * scale,
                height: asset.height * scale,
                backgroundSize: `${asset.width * scale}px ${asset.height * scale}px`,
              }}
            >
              {frames.map((f, i) => (
                <span
                  key={i}
                  className={`frame-box ${selected === i ? "active" : ""}`}
                  onClick={() => setSelected(i)}
                  style={{
                    left: f.x * scale,
                    top: f.y * scale,
                    width: f.w * scale,
                    height: f.h * scale,
                  }}
                >
                  <i style={{ left: `${f.pivotX * 100}%`, top: `${f.pivotY * 100}%` }} />
                </span>
              ))}
            </div>
          ) : (
            <div className="empty">Import a sheet first — there is nothing to slice.</div>
          )}
        </div>

        <div className="atlas-side">
          <label className="field">
            <span className="field-label">Source</span>
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.key} ({a.width}×{a.height})
                </option>
              ))}
            </select>
          </label>

          <div className="segmented">
            <button className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")}>
              Grid
            </button>
            <button className={mode === "auto" ? "active" : ""} onClick={() => setMode("auto")}>
              Auto-detect
            </button>
          </div>

          {mode === "grid" ? (
            <div className="grid2">
              <label className="field">
                <span className="field-label">Frame W</span>
                <input type="number" value={fw} onChange={(e) => setFw(Number(e.target.value))} />
              </label>
              <label className="field">
                <span className="field-label">Frame H</span>
                <input type="number" value={fh} onChange={(e) => setFh(Number(e.target.value))} />
              </label>
              <label className="field">
                <span className="field-label">Margin</span>
                <input type="number" value={margin} onChange={(e) => setMargin(Number(e.target.value))} />
              </label>
              <label className="field">
                <span className="field-label">Spacing</span>
                <input type="number" value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
              </label>
            </div>
          ) : (
            <label className="field">
              <span className="field-label">Alpha threshold</span>
              <input
                type="range"
                min={1}
                max={128}
                value={alpha}
                onChange={(e) => setAlpha(Number(e.target.value))}
              />
              <span className="meta">{alpha} — {autoBoxes.length} islands found</span>
            </label>
          )}

          <div className="section-title">Names</div>
          <label className="field">
            <span className="field-label">Pattern ({"{i}"} is the index)</span>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Zero pad</span>
            <input type="number" min={0} max={4} value={pad} onChange={(e) => setPad(Number(e.target.value))} />
          </label>

          <div className="section-title">Pivot (per sheet)</div>
          <div className="grid2">
            <label className="field">
              <span className="field-label">Pivot X</span>
              <input type="number" step={0.05} value={pivotX} onChange={(e) => setPivotX(Number(e.target.value))} />
            </label>
            <label className="field">
              <span className="field-label">Pivot Y</span>
              <input type="number" step={0.05} value={pivotY} onChange={(e) => setPivotY(Number(e.target.value))} />
            </label>
          </div>
          <p className="hint">
            The place tool and the body editor both read the pivot, so placement and collision
            agree from the start.
          </p>

          <div className="frame-names">
            {frames.slice(0, 60).map((f, i) => (
              <span key={i} className={`chip ${selected === i ? "on" : ""}`} onClick={() => setSelected(i)}>
                {f.name}
              </span>
            ))}
            {frames.length > 60 && <span className="meta">+{frames.length - 60} more</span>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
