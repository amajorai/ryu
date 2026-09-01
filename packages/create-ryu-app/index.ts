/**
 * create-ryu-app — scaffold a starter Ryu project.
 *
 * Usage:
 *   bunx create-ryu-app <name> [--template <template>]
 *
 * Ryu extensions come in two shapes, and the templates are split along that line:
 *
 *   APP     — a self-contained `apps-store/<app>` satellite: a `manifest.json`
 *             plus an out-of-process `sidecar/`. Clients drive it through the
 *             GENERIC ext-proxy (`/api/ext/<plugin_id>/*`), so shipping one never
 *             touches Core or the Gateway. Template: `app`.
 *   PLUGIN  — a manifest of CONTRIBUTIONS Core and the desktop render in-process:
 *             runnables, turn hooks, widgets, composer controls, a companion
 *             panel. No sidecar, no port. Templates: `agent`, `action`,
 *             `hook-plugin`, `ryu-app`, `companion-plugin`.
 *
 * Every template emits a directory `<name>/` containing:
 *   manifest.json  — the manifest (validated against PluginManifestSchema)
 *   package.json   — project config with a `dev` script
 *   src/*          — plugin templates: the authoring source (a defineX factory)
 *   sidecar/*      — the `app` template: the backend process it declares
 *
 * The generated manifest.json validates against the PluginManifest schema so the
 * Ryu desktop plugin store can install it immediately. Note the schema models the
 * PLUGIN surface: it passes an app manifest but strips the satellite-only
 * `sidecars`/`provides`/`engines` blocks from the *parsed* value. Those keys stay
 * on disk untouched (this scaffolder validates the file, it never rewrites it),
 * which is what Core's Rust loader — the authority on them — reads.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManifestSchema } from "@ryuhq/sdk/manifest";

// Top-level regex constants — avoids lint/performance/useTopLevelRegex.
const RE_WORD_SEPARATOR = /[-_\s]+/;
const RE_VALID_NAME = /^[a-z0-9][a-z0-9-_]*$/i;
// A companion `label` may not contain "ryu"/"system" (Core's anti-impersonation
// refine, mirrored in `labelImpersonatesSystemChrome`). Since this tool is named
// `create-ryu-app`, a `ryu-*` project name is likely — so the label stamp falls
// back to a safe literal rather than crashing scaffold on the manifest gate.
const RE_LABEL_IMPERSONATES = /ryu|system/i;
const SAFE_COMPANION_LABEL = "App Panel";

/** The @ryuhq/sdk semver range stamped into a generated project's dependencies.
 *  Kept in lockstep with this package's own @ryuhq/sdk dependency (package.json)
 *  so a scaffolded project pins the same SDK line the scaffolder was built against. */
const SDK_DEPENDENCY_RANGE = "^0.2.5";

/**
 * Which of the two extension shapes a template produces. This is not cosmetic: it
 * decides what the generated `package.json` says. A `plugin` is authored against
 * `@ryuhq/sdk` and packed with `ryu pack` (which bundles its widget code and
 * rewrites the manifest); an `app` is a satellite whose `sidecar/` must build and
 * ship from its own tree, so it depends on nothing of ours and has no bundle to
 * pack — giving it an SDK dependency would quietly break the one property
 * (self-containment) that makes it a satellite.
 */
type TemplateKind = "app" | "plugin";

/** Per-template scaffolding config: which shape it produces, the `dev` entry file,
 *  and any extra deps/scripts the generated project needs. The template TREE lives
 *  in `template/<name>/`; the default (`agent`) preserves the original layout. */
interface TemplateSpec {
	/** The file `bun dev` runs (relative to the project root). */
	devEntry: string;
	/** Extra runtime deps merged into the generated package.json. */
	extraDependencies?: Record<string, string>;
	/** Extra scripts merged over the per-kind defaults in the generated package.json. */
	extraScripts?: Record<string, string>;
	/** APP (satellite + sidecar) or PLUGIN (in-process contributions). */
	kind: TemplateKind;
	/** One-line description, printed in `--help` under its shape's heading. */
	summary: string;
}

