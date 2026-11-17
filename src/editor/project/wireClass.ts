import type { AddCall, ClassShape, SourceSite } from "../../../electron/contract";
import type { SceneData, SceneObject } from "../../shared/types";

/**
 * Wiring a layout into a scene class the user wrote, when they said Mosaic may.
 *
 * Adding the two calls is the easy half. The import made the layout from what
 * the class's own create() builds, so a class that only gained
 * `createMainMenu(this)` would build every object twice — a still cactus
 * behind the dancing one. So each object the layout builds has to stop being
 * built by the class, and the class's references to it — `let sign = …`, a
 * tween's target, a `.setFlipX(true)` chained on — have to keep working.
 *
 * Both follow from replacing one expression. `this.add.image(512, -400,
 * 'logo')` becomes `layout.logo`: whatever was done with the result is done
 * with the layout's object instead, and the line's own effect, making it, is
 * the layout's now. That is only sound where one line makes one object, once:
 * straight in create(), not in a loop, a callback, a helper or preload(). An
 * object made any other way stays the code's — and leaves the layout, so the
 * scene still has exactly one of it.
 */

export interface Takeover {
  /** Object id → the call the layout's object replaces. */
  taken: Map<string, AddCall>;
  /** Objects the code keeps making, and why. */
  left: { id: string; name: string; why: string }[];
}

/** Which of a scene's imported objects can come from the layout instead of the class. */
export function planTakeover(
  shape: ClassShape,
  scene: SceneData,
  sites: Record<string, SourceSite[]>,
): Takeover {
  const taken = new Map<string, AddCall>();
  const left: Takeover["left"] = [];
  const parents = new Set(scene.objects.map((o) => o.parentId).filter(Boolean));
  const byCall = new Map<AddCall, SceneObject[]>();

  const leave = (o: SceneObject, why: string) => left.push({ id: o.id, name: o.name, why });

  for (const o of scene.objects) {
    if (o.prefab) {
      leave(o, `a ${o.prefab}, which your code constructs`);
      continue;
    }
    if (o.parentId || parents.has(o.id)) {
      leave(o, "inside a container");
      continue;
    }
    // A snapshot has no font, size or colour, so a layout's text would lose
    // the style the code gives it.
    if (o.type === "text" || o.text) {
      leave(o, "text, whose style only your code has");
      continue;
    }
    const site = sites[o.id]?.[0];
    if (!site) {
      leave(o, "where it was made was not recorded");
      continue;
    }
    if (site.src !== shape.rel) {
      leave(o, `made in ${site.src}:${site.line}`);
      continue;
    }
    const offset = offsetOf(shape.source, site.line, site.col);
    const onLine = shape.calls.filter((c) => c.line === site.line);
    const call =
      shape.calls.find((c) => c.start <= offset && offset < c.end) ?? (onLine.length === 1 ? onLine[0] : null);
    if (!call) {
      const within = (m: ClassShape["create"]) => !!m && offset >= m.bodyStart && offset <= m.bodyEnd;
      leave(
        o,
        within(shape.preload)
          ? `made in preload(), line ${site.line}`
          : within(shape.create)
            ? `made inside a loop, condition or callback in create(), line ${site.line}`
            : `made outside create(), line ${site.line}`,
      );
      continue;
    }
    const group = byCall.get(call) ?? [];
    group.push(o);
    byCall.set(call, group);
  }

  for (const [call, objects] of byCall) {
    if (objects.length === 1) {
      taken.set(objects[0].id, call);
    } else {
      for (const o of objects) leave(o, `one of ${objects.length} made by line ${call.line}`);
    }
  }
  return { taken, left };
}

/**
 * A name the class will read well as `layout.<name>`: what the code already
 * called it, else its art. Only replaces a name the importer invented.
 */
export function nameFromCode(o: SceneObject, call: AddCall): string | null {
  // The importer's own: a class name, then `_frame` or ` 2` to tell copies apart.
  const invented = /^(Image|Sprite|TileSprite|NineSlice|Rectangle|Arc|Graphics)([_ ]|$)/.test(o.name);
  if (!invented) return null;
  if (call.binding) return call.binding;
  return o.frame && !/^\d+$/.test(o.frame) ? o.frame : (o.texture ?? null);
}

export interface ClassEdit {
  cls: string;
  preloadCall: string;
  createCall: string;
  importLine: string;
  /** Each taken-over call, and the layout field that replaces it. */
  uses: { call: AddCall; field: string }[];
}

