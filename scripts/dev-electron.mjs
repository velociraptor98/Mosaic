/**
 * Dev launcher: builds the node bundles, starts the Vite dev server for the
 * renderer, then launches Electron pointed at it. Renderer changes hot-reload;
 * changes to electron/ need a restart.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const procs = [];
let shuttingDown = false;

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
  procs.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of procs) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// 1. Node bundles (main + preload).
const build = run(npx, ["vite", "build", "--config", "electron/vite.config.ts"]);
build.on("exit", (code) => {
  if (code !== 0) return shutdown(code ?? 1);
  const preload = run(npx, ["vite", "build", "--config", "electron/vite.preload.config.ts"]);
  preload.on("exit", (code2) => {
    if (code2 !== 0) return shutdown(code2 ?? 1);
    startRenderer();
  });
});

function startRenderer() {
  const vite = spawn(npx, ["vite", "--port", "5173", "--strictPort"], {
    stdio: ["inherit", "pipe", "inherit"],
  });
  procs.push(vite);

  let launched = false;
  vite.stdout.on("data", (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    if (launched) return;
    const match = text.match(/https?:\/\/localhost:\d+/);
    if (!match) return;
    launched = true;
    const electron = run(npx, ["electron", "."], {
      env: { ...process.env, MOSAIC_DEV_SERVER: match[0] },
    });
    electron.on("exit", (code) => shutdown(code ?? 0));
  });

  vite.on("exit", (code) => shutdown(code ?? 0));
}