const TEMPLATES: Record<string, TemplateSpec> = {
	agent: {
		kind: "plugin",
		summary: "a loop-owning Runnable agent (Agent + ryuTool)",
		devEntry: "src/agent.ts",
	},
	action: {
		kind: "plugin",
		summary: "a governed business action (defineAction)",
		devEntry: "src/action.ts",
	},
	"hook-plugin": {
		kind: "plugin",
		summary: "a post-assistant-turn hook (definePlugin + defineTurnHook)",
		devEntry: "src/plugin.ts",
	},
	"ryu-app": {
		kind: "plugin",
		summary: "an interactive in-chat widget (defineApp + a sandboxed widget)",
		devEntry: "src/app.ts",
		extraDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
	},
	"companion-plugin": {
		kind: "plugin",
		summary: "a widget that calls a companion tool, plus a panel surface",
		devEntry: "src/app.ts",
		extraDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
	},
	app: {
		kind: "app",
		summary:
			"an apps-store satellite: manifest + a loopback HTTP sidecar, driven through the ext-proxy",
		devEntry: "sidecar/src/main/index.ts",
		extraScripts: {
			build: "bun run --cwd sidecar build",
			"check-types": "bun run --cwd sidecar check-types",
		},
	},
};

const DEFAULT_TEMPLATE = "agent";

/** File extensions whose contents carry `__APP_NAME__` / `__APP_DISPLAY_NAME__`
 *  placeholders and must be stamped after copy. */
const STAMPABLE_EXTENSIONS = [".json", ".ts", ".tsx", ".html", ".md"];

// ── helpers ───────────────────────────────────────────────────────────────────