/** The class with its layout wired in, or why it cannot be. */
export function rewriteClass(shape: ClassShape, edit: ClassEdit): { source: string } | { reason: string } {
  if (!shape.ok) return { reason: shape.reason ?? "could not be read" };
  if (!shape.module) return { reason: "is not an ES module, so it cannot import its layout" };
  if (shape.create?.async && edit.uses.length) {
    return { reason: "has an async create(), which this does not edit" };
  }
  const src = shape.source;
  const edits: { start: number; end: number; text: string }[] = [];

  const anchor = shape.create ?? shape.preload;
  const methodIndent = anchor ? indentAt(src, anchor.keyStart) : guessMemberIndent(src, shape);
  const unit = methodIndent.includes("\t") ? "\t" : methodIndent || "    ";
  const bodyIndent = (m: ClassShape["create"]) =>
    m?.firstStatement != null ? indentAt(src, m.firstStatement) : methodIndent + unit;

  const used = new Set(shape.names);
  const layoutVar = ["layout", "mosaicLayout", "editorLayout"].find((n) => !used.has(n)) ?? "layout_";

  // ---- the objects the layout makes now
  for (const { call, field } of edit.uses) {
    if (call.statement) {
      edits.push({ ...wholeLine(src, call.statement.start, call.statement.end), text: "" });
    } else {
      edits.push({ start: call.start, end: call.end, text: `${layoutVar}.${field}` });
    }
  }

  // ---- create()
  const createLine = edit.uses.length ? `const ${layoutVar} = ${edit.createCall};` : `${edit.createCall};`;
  if (shape.create) {
    edits.push(intoBody(src, shape.create, bodyIndent(shape.create), methodIndent, createLine, true));
  }

  // ---- preload()
  const preloadLine = `${edit.preloadCall};`;
  if (shape.preload) {
    edits.push(intoBody(src, shape.preload, bodyIndent(shape.preload), methodIndent, preloadLine, false));
  } else if (shape.create) {
    // Written in the same style as the create() beside it, and just above it.
    const header = src.slice(shape.create.keyStart, shape.create.bodyStart - 1);
    const gap = /^create(\s*)\(/.exec(header)?.[1] ?? " ";
    const afterParams = header.slice(closingParen(header) + 1);
    const at = lineStart(src, shape.create.start);
    edits.push({
      start: at,
      end: at,
      text: `${methodIndent}preload${gap}()${afterParams}{\n${bodyIndent(shape.create)}${preloadLine}\n${methodIndent}}\n\n`,
    });
  }

  // ---- neither: both, at the end of the class
  if (!shape.create && !shape.preload) {
    const inner = methodIndent + unit;
    edits.push({
      start: shape.classBodyEnd,
      end: shape.classBodyEnd,
      text: `\n${methodIndent}preload () {\n${inner}${preloadLine}\n${methodIndent}}\n\n${methodIndent}create () {\n${inner}${createLine}\n${methodIndent}}\n`,
    });
  } else if (!shape.create) {
    const inner = methodIndent + unit;
    edits.push({
      start: shape.classBodyEnd,
      end: shape.classBodyEnd,
      text: `\n${methodIndent}create () {\n${inner}${createLine}\n${methodIndent}}\n`,
    });
  }

  // ---- the import
  if (shape.importEnd !== null) {
    edits.push({ start: shape.importEnd, end: shape.importEnd, text: `\n${edit.importLine}` });
  } else {
    edits.push({ start: 0, end: 0, text: `${edit.importLine}\n\n` });
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  let floor = Infinity;
  for (const e of edits) {
    // Overlapping edits would mean the shape was misread; refuse rather than mangle.
    if (e.end > floor) return { reason: "could not be edited cleanly" };
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return { source: out };
}

/** The first line of a method's body, keeping the rest of it where it was. */
function intoBody(
  src: string,
  m: NonNullable<ClassShape["create"]>,
  indent: string,
  methodIndent: string,
  line: string,
  spaced: boolean,
): { start: number; end: number; text: string } {
  // An empty body — not one holding only comments — has its whitespace
  // replaced, so the closing brace lands on its own line.
  if (m.firstStatement == null && !src.slice(m.bodyStart, m.bodyEnd).trim()) {
    return { start: m.bodyStart, end: m.bodyEnd, text: `\n${indent}${line}\n${methodIndent}` };
  }
  return { start: m.bodyStart, end: m.bodyStart, text: `\n${indent}${line}${spaced ? "\n" : ""}` };
}

/**
 * A statement's whole line when nothing else is on it, else just the
 * statement. A blank line that only separated it from what came before goes
 * with it, so removing the first line of a block leaves no gap behind.
 */
function wholeLine(src: string, start: number, end: number): { start: number; end: number } {
  const from = lineStart(src, start);
  let to = src.indexOf("\n", end);
  if (to < 0) to = src.length;
  if (!/^[ \t]*$/.test(src.slice(from, start)) || !/^[ \t]*$/.test(src.slice(end, to))) return { start, end };
  let cut = Math.min(src.length, to + 1);
  const previous = from > 0 ? src.slice(lineStart(src, from - 1), from - 1) : "";
  const nextEnd = src.indexOf("\n", cut);
  if (nextEnd >= 0 && /^[ \t]*$/.test(src.slice(cut, nextEnd)) && (/^[ \t]*$/.test(previous) || /\{[ \t]*$/.test(previous))) {
    cut = nextEnd + 1;
  }
  return { start: from, end: cut };
}

function lineStart(src: string, offset: number): number {
  return src.lastIndexOf("\n", offset - 1) + 1;
}

function indentAt(src: string, offset: number): string {
  const from = lineStart(src, offset);
  return /^[ \t]*/.exec(src.slice(from))![0];
}

function guessMemberIndent(src: string, shape: ClassShape): string {
  const inside = src.slice(shape.classBodyStart, shape.classBodyEnd);
  const m = /\n([ \t]+)\S/.exec(inside);
  return m ? m[1] : "    ";
}

function closingParen(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Offset of a 1-based line and 0-based column. */
export function offsetOf(src: string, line: number, col: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = src.indexOf("\n", offset);
    if (next < 0) return src.length;
    offset = next + 1;
  }
  return offset + col;
}
