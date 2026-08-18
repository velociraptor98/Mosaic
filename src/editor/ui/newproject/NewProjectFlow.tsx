import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectConfig } from "../../../shared/types";
import { platform } from "../../platform";
import type { TargetCheck, Toolchain } from "../../platform/types";
import {
  DEFAULT_OPTIONS,
  isValidNpmName,
  planScaffold,
  slugify,
  type Bundler,
  type Language,
  type NewProjectOptions,
} from "../../project/scaffold";
import type { Workspace } from "../../project/workspace";
import { SCENE_TEMPLATES, type TemplateId } from "../../store/templates";
import { MosaicMark } from "../Logo";
import { TemplateThumb } from "./thumbnails";

type Step = "template" | "details" | "defaults" | "review" | "creating";
const ORDER: Step[] = ["template", "details", "defaults", "review", "creating"];

export interface FirstRunInfo {
  root: string;
  installing: boolean;
}

/**
 * Screens 2–6 of the flow spec. Every choice here ends up as a real file:
 * nothing is remembered only in the editor.
 */
export function NewProjectFlow({
  workspace,
  onCancel,
  onCreated,
}: {
  workspace: Workspace;
  onCancel: () => void;
  onCreated: (info: FirstRunInfo) => void;
}) {
  const [step, setStep] = useState<Step>("template");
  const [opts, setOpts] = useState<NewProjectOptions>({ ...DEFAULT_OPTIONS, name: "skyward" });
  const [target, setTarget] = useState<TargetCheck | null>(null);
  const [toolchain, setToolchain] = useState<Toolchain>({ node: null, npm: null, git: null });
  const [progress, setProgress] = useState<{ label: string; ms: string; done: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(
    (patch: Partial<NewProjectOptions>) => setOpts((o) => ({ ...o, ...patch })),
    [],
  );
  const setConfig = useCallback(
    (patch: Partial<ProjectConfig>) => setOpts((o) => ({ ...o, config: { ...o.config, ...patch } })),
    [],
  );

  // A default location and the toolchain are needed before the details screen
  // can say anything useful.
  useEffect(() => {
    void platform.defaultProjectsDir().then((dir) => set({ location: dir }));
    void platform.toolchain().then(setToolchain);
  }, [set]);

  const slug = slugify(opts.name);

  // Validation runs while you type, so a bad target is caught before the
  // create button rather than after it.
  useEffect(() => {
    if (!opts.location) return;
    let cancelled = false;
    void platform.validateTarget(opts.location, slug).then((t) => {
      if (!cancelled) setTarget(t);
    });
    return () => {
      cancelled = true;
    };
  }, [opts.location, slug]);

  const plan = useMemo(() => planScaffold(opts), [opts]);
  const stepIndex = ORDER.indexOf(step);
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const create = async () => {
    go("creating");
    const started = Date.now();
    const mark = (label: string, done = true) =>
      setProgress((p) => [...p, { label, ms: `${Date.now() - started} ms`, done }]);

    const root = target?.resolved ?? plan.root;
    const result = await platform.scaffoldProject(
      root,
      plan.writes.map((f) => ({ rel: f.rel, contents: f.contents, encoding: f.encoding })),
    );
    if (!result.ok) {
      setError(result.error ?? "Could not create the project");
      go("review");
      return;
    }
    mark("create folder");
    mark(`write ${result.written.length} files`);

    if (opts.git && toolchain.git) {
      const ok = await platform.gitInit(root);
      mark(ok ? "git init + stage" : "git init failed", ok);
    }

    const opened = await workspace.open({ root, name: opts.name.trim() || slug });
    mark("open Level_01", opened);

    const installing = opts.bundler !== "none" && !!toolchain.npm;
    if (installing) {
      setProgress((p) => [...p, { label: "npm install (background)", ms: "running", done: false }]);
      workspace.markInstalling();
      void platform.install(root);
    }
    // Open on the scene straight away; install keeps running behind the editor.
    setTimeout(() => onCreated({ root, installing }), 500);
  };

  return (
    <div className="wizard">
      <div className="wizard-window blueprint">
        <i className="corner tl" />
        <i className="corner tr" />
        <i className="corner bl" />
        <i className="corner br" />

        <div className="wizard-titlebar">
          <MosaicMark size={15} />
          <span className="wizard-title">NEW PROJECT</span>
          <span className="wizard-spacer" />
          <span className="wizard-meta">
            {step === "creating" ? "creating" : `step ${stepIndex + 1} of 4`}
          </span>
        </div>

        <div className="wizard-body">
          {step === "template" && (
            <TemplateStep opts={opts} set={set} onNext={() => go("details")} onCancel={onCancel} />
          )}
          {step === "details" && (
            <DetailsStep
              opts={opts}
              set={set}
              slug={slug}
              target={target}
              toolchain={toolchain}
              onBack={() => go("template")}
              onNext={() => go("defaults")}
            />
          )}
          {step === "defaults" && (
            <DefaultsStep
              opts={opts}
              setConfig={setConfig}
              onBack={() => go("details")}
              onNext={() => go("review")}
            />
          )}
          {step === "review" && (
            <ReviewStep
              plan={plan}
              target={target}
              error={error}
              onBack={() => go("defaults")}
              onCreate={() => void create()}
            />
          )}
          {step === "creating" && <CreatingStep name={opts.name} progress={progress} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- screens

function TemplateStep({
  opts,
  set,
  onNext,
  onCancel,
}: {
  opts: NewProjectOptions;
  set: (p: Partial<NewProjectOptions>) => void;
  onNext: () => void;
  onCancel: () => void;
}) {
  const current = SCENE_TEMPLATES.find((t) => t.id === opts.template)!;
  return (
    <div className="wizard-pane">
      <header>
        <h2>Start from a template</h2>
        <p>Every template is a real, runnable scene — not an empty stub with TODOs.</p>
      </header>

      <div className="tpl-grid">
        {SCENE_TEMPLATES.map((t) => (
          <button
            key={t.id}
            className={`tpl-card ${opts.template === t.id ? "active" : ""}`}
            onClick={() => set({ template: t.id as TemplateId })}
          >
            <TemplateThumb id={t.id as TemplateId} />
            <span className="tpl-name">{t.label}</span>
            <span className="tpl-desc">{t.blurb}</span>
            <span className="tpl-files">{planFileCount(t.id as TemplateId, opts)} files</span>
          </button>
        ))}
      </div>

      <div className="tpl-includes">
        <div>
          <div className="section-title">What “{current.label}” includes</div>
          <div className="chips">
            {current.includes.map((x) => (
              <span key={x} className="chip on">
                {x}
              </span>
            ))}
          </div>
        </div>
        <div className="wizard-actions">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={onNext}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function planFileCount(template: TemplateId, opts: NewProjectOptions): number {
  return planScaffold({ ...opts, template }).writes.length;
}

function DetailsStep({
  opts,
  set,
  slug,
  target,
  toolchain,
  onBack,
  onNext,
}: {
  opts: NewProjectOptions;
  set: (p: Partial<NewProjectOptions>) => void;
  slug: string;
  target: TargetCheck | null;
  toolchain: Toolchain;
  onBack: () => void;
  onNext: () => void;
}) {
  const ext = opts.language === "ts" ? "ts" : "js";
  const blocked = !!target && target.exists && !target.isEmpty;

  const checks = [
    { label: "path is writable", ok: target?.writable ?? false },
    {
      label: target?.exists
        ? target.isEmpty
          ? "folder exists and is empty"
          : target.hasProject
            ? "folder already holds a Mosaic project"
            : "folder is not empty — choose another name or location"
        : "folder does not exist yet — will be created",
      ok: !target?.exists || target.isEmpty,
    },
    { label: "name is a valid npm package name", ok: isValidNpmName(opts.name) },
    {
      label:
        opts.bundler === "none"
          ? "no bundler — install skipped"
          : toolchain.node
            ? `node ${toolchain.node.replace(/^v/, "")} · npm ${toolchain.npm ?? "?"} found`
            : "no node on PATH — project is created without install",
      ok: opts.bundler === "none" || !!toolchain.node,
    },
  ];

  return (
    <div className="wizard-split">
      <div className="wizard-pane">
        <header>
          <h2>Project details</h2>
          <p>The folder is created on confirm, not now — you can still back out.</p>
        </header>

        <label className="field">
          <span className="field-label">Project name</span>
          <input value={opts.name} autoFocus onChange={(e) => set({ name: e.target.value })} />
        </label>

        <label className="field">
          <span className="field-label">Location</span>
          <span className="row">
            <input value={opts.location} onChange={(e) => set({ location: e.target.value })} />
            <button
              className="ghost"
              onClick={async () => {
                const dir = await platform.pickDirectory(opts.location);
                if (dir) set({ location: dir });
              }}
            >
              Browse…
            </button>
          </span>
        </label>

        <div className="row wrap">
          <div>
            <div className="field-label">Language</div>
            <Segmented
              value={opts.language}
              options={[
                { value: "ts", label: "TypeScript" },
                { value: "js", label: "JavaScript" },
              ]}
              onChange={(v) => set({ language: v as Language })}
            />
          </div>
          <div>
            <div className="field-label">Bundler</div>
            <Segmented
              value={opts.bundler}
              options={[
                { value: "vite", label: "Vite" },
                { value: "webpack", label: "Webpack" },
                { value: "none", label: "None" },
              ]}
              onChange={(v) => set({ bundler: v as Bundler })}
            />
          </div>
        </div>

        <label className="field check">
          <input type="checkbox" checked={opts.git} onChange={(e) => set({ git: e.target.checked })} />
          <span className="field-label">
            initialise a git repository{!toolchain.git && " (git not found — will be skipped)"}
          </span>
        </label>
        <label className="field check">
          <input
            type="checkbox"
            checked={opts.sampleArt}
            onChange={(e) => set({ sampleArt: e.target.checked })}
          />
          <span className="field-label">include placeholder art (wireframe tileset + hero sheet)</span>
        </label>

        <div className="wizard-actions end">
          <button className="ghost" onClick={onBack}>
            Back
          </button>
          <button className="primary" disabled={blocked} onClick={onNext}>
            Continue
          </button>
        </div>
      </div>

      <aside className="wizard-rail">
        <div className="section-title">Resolves to</div>
        <pre className="resolve">
          {`${target?.resolved ?? `${opts.location}/${slug}`}/
  package.json  →  "${slug}"
  src/scenes/Level_01.${ext}`}
        </pre>
        <div className="section-title">Validation</div>
        {checks.map((c) => (
          <div key={c.label} className={`check-row ${c.ok ? "ok" : "warn"}`}>
            <span className="mark">{c.ok ? "✓" : "!"}</span>
            <span>{c.label}</span>
          </div>
        ))}
        <div className="wizard-spacer" />
        <p className="hint">
          A name that isn’t a valid npm package name is accepted for the project but slugged for{" "}
          <code>package.json</code>.
        </p>
      </aside>
    </div>
  );
}

function DefaultsStep({
  opts,
  setConfig,
  onBack,
  onNext,
}: {
  opts: NewProjectOptions;
  setConfig: (p: Partial<ProjectConfig>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { config } = opts;
  const gridPercent = (config.tile / config.canvas.width) * 100;
  const divides =
    config.canvas.width % config.tile === 0 && config.canvas.height % config.tile === 0;

  return (
    <div className="wizard-split">
      <div className="wizard-pane">
        <header>
          <h2>Scene defaults</h2>
          <p>Written into the project config; every new scene inherits them.</p>
        </header>

        <div className="grid3">
          <label className="field">
            <span className="field-label">Width</span>
            <input
              type="number"
              value={config.canvas.width}
              onChange={(e) =>
                setConfig({ canvas: { ...config.canvas, width: Number(e.target.value) || 1 } })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Height</span>
            <input
              type="number"
              value={config.canvas.height}
              onChange={(e) =>
                setConfig({ canvas: { ...config.canvas, height: Number(e.target.value) || 1 } })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Tile</span>
            <input
              type="number"
              value={config.tile}
              onChange={(e) => setConfig({ tile: Math.max(1, Number(e.target.value) || 1) })}
            />
          </label>
        </div>
        {!divides && (
          <div className="banner warn">
            Tile {config.tile} does not divide {config.canvas.width}×{config.canvas.height} evenly —
            allowed, but the grid will not meet the canvas edge.
          </div>
        )}

        <div>
          <div className="field-label">Scale mode</div>
          <Segmented
            full
            value={config.scale}
            options={[
              { value: "FIT", label: "FIT" },
              { value: "ENVELOP", label: "ENVELOP" },
              { value: "NONE", label: "NONE" },
            ]}
            onChange={(v) => setConfig({ scale: v as ProjectConfig["scale"] })}
          />
        </div>

        <div>
          <div className="field-label">Physics</div>
          <Segmented
            full
            value={config.physics}
            options={[
              { value: "arcade", label: "Arcade" },
              { value: "matter", label: "Matter" },
              { value: "none", label: "None" },
            ]}
            onChange={(v) => setConfig({ physics: v as ProjectConfig["physics"] })}
          />
        </div>
        {config.physics === "matter" && (
          <div className="banner">
            Matter chosen — the collision matrix becomes body-pair based rather than group based.
          </div>
        )}

        <label className="field check">
          <input
            type="checkbox"
            checked={config.pixelArt}
            onChange={(e) => setConfig({ pixelArt: e.target.checked })}
          />
          <span className="field-label">pixel art — nearest-neighbour, round pixels</span>
        </label>

        <div className="wizard-actions end">
          <button className="ghost" onClick={onBack}>
            Back
          </button>
          <button className="primary" onClick={onNext}>
            Continue
          </button>
        </div>
      </div>

      <aside className="wizard-rail">
        <div className="section-title">
          Preview — {config.canvas.width} × {config.canvas.height} @ tile {config.tile}
        </div>
        <div
          className="canvas-preview"
          style={{
            aspectRatio: `${config.canvas.width} / ${config.canvas.height}`,
            backgroundSize: `${gridPercent}% ${gridPercent}%`,
          }}
        >
          <span className="cp-ground" />
          <span className="cp-player" />
          <span className="cp-label">
            camera 1:1 · {config.scale}
            {config.pixelArt ? " · pixel art" : ""}
          </span>
        </div>
        <pre className="config-preview">{JSON.stringify(config, null, 2)}</pre>
      </aside>
    </div>
  );
}

function ReviewStep({
  plan,
  target,
  error,
  onBack,
  onCreate,
}: {
  plan: ReturnType<typeof planScaffold>;
  target: TargetCheck | null;
  error: string | null;
  onBack: () => void;
  onCreate: () => void;
}) {
  const scenePreview =
    plan.files.find((f) => f.rel.startsWith("src/scenes/Level_01."))?.contents ?? "";
  const overwrites = target?.exists && !target.isEmpty ? "unknown" : 0;

  return (
    <div className="wizard-split">
      <div className="wizard-pane">
        <header>
          <h2>Review what gets written</h2>
          <p>Nothing is created until you confirm. This is the whole diff.</p>
        </header>

        <div className="file-tree">
          {plan.files.map((f) => (
            <div key={f.rel} className={`file-row ${f.skipped ? "skipped" : ""}`}>
              <span className="sign">{f.skipped ? "·" : "+"}</span>
              <span className="path">{f.rel}</span>
              <span className="note">{f.note}</span>
            </div>
          ))}
        </div>

        {error && <div className="banner error">{error}</div>}

        <div className="wizard-actions end">
          <span className="file-count">
            {plan.writes.length} files · {overwrites} overwrites
          </span>
          <button className="ghost" onClick={onBack}>
            Back
          </button>
          <button className="primary" onClick={onCreate}>
            Create project
          </button>
        </div>
      </div>

      <aside className="wizard-rail">
        <div className="section-title">Generated scene — Level_01</div>
        <pre className="code-preview">{scenePreview.split("\n").slice(0, 34).join("\n")}</pre>
        <p className="hint">
          Regions between <code>{"// <keep>"}</code> markers are never touched by a later
          re-export, so hand-written logic is safe from the generator.
        </p>
      </aside>
    </div>
  );
}

function CreatingStep({
  name,
  progress,
}: {
  name: string;
  progress: { label: string; ms: string; done: boolean }[];
}) {
  return (
    <div className="wizard-creating">
      <MosaicMark size={58} />
      <h2>Creating {name}</h2>
      <div className="progress-bar">
        <span />
      </div>
      <div className="progress-list">
        {progress.map((p, i) => (
          <div key={i} className={`progress-row ${p.done ? "done" : ""}`}>
            <span className="mark">{p.done ? "✓" : "·"}</span>
            {p.label}
            <span className="wizard-spacer" />
            <span className="ms">{p.ms}</span>
          </div>
        ))}
      </div>
      <p className="hint">
        Dependency install runs in the background — the editor opens as soon as the scene file
        exists.
      </p>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
  full,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  full?: boolean;
}) {
  return (
    <div className={`segmented ${full ? "full" : ""}`}>
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
