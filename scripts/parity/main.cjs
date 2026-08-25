const { app, BrowserWindow } = require("electron");
const path = require("node:path");

/**
 * Loads the parity page, waits for both scenes to have booted, and prints the
 * differences between them.
 *
 * Real Chromium rather than a mocked canvas: Phaser's arcade bodies, tilemap
 * layers and text metrics all behave differently against a stub, and a parity
 * check run against stubs would prove nothing about the shipped build.
 */

const page = process.argv[2];
if (!page) {
  console.error("usage: electron scripts/parity/main.cjs <page.html>");
  process.exit(1);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 640 });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event && event.level === "error") errors.push(event.message);
  });

  try {
    await win.loadFile(path.resolve(page));

    const result = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
          if (window.__parity) return resolve(window.__parity);
          if (Date.now() - started > 12000) {
            return resolve({ timeout: true, got: Object.keys(window.__parity || {}) });
          }
          setTimeout(poll, 100);
        };
        poll();
      })
    `);

    if (result.timeout) {
      console.log("one or both scenes never finished booting");
      app.exit(1);
      return;
    }

    const objects = Object.keys(result.loader.objects).length;
    console.log(`loader built ${objects} named objects · gravity ${result.loader.gravityY}`);
    console.log(
      `generated built ${Object.keys(result.generated.objects).length} named objects · gravity ${result.generated.gravityY}`,
    );

    // A scene that built nothing is not parity, it is two failures agreeing.
    if (objects === 0) {
      console.log("the loader built no named objects — nothing was compared");
      app.exit(1);
      return;
    }

    // An animation that registers but never advances is still broken, so the
    // run reports what is actually playing.
    const playing = Object.entries(result.generated.objects)
      .filter(([, o]) => o.anim)
      .map(([n, o]) => `${n}:${o.anim}${o.animPlaying ? "" : " (stopped)"} f${o.frame}`);
    if (playing.length) console.log(`animating · ${playing.join(" · ")}`);

    if (result.differences.length === 0) {
      if (errors.length) console.log(`(${errors.length} console error(s) during boot)`);
      console.log("PARITY OK");
      app.exit(0);
      return;
    }

    console.log(`${result.differences.length} difference(s) between the two paths:`);
    for (const line of result.differences) console.log(`  · ${line}`);
    app.exit(1);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
