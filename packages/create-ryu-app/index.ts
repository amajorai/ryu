/**
 * create-ryu-app — scaffold a starter Ryu SDK project.
 *
 * Usage:
 *   bunx create-ryu-app <name> [--template <template>]
 *
 * Templates (‑‑template, default `agent`):
 *   agent            — a loop-owning Runnable agent (Agent + ryuTool)
 *   hook-plugin      — a post-assistant-turn plugin (definePlugin + defineTurnHook)
 *   ryu-app          — an interactive in-chat widget (defineApp + a self-contained widget)
 *   companion-plugin — a Ryu App whose widget calls a companion tool + a panel surface
 *
 * Every template emits a directory `<name>/` containing:
 *   plugin.json        — Plugin manifest (validated against PluginManifestSchema)
 *   src/*              — the template's authoring source (uses the matching defineX factory)
 *   package.json       — Project config with a `dev` script and @ryuhq/sdk dep
 *
 * The generated plugin.json validates against the PluginManifest schema so the
 * Ryu desktop plugin store can install it immediately.
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
const SDK_DEPENDENCY_RANGE = "^0.0.4";

/** Per-template scaffolding config: the `dev` entry file and whether the template's
 *  widget source needs React in the generated project. The template TREE lives in
 *  `template/<name>/`; the default (`agent`) preserves the original layout. */
interface TemplateSpec {
	/** The file `bun dev` runs (relative to the project root). */
	devEntry: string;
	/** Extra runtime deps merged into the generated package.json. */
	extraDependencies?: Record<string, string>;
}

const TEMPLATES: Record<string, TemplateSpec> = {
	agent: { devEntry: "src/agent.ts" },
	"hook-plugin": { devEntry: "src/plugin.ts" },
	"ryu-app": {
		devEntry: "src/app.ts",
		extraDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
	},
	"companion-plugin": {
		devEntry: "src/app.ts",
		extraDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
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

function printUsage(): void {
	const templates = Object.keys(TEMPLATES).join(" | ");
	process.stderr.write(
		[
			"create-ryu-app — scaffold a starter Ryu SDK project",
			"",
			"Usage:",
			"  bunx create-ryu-app <name> [--template <template>]",
			"",
			"Arguments:",
			"  <name>       Project directory name (also used as the app id slug)",
			"",
			"Options:",
			`  --template   One of: ${templates} (default: ${DEFAULT_TEMPLATE})`,
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

	// Copy the full template tree, then stamp every text file (plugin.json + src).
	mkdirSync(projectDir, { recursive: true });
	cpSync(templateDir, projectDir, { recursive: true });
	stampTree(projectDir, {
		__APP_NAME__: slug,
		__APP_DISPLAY_NAME__: displayName,
		__COMPANION_LABEL__: toCompanionLabel(displayName),
	});

	// Validate the stamped plugin.json against PluginManifestSchema.
	const manifestPath = join(projectDir, "plugin.json");
	const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
	const validation = PluginManifestSchema.safeParse(parsed);
	if (!validation.success) {
		const first = validation.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const msg = first?.message ?? "validation failed";
		exitError(`generated plugin.json is invalid at '${field}': ${msg}`);
	}

	// Write the project package.json (not in the template so the entry + deps can
	// be parametrized per template without a second placeholder pass).
	const pkgJson = {
		name: slug,
		version: "0.1.0",
		type: "module",
		scripts: {
			dev: `bun run ${spec.devEntry}`,
			pack: "bunx ryu pack .",
		},
		dependencies: {
			"@ryuhq/sdk": SDK_DEPENDENCY_RANGE,
			...spec.extraDependencies,
		},
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
	process.stdout.write(
		[
			"",
			`  created ${parsed.name}/ (${parsed.template})`,
			"",
			"  next steps:",
			`    cd ${parsed.name}`,
			"    bun install",
			"    bun dev        # runs the template entry",
			"    bun run pack   # validate and bundle plugin.json",
			"",
		].join("\n")
	);
	process.stdout.write(`  project: ${created}\n\n`);
}
