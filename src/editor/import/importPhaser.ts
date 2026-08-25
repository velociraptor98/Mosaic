import { platform } from "../platform";
import { isTrusted } from "../scripts/runtime";
import {
  sceneFromRecording,
  type ImportResult,
  type KnownClass,
  type Recording,
} from "./fromRecording";
import type { ProjectData } from "../../shared/types";

export { applyImport } from "./fromRecording";

/**
 * Writes the art an import captured into the project, and points the project's
 * assets at it.
 *
 * This is the one part of an import that touches the user's folder, and it only
 * happens because they pressed Import. Without it the scene has every object in
 * the right place and nothing to draw with — which is what the first version
 * did, and it looked like a broken import rather than a deliberate one.
 */
export async function writeImportedArt(
  root: string,
  imported: ImportResult,
  project: ProjectData,
): Promise<string[]> {
  if (!imported.files.length) return [];
  const outcome = await platform.writeFiles(
    root,
    imported.files.map((f) => ({ rel: f.rel, contents: f.base64, encoding: "base64" as const })),
  );

  // Only what actually landed gets a URL; a failed write must not leave an
  // asset pointing at a file that is not there.
  const written = new Set(outcome.written);
  for (const asset of project.assets) {
    if (!asset.path.startsWith("assets/imported/")) continue;
    if (written.has(asset.path)) asset.url = platform.assetUrl(root, asset.path);
  }

  const notes = [`Wrote ${outcome.written.length} art file(s) into assets/imported/.`];
  if (outcome.failed.length) {
    notes.push(`${outcome.failed.length} could not be written: ${outcome.failed[0].error}`);
  }
  return notes;
}

/**
 * Importing a hand-written Phaser project.
 *
 * The recording happens in the main process, the mapping happens in
 * `fromRecording`, and this is the seam between them: it decides which scene of
 * a multi-scene game is the one worth importing, and merges the result into a
 * project without trampling what is already there.
 */

export interface ImportCandidate {
  /** Phaser scene key. */
  key: string;
  /** Objects that survived the filter — what the user would actually get. */
  objects: number;
  anims: number;
  /** Set when the scene's own `create()` threw partway through. */
  createError: string | null;
}

export interface ImportSurvey {
  entry: string;
  candidates: ImportCandidate[];
  /** Recordings by scene key, kept so a choice does not mean re-running. */
  recordings: Record<string, Recording>;
  /** The project's own classes, so a scene switch re-maps without re-running. */
  known: KnownClass[];
}

/** Files that construct a game. The user picks one; most projects have one. */
export function findEntries(root: string): Promise<string[]> {
  return platform.findGameEntries(root);
}

/**
 * Runs one entry and reports what each of its scenes would import as.
 *
 * Refuses without trust. Recording means executing the project's own code, and
 * "the user opened this folder" is not consent for that — it is the same bar
 * the play-test holds, asked in the same place.
 */
export async function surveyProject(
  root: string,
  entry: string,
  scripts: { index: { classes: KnownClass[] } },
): Promise<ImportSurvey> {
  if (!isTrusted(root)) {
    throw new Error("This project has not been trusted to run its own code yet.");
  }
  const result = await platform.recordScene(root, entry);
  if (!result.ok || !result.scenes) {
    throw new Error(result.error ?? "The project could not be recorded.");
  }

  // The snapshot knows a constructor's NAME; only the source knows its
  // signature and where it lives, and constructing one needs both.
  const known: KnownClass[] = scripts.index.classes.map((c) => ({
    name: c.name,
    src: c.src,
    isDefault: c.isDefault,
    ctorParams: c.ctorParams,
  }));

  const recordings: Record<string, Recording> = {};
  const candidates: ImportCandidate[] = [];
  for (const [key, raw] of Object.entries(result.scenes)) {
    const rec = raw as Recording;
    if (!rec || !Array.isArray(rec.objects)) continue;
    recordings[key] = rec;
    const mapped = sceneFromRecording(rec, known);
    candidates.push({
      key,
      objects: mapped.scene.objects.length,
      anims: mapped.anims.length,
      createError: rec.objects.length ? ((rec as { createError?: string }).createError ?? null) : null,
    });
  }

  // Biggest first: a four-scene game is Boot, Preloader, a menu and the thing
  // the user actually wants, and the last of those is the only one with a
  // scene in it. Sorting by size puts it at the top without guessing at names.
  candidates.sort((a, b) => b.objects - a.objects);
  return { entry, candidates, recordings, known };
}

/** What an import would add, without adding it. */
export function previewScene(survey: ImportSurvey, sceneKey: string): ImportResult {
  const rec = survey.recordings[sceneKey];
  if (!rec) throw new Error(`No recording for scene "${sceneKey}"`);
  return sceneFromRecording(rec, survey.known);
}
