import { nativeImage, type NativeImage } from "electron";
import { mosaicIconBitmap } from "../src/shared/logoBitmap";
import { encodePng } from "./png";

/**
 * The app icon: the Mosaic mark, drawn at run time from the same geometry the
 * UI draws.
 *
 * Nothing is checked in as a bitmap, so the icon cannot drift from the mark;
 * and because the rasteriser is pure, the headless suite can assert the icon's
 * pixels without booting Electron. The PNG round trip is here rather than a
 * raw bitmap handoff because `createFromBitmap` takes a platform-dependent
 * channel order, while a PNG decodes the same everywhere.
 */

export function mosaicIcon(size = 512): NativeImage {
  return nativeImage.createFromBuffer(encodePng(mosaicIconBitmap(size)));
}
