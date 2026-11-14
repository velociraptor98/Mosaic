import { BrowserWindow, app, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerIpc } from "./ipc";
import { registerAssetProtocol, registerAssetScheme } from "./assets";
import { mosaicIcon } from "./appIcon";

/**
 * Mosaic's main process.
 *
 * The renderer is the same React + Phaser app the browser build serves; it
 * never gets Node. Everything that touches the disk goes through the narrow,
 * typed IPC surface in ipc.ts, exposed on `window.mosaic` by preload.cjs.
 */

const DEV_URL = process.env.MOSAIC_DEV_SERVER;

// The app is the mark, not Electron's default: drawn once at boot from the
// same geometry the UI's <MosaicMark> draws.
const APP_ICON = mosaicIcon(512);

// Privileged scheme registration has to happen before the app is ready.
registerAssetScheme();
const dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1560,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#14171a",
    title: "Mosaic",
    // Windows and Linux take the icon from the window; macOS takes it from the
    // dock, set below.
    icon: APP_ICON,
    // The design calls for our own title bar (mark + wordmark), so the native
    // one is hidden. That floats the traffic lights over the page, so the
    // renderer reserves room for them and declares its own drag regions.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Centred against the 44px menu bar: (44 - 16) / 2.
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium throttles requestAnimationFrame to nothing in a window it
      // considers hidden, which stops the play-test's game loop dead — the
      // scene stays active, sprites keep their bodies, and not one frame runs.
      // An editor whose canvas freezes when its window is occluded is wrong on
      // its own terms, and it also made every headless assertion about a
      // running game depend on whether the window happened to be visible.
      backgroundThrottling: false,
    },
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(dirname, "../dist/index.html"));
  }

  // External links open in the user's browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

app.whenReady().then(() => {
  app.dock?.setIcon(APP_ICON);
  registerAssetProtocol();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
