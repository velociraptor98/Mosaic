import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { DevServerResult } from "./contract";
import { serveFolder, stopAllServing, stopServing } from "./staticServer";

/**
 * Runs the project's own dev server, so RUN shows the project's own game.
 *
 * Mosaic used to answer "what does this scene look like running" by building it
 * through a runtime of its own — a second implementation of the game, which
 * could only ever approximate the first. A Phaser developer already has the
 * real answer one command away: `npm run dev`. So this runs that, finds the
 * address it prints, and hands it to the renderer to show.
 *
 * Nothing here knows what a bundler is. Vite, webpack and Parcel all print the
 * URL they are serving on, and that line is the whole interface.
 *
 * One server per project, kept alive between runs: starting one costs seconds
 * and stopping the game should not throw that away. It dies with the project
 * (the renderer asks when a folder closes) or with the app.
 */

interface Running {
  child: ChildProcess;
  url: string | null;
  log: string;
  script: string;
  /** Resolves once the server has printed an address, or given up. */
  ready: Promise<DevServerResult>;
}

const servers = new Map<string, Running>();

const START_TIMEOUT_MS = 60_000;
const ADDRESS = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"]*/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** `dev` first, because that is what every Phaser template calls it. */
const SCRIPT_NAMES = ["dev", "start", "serve"];

export async function startDevServer(root: string): Promise<DevServerResult> {
  const existing = servers.get(root);
  if (existing && existing.child.exitCode === null) return existing.ready;

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    // No package.json is not a broken project: a folder of scripts that a
    // page loads is how Phaser's own examples are written. Serve it as it is.
    return serveFolder(root);
  }

  const script = SCRIPT_NAMES.find((name) => pkg.scripts?.[name]);
  if (!script) {
    // A package.json that only lists dependencies says nothing about how the
    // game is served; if the folder runs as it is, run it that way.
    const asIs = await serveFolder(root);
    if (asIs.ok) return asIs;
    return {
      ok: false,
      code: "no-script",
      error: `package.json has no "dev" script. Add one that starts your dev server, and RUN will use it.`,
      log: "",
    };
  }

  const installed = await fs
    .stat(path.join(root, "node_modules"))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!installed) {
    return {
      ok: false,
      code: "not-installed",
      error: "Dependencies are not installed yet — run npm install in this folder first.",
      log: "",
      script,
    };
  }

  const command = `npm run ${script}`;
  const env = {
    ...process.env,
    // A dev server that opens a browser tab is doing the editor's job twice.
    BROWSER: "none",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  let child: ChildProcess;
  try {
    child =
      process.platform === "win32"
        ? spawn(command, { cwd: root, env, shell: true })
        : // A login shell, so the PATH is the one the user's terminal has. An
          // app launched from the dock inherits almost none of it, and `npm`
          // installed through a version manager is simply not found.
          //
          // The `cat` is a dead-man's switch. It reads the stdin pipe this
          // process holds open, so it returns the moment Mosaic is gone — quit,
          // crashed or killed outright, none of which a signal handler can be
          // relied on to see — and `kill 0` then ends the whole group. Without
          // it the server outlives the editor and keeps its port.
          spawn(process.env.SHELL || "/bin/sh", ["-lc", `(${command}) & cat >/dev/null; kill 0`], {
            cwd: root,
            env,
            // Its own process group, so stopping takes the bundler with it and
            // not just the npm wrapper around it.
            detached: true,
          });
  } catch (err) {
    return { ok: false, code: "spawn", error: (err as Error).message, log: "", script };
  }

  const running: Running = { child, url: null, log: "", script, ready: null as never };
  running.ready = new Promise<DevServerResult>((resolve) => {
    let settled = false;
    const finish = (result: DevServerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      kill(running);
      servers.delete(root);
      finish({
        ok: false,
        code: "timeout",
        error: `"${command}" ran for a minute without printing an address.`,
        log: running.log,
        script,
      });
    }, START_TIMEOUT_MS);

    const onData = (chunk: Buffer | string) => {
      const text = String(chunk).replace(ANSI, "");
      running.log = (running.log + text).slice(-8000);
      if (running.url) return;
      const match = ADDRESS.exec(text) ?? ADDRESS.exec(running.log);
      if (!match) return;
      // 0.0.0.0 is where it listens, not somewhere a page can be loaded from.
      running.url = match[0].replace("0.0.0.0", "localhost").replace(/[.,)]+$/, "");
      finish({ ok: true, url: running.url, log: running.log, script });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      servers.delete(root);
      finish({ ok: false, code: "spawn", error: err.message, log: running.log, script });
    });
    child.on("close", (code) => {
      if (servers.get(root) === running) servers.delete(root);
      finish({
        ok: false,
        code: "exited",
        error: `"${command}" exited${code === null ? "" : ` with code ${code}`} without starting a server.`,
        log: running.log,
        script,
      });
    });
  });

  servers.set(root, running);
  return running.ready;
}

export function stopDevServer(root: string): void {
  stopServing(root);
  const running = servers.get(root);
  if (!running) return;
  servers.delete(root);
  kill(running);
}

export function stopAllDevServers(): void {
  stopAllServing();
  for (const running of servers.values()) kill(running);
  servers.clear();
}

function kill(running: Running): void {
  const { child } = running;
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } else {
      // Negative pid: the whole group the child leads.
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}
