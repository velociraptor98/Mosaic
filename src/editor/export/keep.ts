/**
 * Hand-written code lives between keep markers. The generator re-emits the
 * file every time; anything a developer wrote inside a marked region is
 * carried across, and anything they wrote OUTSIDE one is a signal that the
 * file must not be clobbered.
 *
 * Markers are only recognised on a line of their own. That matters: prose in
 * a header comment can mention the marker syntax without accidentally opening
 * a region that swallows the rest of the file.
 */

/** `  // <keep id="create">` on its own line. */
const OPEN = /^[ \t]*\/\/[ \t]*<keep[ \t]+id="([^"]+)">[ \t]*$/gm;
/** open line + body + close line, for whole-region rewrites. */
const REGION = /^([ \t]*\/\/[ \t]*<keep[ \t]+id="([^"]+)">[ \t]*\n)([\s\S]*?)^([ \t]*\/\/[ \t]*<\/keep>[ \t]*)$/gm;

export function extractKeepRegions(source: string): Map<string, string> {
  const out = new Map<string, string>();
  REGION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REGION.exec(source))) out.set(match[2], match[3]);
  return out;
}

/** Re-inject previously kept bodies into freshly generated source. */
export function mergeKeepRegions(generated: string, previous: string | null): string {
  if (!previous) return generated;
  const kept = extractKeepRegions(previous);
  if (!kept.size) return generated;
  return generated.replace(REGION, (whole, open: string, id: string, _body: string, close: string) => {
    const body = kept.get(id);
    return body === undefined ? whole : `${open}${body}${close}`;
  });
}

/** Replace every region body with a marker, so only generated code compares. */
function stripRegions(source: string): string {
  return source.replace(REGION, (_whole, open: string, _id: string, _body: string, close: string) =>
    `${open}${close}`,
  );
}

/**
 * True when the file on disk has edits the generator would destroy: content
 * that differs from what we last generated and is not inside a keep region.
 */
export function hasUnmarkedEdits(onDisk: string, lastGenerated: string | null): boolean {
  if (!lastGenerated) return false;
  return stripRegions(onDisk).trim() !== stripRegions(lastGenerated).trim();
}

/** True when the source declares at least one well-formed keep region. */
export function hasKeepRegions(source: string): boolean {
  OPEN.lastIndex = 0;
  return OPEN.test(source);
}
