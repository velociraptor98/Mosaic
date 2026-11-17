/**
 * Reads a bundle's source map back to the line that wrote something.
 *
 * Small on purpose: the recorder only asks "which file, which line" of a
 * handful of stack frames, so this decodes the mappings once and answers by
 * search, without pulling a source-map library into the app.
 */

export interface RawSourceMap {
  sources: string[];
  mappings: string;
}

/** One decoded segment: generated column → original source, line, column (all 0-based). */
type Segment = [number, number, number, number];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = new Map([...B64].map((c, i) => [c, i]));

export class SourceMapReader {
  private lines: Segment[][];
  readonly sources: string[];

  constructor(map: RawSourceMap) {
    this.sources = map.sources;
    this.lines = decode(map.mappings);
  }

  /**
   * The original position of a generated one. `line` is 1-based and
   * `column` 0-based, as a stack trace's column minus one is.
   */
  lookup(line: number, column: number): { source: string; line: number; column: number } | null {
    const segments = this.lines[line - 1];
    if (!segments?.length) return null;
    // The last segment starting at or before the column covers it.
    let lo = 0;
    let hi = segments.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid][0] <= column) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best < 0) best = 0;
    const [, src, origLine, origCol] = segments[best];
    const source = this.sources[src];
    if (source === undefined) return null;
    return { source, line: origLine + 1, column: origCol };
  }
}

function decode(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let src = 0;
  let origLine = 0;
  let origCol = 0;
  for (const line of mappings.split(";")) {
    const out: Segment[] = [];
    let genCol = 0;
    if (line) {
      for (const seg of line.split(",")) {
        if (!seg) continue;
        const v = vlq(seg);
        genCol += v[0];
        // A one-field segment maps to nothing in particular.
        if (v.length < 4) continue;
        src += v[1];
        origLine += v[2];
        origCol += v[3];
        out.push([genCol, src, origLine, origCol]);
      }
    }
    lines.push(out);
  }
  return lines;
}

function vlq(text: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of text) {
    const digit = VALUE.get(c);
    if (digit === undefined) break;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return out;
}
