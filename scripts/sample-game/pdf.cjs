const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");

/**
 * Turns the generated build guide into a PDF.
 *
 * Electron is already a dependency of this repo and it is Chromium, so it
 * prints the same page the browser would render — no second toolchain, and no
 * markdown-to-PDF pipeline whose output nobody has looked at.
 *
 *   electron scripts/sample-game/pdf.cjs <input.html> <output.pdf>
 */

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: electron scripts/sample-game/pdf.cjs <input.html> <output.pdf>");
  process.exit(1);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1240, height: 1754 });
  try {
    await win.loadFile(path.resolve(input));
    // Fonts and the inlined screenshots have to be laid out before the page is
    // measured, or the first print lands on a half-rendered document.
    await win.webContents.executeJavaScript(
      "document.fonts ? document.fonts.ready.then(() => true) : true",
    );
    await new Promise((r) => setTimeout(r, 600));

    const pdf = await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    await fs.writeFile(path.resolve(output), pdf);
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log(`Wrote ${output} — ${(pdf.length / 1024).toFixed(0)} KB, ${pages} pages`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