function exitError(message: string): never {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

/** The `--template` block: one `name — summary` line per template, grouped under
 *  its shape so the app/plugin distinction is visible without reading the docs. */
function templateLines(kind: TemplateKind): string[] {
	const width = Math.max(...Object.keys(TEMPLATES).map((n) => n.length));
	return Object.entries(TEMPLATES)
		.filter(([, spec]) => spec.kind === kind)
		.map(
			([name, spec]) =>
				`    ${name.padEnd(width)}  ${spec.summary}${name === DEFAULT_TEMPLATE ? " (default)" : ""}`
		);
}

function printUsage(): void {
	process.stderr.write(
		[
			"create-ryu-app — scaffold a starter Ryu app or plugin",
			"",
			"Usage:",
			"  bunx create-ryu-app <name> [--template <template>]",
			"",
			"Arguments:",
			"  <name>       Project directory name (also used as the app id slug)",
			"",
			"Options:",
			"  --template   Which starter to emit. Two shapes:",
			"",
			"  APP — a self-contained satellite: manifest.json + an out-of-process",
			"  sidecar/, reached through the generic ext-proxy (/api/ext/<id>/*).",
			"  Ships without any change to Ryu Core or the Gateway.",
			...templateLines("app"),
			"",
			"  PLUGIN — manifest contributions Ryu renders in-process: runnables,",
			"  turn hooks, widgets, composer controls, a companion panel. No sidecar,",
			"  no port.",
			...templateLines("plugin"),
			"",
		].join("\n")
	);
}

/** Convert a slug like "my-app" to a title-cased display name "My App". */
function toDisplayName(slug: string): string {
	return slug
		.split(RE_WORD_SEPARATOR)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * A safe companion label for a display name: the display name itself, unless it
 * would impersonate first-party Ryu/system chrome (Core rejects such labels), in
 * which case a neutral literal.
 */
function toCompanionLabel(displayName: string): string {
	return RE_LABEL_IMPERSONATES.test(displayName)
		? SAFE_COMPANION_LABEL
		: displayName;
}

/**
 * The `RYU_<SLUG>_` env-var prefix an app's sidecar is configured through, e.g.
 * `my-app` → `RYU_MY_APP`.
 *
 * These names are load-bearing, not decoration: `<prefix>_PORT` is the manifest's
 * `port_env`, which Core injects with the PROFILE-SHIFTED port at spawn. A sidecar
 * that hardcodes the manifest's static port instead binds the release port while a
 * dev-profile Core health-checks and proxies the +1000 one — the process looks
 * dead to the node that started it. `<prefix>_BIN` overrides the spawned command
 * (a local dev build) and `<prefix>_TOKEN` overrides the injected `RYU_EXT_TOKEN`
 * for standalone runs.
 */
function toEnvPrefix(slug: string): string {
	return `RYU_${slug.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * Replace every `__PLACEHOLDER__` in a text file with its value and write it back.
 * Used to stamp the name (and derived values) into template files.
 */
function stampTemplate(
	filePath: string,
	replacements: Record<string, string>
): void {
	let content = readFileSync(filePath, "utf8");
	for (const [placeholder, value] of Object.entries(replacements)) {
		content = content.replaceAll(placeholder, value);
	}
	writeFileSync(filePath, content, "utf8");
}

/** Recursively stamp every stampable text file under `dir`. */
function stampTree(dir: string, replacements: Record<string, string>): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			stampTree(full, replacements);
			continue;
		}
		if (STAMPABLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
			stampTemplate(full, replacements);
		}
	}
}

/**
 * Resolve the bundled template root for `<template>`, tolerant of where the bin
 * runs from. `files` ships `template/` at the package root, so:
 *   - from source, this module is `index.ts` at the package root → `./template`
 *   - from the published bundle, it is `dist/index.js` → `../template`
 * Returns the first existing candidate; exits if none is found. Uses
 * `fileURLToPath(import.meta.url)` (not Bun-only `import.meta.dir`) so it also
 * works under `npx`/Node, not just `bunx`.
 */
function resolveTemplateDir(template: string): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(moduleDir, "template", template),
		join(moduleDir, "..", "template", template),
	];
	const found = candidates.find((dir) => existsSync(dir));
	if (!found) {
		exitError(
			`template directory not found for '${template}' (looked in: ${candidates.join(", ")})`
		);
	}
	return found;
}

// ── scaffold ──────────────────────────────────────────────────────────────────

/**
 * Scaffold a new Ryu SDK project into `<outDir>/<name>` from `<template>`.
 *
 * Returns the absolute path to the created project directory.
 * Exported for use by the test suite (pass `outDir` = a tmp directory).
 */
export function scaffold(
	name: string,
	outDir: string,
	template: string = DEFAULT_TEMPLATE
): string {
	const slug = name.trim();
	if (!slug) {
		exitError("name must not be empty");
	}
	if (!RE_VALID_NAME.test(slug)) {
		exitError(
			"name must start with a letter or digit and contain only letters, digits, hyphens, and underscores"
		);
	}

	const spec = TEMPLATES[template];
	if (!spec) {
		exitError(
			`unknown template '${template}' — expected one of: ${Object.keys(TEMPLATES).join(", ")}`
		);
	}

	const projectDir = resolve(join(outDir, slug));
	if (existsSync(projectDir)) {
		exitError(`directory already exists: ${projectDir}`);
	}

	const templateDir = resolveTemplateDir(template);

	const displayName = toDisplayName(slug);
	const envPrefix = toEnvPrefix(slug);

	// Copy the full template tree, then stamp every text file (manifest.json + src
	// + sidecar). The env-name stamps are only referenced by the `app` template;
	// they are harmless no-ops for the plugin templates, so the replacement map
	// stays one thing rather than a per-template branch.
	mkdirSync(projectDir, { recursive: true });
	cpSync(templateDir, projectDir, { recursive: true });
	stampTree(projectDir, {
		__APP_NAME__: slug,
		__APP_DISPLAY_NAME__: displayName,
		__COMPANION_LABEL__: toCompanionLabel(displayName),
		__APP_BIN_ENV__: `${envPrefix}_BIN`,
		__APP_PORT_ENV__: `${envPrefix}_PORT`,
		__APP_TOKEN_ENV__: `${envPrefix}_TOKEN`,
	});

	// Validate the stamped manifest.json against PluginManifestSchema.
	const manifestPath = join(projectDir, "manifest.json");
	const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
	const validation = PluginManifestSchema.safeParse(parsed);
	if (!validation.success) {
		const first = validation.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const msg = first?.message ?? "validation failed";
		exitError(`generated manifest.json is invalid at '${field}': ${msg}`);
	}

	// Write the project package.json (not in the template so the entry + deps can
	// be parametrized per template without a second placeholder pass).
	//
	// A PLUGIN is authored against the SDK and shipped by `ryu pack`, which bundles
	// its widget code into `ui_code` and rewrites the manifest. An APP has neither:
	// its sidecar is a standalone process (`sidecar/package.json` owns its own
	// toolchain) and its manifest is the deliverable, so it gets no SDK dependency
	// and no `pack` script — declaring either would make the satellite depend on
	// the very tree it is supposed to ship without.
	const isApp = spec.kind === "app";
	const pkgJson = {
		name: slug,
		version: "0.1.0",
		type: "module",
		scripts: {
			dev: `bun run ${spec.devEntry}`,
			...(isApp ? {} : { pack: "bunx ryu pack ." }),
			...spec.extraScripts,
		},
		...(isApp
			? {}
			: {
					dependencies: {
						"@ryuhq/sdk": SDK_DEPENDENCY_RANGE,
						...spec.extraDependencies,
					},
				}),
	};
	writeFileSync(
		join(projectDir, "package.json"),
		JSON.stringify(pkgJson, null, 2),
		"utf8"
	);

	return projectDir;
}

// ── arg parsing ───────────────────────────────────────────────────────────────

interface ParsedArgs {
	name?: string;
	template: string;
}

/** Parse `<name> [--template <t>|--template=<t>]` positionally. Returns the name
 *  (possibly undefined) and the resolved template (default `agent`). Rejects any
 *  extra positional or unknown flag by returning `error`. */
export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
	let name: string | undefined;
	let template = DEFAULT_TEMPLATE;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--template") {
			const next = argv[i + 1];
			if (!next) {
				return { error: "--template requires a value" };
			}
			template = next;
			i += 1;
			continue;
		}
		if (arg?.startsWith("--template=")) {
			template = arg.slice("--template=".length);
			continue;
		}
		if (arg?.startsWith("-")) {
			return { error: `unknown option: ${arg}` };
		}
		if (name === undefined) {
			name = arg;
			continue;
		}
		return { error: "too many arguments — expected exactly one <name>" };
	}
	return { name, template };
}

// ── main — only runs when invoked directly, not when imported by tests ────────

if (import.meta.main) {
	const parsed = parseArgs(process.argv.slice(2));

	if ("error" in parsed) {
		printUsage();
		exitError(parsed.error);
	}
	if (!parsed.name) {
		printUsage();
		exitError("name argument is required");
	}

	const created = scaffold(parsed.name, process.cwd(), parsed.template);
	// The last line differs by shape because the deliverables differ: a plugin is
	// bundled by `ryu pack`, an app is a satellite whose sidecar is compiled to the
	// binary its manifest names.
	const isApp = TEMPLATES[parsed.template]?.kind === "app";
	process.stdout.write(
		[
			"",
			`  created ${parsed.name}/ (${parsed.template})`,
			"",
			"  next steps:",
			`    cd ${parsed.name}`,
			"    bun install",
			"    bun dev         # runs the template entry",
			isApp
				? "    bun run build   # compile the sidecar binary the manifest names"
				: "    bun run pack    # validate and bundle manifest.json",
			"",
		].join("\n")
	);
	process.stdout.write(`  project: ${created}\n\n`);
}
