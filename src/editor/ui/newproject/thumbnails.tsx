import type { TemplateId } from "../../store/templates";

/**
 * Wireframe thumbnails for the template picker, drawn as positioned boxes the
 * way the flow spec draws them: filled boxes are terrain and platforms, hollow
 * ones are the controllable object.
 */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  fill: boolean;
}

const SHAPES: Record<TemplateId, Box[]> = {
  empty: [{ left: 6, top: 8, width: 88, height: 84, fill: false }],
  platformer: [
    { left: 4, top: 74, width: 92, height: 18, fill: true },
    { left: 52, top: 52, width: 28, height: 8, fill: true },
    { left: 14, top: 56, width: 6, height: 18, fill: false },
  ],
  topdown: [
    { left: 6, top: 10, width: 88, height: 80, fill: false },
    { left: 46, top: 44, width: 8, height: 12, fill: false },
    { left: 6, top: 44, width: 26, height: 8, fill: true },
  ],
  runner: [
    { left: 0, top: 74, width: 100, height: 18, fill: true },
    { left: 10, top: 52, width: 18, height: 8, fill: true },
    { left: 56, top: 40, width: 18, height: 8, fill: true },
    { left: 16, top: 54, width: 6, height: 18, fill: false },
  ],
};

export function TemplateThumb({ id }: { id: TemplateId }) {
  return (
    <div className="tpl-thumb">
      {SHAPES[id].map((box, i) => (
        <span
          key={i}
          className={box.fill ? "tpl-box fill" : "tpl-box"}
          style={{
            left: `${box.left}%`,
            top: `${box.top}%`,
            width: `${box.width}%`,
            height: `${box.height}%`,
          }}
        />
      ))}
    </div>
  );
}
