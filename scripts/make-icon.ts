import fs from "node:fs";
import path from "node:path";
import { encodePng } from "../electron/png";
import { mosaicIconBitmap } from "../src/shared/logoBitmap";

/**
 * Writes `build/icon.png` for the packager.
 *
 * The running app rasterises its icon at boot, but Finder, the installer and
 * the taskbar read it from the bundle — and electron-builder derives .icns and
 * .ico from a single square PNG. Same geometry, same colours, generated rather
 * than checked in, so the shipped icon cannot drift from the mark.
 */
const out = path.resolve("build/icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(mosaicIconBitmap(1024)));
console.log(`wrote ${path.relative(process.cwd(), out)} (1024x1024)`);
