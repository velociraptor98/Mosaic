const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Plays the exported Breakout and checks that its RULES hold.
 *
 * The other two harnesses stop short of this. `verify-export` proves the
 * generated code compiles and bundles; `parity` proves the editor's play-test
 * and the shipped build assemble the same scene. Neither presses a button.
 *
 * A generated scene can pass both and still be a game that cannot be played —
 * a ball that never launches, a brick that never breaks, a life that is never
 * lost — because all of that lives in script components, and nothing in the
 * repo has ever run one. So this drives the real build in real Chromium and
 * asserts on what the scripts did.
 */

const page = process.argv[2];
const shot = process.argv[3];
if (!page) {
  console.error("usage: electron scripts/breakout/playtest.cjs <page.html> [screenshot.png]");
  process.exit(1);
}

app.disableHardwareAcceleration();

/** Runs the page's own requestAnimationFrame `n` times, then resolves. */
const frames = (n) => `
  new Promise((resolve) => {
    let left = ${n};
    const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve(true));
    requestAnimationFrame(tick);
  })
`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event && event.level === "error") errors.push(event.message);
  });

  const run = (js) => win.webContents.executeJavaScript(js);

  try {
    await win.loadFile(path.resolve(page));

    // ---- boot -----------------------------------------------------------
    const booted = await run(`
      new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
          const scene = window.__game && window.__game.scene.getScene("Level_01");
          // Scripts start on the first tick, not at create(), so the wall has
          // not registered itself until a frame has actually run.
          if (scene && scene.objects && scene.objects.HUD && /BRICKS 60/.test(scene.objects.HUD.text)) {
            return resolve({ ok: true, hud: scene.objects.HUD.text });
          }
          if (Date.now() - started > 15000) return resolve({ ok: false, hud: scene && scene.objects && scene.objects.HUD && scene.objects.HUD.text });
          setTimeout(poll, 50);
        };
        poll();
      })
    `);
    check("the wall builds and counts itself", booted.ok, booted.hud);
    if (!booted.ok) throw new Error("scene never booted");

    // Captured here, before anything is driven: this is the game as it is
    // dealt, which is the picture worth keeping.
    if (shot) {
      const image = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      fs.writeFileSync(shot, image.toPNG());
      console.log(`  wrote ${shot}`);
    }

    // ---- the ball waits on the paddle -----------------------------------
    const docked = await run(`(() => {
      const s = window.__game.scene.getScene("Level_01");
      const ball = s.objects.Ball, paddle = s.objects.Paddle;
      return { dx: Math.abs(ball.x - paddle.x), above: paddle.y - ball.y, vy: ball.body.velocity.y };
    })()`);
    check(
      "the ball rests on the paddle before launch",
      docked.dx < 1 && docked.above === 50 && docked.vy === 0,
      `${docked.above}px above it, still`,
    );

    // ---- the paddle follows the pointer ----------------------------------
    await run(`(() => {
      const s = window.__game.scene.getScene("Level_01");
      s.input.emit("pointermove", { x: 250, y: 550 });
    })()`);
    await run(frames(4));
    const moved = await run(`(() => {
      const s = window.__game.scene.getScene("Level_01");
      return { paddle: s.objects.Paddle.x, ball: s.objects.Ball.x };
    })()`);
    check(
      "the paddle follows the pointer, and the ball rides it",
      Math.round(moved.paddle) === 250 && Math.abs(moved.ball - moved.paddle) < 1,
      `paddle at ${Math.round(moved.paddle)}`,
    );

    // The clamp is authored as a property, not a literal: the paddle's centre
    // may not come closer to a wall than half its own width.
    await run(`window.__game.scene.getScene("Level_01").input.emit("pointermove", { x: -400, y: 550 })`);
    await run(frames(4));
    const clamped = await run(`window.__game.scene.getScene("Level_01").objects.Paddle.x`);
    check("the paddle is clamped to the court", clamped === 52, `stopped at x=${clamped}`);

    // ---- launch ----------------------------------------------------------
    await run(`(() => {
      const s = window.__game.scene.getScene("Level_01");
      s.input.emit("pointermove", { x: 400, y: 550 });
      s.input.emit("pointerup");
    })()`);
    await run(frames(6));
    const launched = await run(`(() => {
      const b = window.__game.scene.getScene("Level_01").objects.Ball;
      return { vx: Math.round(b.body.velocity.x), vy: Math.round(b.body.velocity.y), y: Math.round(b.y) };
    })()`);
    check(
      "a click launches the ball at the authored velocity",
      launched.vx === -75 && launched.vy === -300,
      `velocity (${launched.vx}, ${launched.vy})`,
    );

    // Helpers. `park` re-docks the ball so a test can position it without
    // whatever it was doing in the meantime counting against the result;
    // `score` reads the HUD the director actually wrote.
    const park = () => run(`window.__game.scene.getScene("Level_01").events.emit("ball-reset")`);
    const score = () =>
      run(`Number(/SCORE (\\d+)/.exec(window.__game.scene.getScene("Level_01").objects.HUD.text)[1])`);

    // ---- a brick breaks --------------------------------------------------
    // The ball is dropped onto the top row from above, where nothing else is
    // in the way. The collider the Brick script registered is what has to
    // fire; nothing here calls into it.
    await park();
    const before = await score();
    const hit = await run(`
      (async () => {
        const s = window.__game.scene.getScene("Level_01");
        const brick = s.objects["Brick"];               // top-left, blue, worth 60
        const ball = s.objects.Ball;
        s.input.emit("pointerup");                      // launch, so update() lets go of it
        ball.setPosition(brick.x, brick.y - 60);
        ball.body.setVelocity(0, 260);                  // downward, onto the top of the brick
        // Sampled the frame the brick goes, not after a fixed wait: the ball
        // leaves upward and would reach the ceiling and turn round again well
        // inside any delay long enough to be safe.
        const vy = await new Promise((resolve) => {
          const deadline = Date.now() + 2000;
          const poll = () => {
            if (!brick.active) return resolve(Math.round(ball.body.velocity.y));
            if (Date.now() > deadline) return resolve(NaN);
            requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        });
        return { hud: s.objects.HUD.text, active: brick.active, vy };
      })()
    `);
    const afterBlue = await score();
    check(
      "the ball breaks a brick, and bounces off it",
      !hit.active && afterBlue - before === 60 && hit.vy < 0,
      `+${afterBlue - before} points · ball came off travelling ${hit.vy < 0 ? "up" : "down"}`,
    );

    // ---- a variant is worth its own score --------------------------------
    await park();
    const variant = await run(`
      (async () => {
        const s = window.__game.scene.getScene("Level_01");
        const brick = s.objects["Brick_Purple"];        // bottom row, worth 10
        const ball = s.objects.Ball;
        s.input.emit("pointerup");
        ball.setPosition(brick.x, brick.y + 60);
        ball.body.setVelocity(0, -260);                 // upward, into the underside
        await new Promise((r) => setTimeout(r, 400));
        return { active: brick.active };
      })()
    `);
    const afterPurple = await score();
    check(
      "a variant carries its own value",
      !variant.active && afterPurple - afterBlue === 10,
      `purple was worth ${afterPurple - afterBlue} where blue was worth ${afterBlue - before}`,
    );

    // ---- a lost ball costs a life ----------------------------------------
    await park();
    const lost = await run(`
      (async () => {
        const s = window.__game.scene.getScene("Level_01");
        const ball = s.objects.Ball;
        s.input.emit("pointerup");
        ball.setPosition(400, 700);                     // past the open floor
        ball.body.setVelocity(0, 200);
        await new Promise((r) => setTimeout(r, 300));
        return { hud: s.objects.HUD.text, y: Math.round(ball.y), vy: Math.round(ball.body.velocity.y) };
      })()
    `);
    check(
      "a ball past the floor costs a life and re-docks",
      /LIVES 2/.test(lost.hud) && lost.vy === 0 && lost.y < 600,
      `${lost.hud.trim()} · ball back at y=${lost.y}`,
    );

    // ---- clearing the wall rebuilds it -----------------------------------
    // Every remaining brick is broken through its own script, one at a time.
    await park();
    const cleared = await run(`
      (async () => {
        const s = window.__game.scene.getScene("Level_01");
        const bricks = Object.entries(s.objects).filter(([n]) => /^Brick/.test(n)).map(([, o]) => o);
        for (const brick of bricks) {
          const script = s.scripts.for(brick)[0];
          if (script && brick.active) script.hit();
        }
        await new Promise((r) => setTimeout(r, 300));
        const alive = bricks.filter((b) => b.active).length;
        return { hud: s.objects.HUD.text, alive, total: bricks.length, vy: s.objects.Ball.body.velocity.y };
      })()
    `);
    check(
      "the last brick rebuilds the wall and re-docks the ball",
      cleared.alive === cleared.total && /BRICKS 60/.test(cleared.hud) && cleared.vy === 0,
      `${cleared.alive}/${cleared.total} bricks back · ${cleared.hud.trim()}`,
    );

    // ---- the round ends --------------------------------------------------
    const over = await run(`
      (async () => {
        const s = window.__game.scene.getScene("Level_01");
        for (let i = 0; i < 2; i++) {
          s.events.emit("ball-reset");
          s.input.emit("pointerup");
          s.objects.Ball.setPosition(400, 700);
          s.objects.Ball.body.setVelocity(0, 200);
          await new Promise((r) => setTimeout(r, 250));
        }
        return { hud: s.objects.HUD.text, banner: s.objects.Banner.text };
      })()
    `);
    check(
      "running out of lives ends the round",
      /LIVES 0/.test(over.hud) && /GAME OVER/.test(over.banner),
      over.banner.replace("\n", " · "),
    );

    // A launch after the round is over must do nothing.
    const afterOver = await run(`
      (async () => {
        const s = window.__game.scene.getScene("Level_01");
        s.input.emit("pointerup");
        await new Promise((r) => setTimeout(r, 150));
        return Math.round(s.objects.Ball.body.velocity.y);
      })()
    `);
    check("the ball will not launch after game over", afterOver === 0, `velocity y = ${afterOver}`);

    const failed = results.filter((r) => !r.ok);
    if (errors.length) {
      console.log(`  ${errors.length} console error(s):`);
      for (const e of errors.slice(0, 5)) console.log(`    ${e}`);
    }
    if (failed.length || errors.length) {
      console.log(`PLAYTEST FAILED — ${failed.length} of ${results.length} checks`);
      app.exit(1);
      return;
    }
    console.log(`PLAYTEST OK — ${results.length} checks`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
