#!/usr/bin/env node
/**
 * create-ryu-app — scaffold a starter Ryu SDK project.
 *
 * Usage:
 *   bunx create-ryu-app <name>
 *
 * Emits a directory `<name>/` containing:
 *   plugin.json        — Plugin manifest (validated against PluginManifestSchema)
 *   src/agent.ts       — Starter Runnable using the gateway-mandatory model client
 *   package.json       — Project config with a `dev` script and @ryuhq/sdk dep
 *
 * The generated plugin.json validates against the PluginManifest schema so the
 * Ryu desktop plugin store can install it immediately.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PluginManifestSchema } from "@ryuhq/sdk/manifest";

// Top-level regex constants — avoids lint/performance/useTopLevelRegex.
const RE_WORD_SEPARATOR = /[-_\s]+/;
const RE_VALID_NAME = /^[a-z0-9][a-z0-9-_]*$/i;

// ── helpers ───────────────────────────────────────────────────────────────────

function exitError(message: string): never {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

function printUsage(): void {
	process.stderr.write(
		[
			"create-ryu-app — scaffold a starter Ryu SDK project",
			"",
			"Usage:",
			"  bunx create-ryu-app <name>",
			"",
			"Arguments:",
			"  <name>   Project directory name (also used as the app id slug)",
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
 * Replace all occurrences of `__APP_NAME__` and `__APP_DISPLAY_NAME__` inside
 * a JSON file and write it back. Used to stamp the name into template files.
 */
function stampTemplate(
	filePath: string,
	slug: string,
	displayName: string
): void {
	const content = readFileSync(filePath, "utf8");
	const stamped = content
		.replaceAll("__APP_NAME__", slug)
		.replaceAll("__APP_DISPLAY_NAME__", displayName);
	writeFileSync(filePath, stamped, "utf8");
}

// ── scaffold ──────────────────────────────────────────────────────────────────

/**
 * Scaffold a new Ryu SDK project into `<outDir>/<name>`.
 *
 * Returns the absolute path to the created project directory.
 * Exported for use by the test suite (pass `outDir` = a tmp directory).
 */
export function scaffold(name: string, outDir: string): string {
	const slug = name.trim();
	if (!slug) {
		exitError("name must not be empty");
	}
	if (!RE_VALID_NAME.test(slug)) {
		exitError(
			"name must start with a letter or digit and contain only letters, digits, hyphens, and underscores"
		);
	}

	const projectDir = resolve(join(outDir, slug));
	if (existsSync(projectDir)) {
		exitError(`directory already exists: ${projectDir}`);
	}

	const templateDir = join(import.meta.dir, "template");
	if (!existsSync(templateDir)) {
		exitError(`template directory not found: ${templateDir}`);
	}

	// Copy the full template tree into the project directory.
	mkdirSync(projectDir, { recursive: true });
	cpSync(templateDir, projectDir, { recursive: true });

	const displayName = toDisplayName(slug);

	// Stamp the plugin.json template with the real name.
	stampTemplate(join(projectDir, "plugin.json"), slug, displayName);

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

	// Write the project package.json (not in template to keep it minimal there).
	const pkgJson = {
		name: slug,
		version: "0.1.0",
		type: "module",
		scripts: {
			dev: "bun run src/agent.ts",
			pack: "bunx ryu pack .",
		},
		dependencies: {
			"@ryuhq/sdk": "0.0.1",
		},
	};
	writeFileSync(
		join(projectDir, "package.json"),
		JSON.stringify(pkgJson, null, 2),
		"utf8"
	);

	return projectDir;
}

// ── main — only runs when invoked directly, not when imported by tests ────────

if (import.meta.main) {
	const [, , name, ...rest] = process.argv;

	if (!name || rest.length > 0) {
		printUsage();
		if (!name) {
			exitError("name argument is required");
		}
		exitError("too many arguments — expected exactly one <name>");
	}

	const created = scaffold(name, process.cwd());
	process.stdout.write(
		[
			"",
			`  created ${name}/`,
			"",
			"  next steps:",
			`    cd ${name}`,
			"    bun install",
			"    bun dev        # streams one turn via local gateway",
			"    bun run pack   # validate and bundle plugin.json",
			"",
		].join("\n")
	);
	process.stdout.write(`  project: ${created}\n\n`);
}
