// `ryu-cli secrets scan install-hook | uninstall-hook`: a git pre-commit hook
// that runs `ryu-cli secrets scan --staged`.
//
// The hooks directory comes from `git rev-parse --git-path hooks`, which
// honours `core.hooksPath` and linked worktrees. An existing hook is never
// replaced: without `--force` the install refuses; with it the old hook moves
// aside and runs first. Husky owns its hooks directory (it regenerates it), so
// for a husky repository the command prints the line to add instead.

import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tf } from "../i18n/translate.ts";
import { gitText, gitWorkingDirectory } from "./secrets-scan-git.ts";
import type { CliContext } from "./types.ts";

export const HOOK_MARKER =
	"# ryu-secrets-scan: installed by `ryu-cli secrets scan install-hook`";
export const HOOK_COMMAND = "ryu-cli secrets scan --staged";
/** Where `--force` keeps the hook it displaced; the new hook runs it first. */
export const CHAINED_HOOK_NAME = "pre-commit.ryu-previous";
const HUSKY_DIRECTORY = ".husky";
const HOOK_PATH_SEPARATORS = /[\\/]/;

/** The pre-commit hook body. Fail-closed: a missing `ryu-cli` blocks too. */
export function hookScript(chained: boolean): string {
	const lines = [
		"#!/bin/sh",
		HOOK_MARKER,
		"# Blocks the commit when staged content holds a credential (exit 1) or",
		"# when the scan cannot run (exit 3). RYU_SECRETS_SCAN_ALLOW_OFFLINE=1 lets",
		"# a commit through while Core is unreachable.",
	];
	if (chained) {
		lines.push(`"$(dirname "$0")/${CHAINED_HOOK_NAME}" "$@" || exit $?`);
	}
	lines.push(
		"if ! command -v ryu-cli >/dev/null 2>&1; then",
		'\techo "ryu-secrets-scan: ryu-cli is not on PATH, so staged files were not scanned." >&2',
		'\tif [ "$RYU_SECRETS_SCAN_ALLOW_OFFLINE" = "1" ]; then exit 0; fi',
		"\texit 3",
		"fi",
		`exec ${HOOK_COMMAND}`,
		""
	);
	return lines.join("\n");
}

interface HookLocation {
	/** The configured `core.hooksPath`, or null. */
	configured: string | null;
	hookFile: string;
	hooksDirectory: string;
	/** The husky directory when husky manages the hooks, else null. */
	huskyDirectory: string | null;
}

/** The `.husky` directory a hooks path sits in (`.husky` or `.husky/_`). */
export function huskyDirectoryOf(hooksDirectory: string): string | null {
	// Git reports hook paths with `/` even on Windows, so split on either separator.
	const parts = hooksDirectory.split(HOOK_PATH_SEPARATORS);
	const index = parts.lastIndexOf(HUSKY_DIRECTORY);
	if (index === -1) {
		return null;
	}
	let end = 0;
	for (const part of parts.slice(0, index + 1)) {
		end += part.length + 1;
	}
	return hooksDirectory.slice(0, end - 1);
}

async function hookLocation(ctx: CliContext): Promise<HookLocation> {
	const hooksDirectory = resolve(
		gitWorkingDirectory(ctx),
		await gitText(ctx, ["rev-parse", "--git-path", "hooks"])
	);
	let configured: string | null = null;
	try {
		configured =
			(await gitText(ctx, ["config", "--get", "core.hooksPath"])) || null;
	} catch {
		// Unset: `git config --get` exits 1.
	}
	return {
		configured,
		hookFile: join(hooksDirectory, "pre-commit"),
		hooksDirectory,
		huskyDirectory: configured ? huskyDirectoryOf(hooksDirectory) : null,
	};
}

async function readIfPresent(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function writeHook(path: string, content: string): Promise<void> {
	await writeFile(path, content, { mode: 0o755 });
	await chmod(path, 0o755);
}

async function huskyInstructions(
	ctx: CliContext,
	location: HookLocation,
	husky: string,
	installing: boolean
): Promise<number> {
	const file = join(husky, "pre-commit");
	const wired = (await readIfPresent(file))?.includes(HOOK_COMMAND) ?? false;
	if (installing && wired) {
		ctx.io.out(`${tf("{file} already runs the secret scan.", { file })}\n`);
		return 0;
	}
	if (!(installing || wired)) {
		ctx.io.out(
			`${tf("No pre-commit hook is installed at {path}.", { path: file })}\n`
		);
		return 0;
	}
	const values = {
		hooksPath: location.configured ?? "",
		file,
		line: HOOK_COMMAND,
	};
	ctx.io.err(
		`${
			installing
				? tf(
						"Husky manages this repository's hooks (core.hooksPath={hooksPath}), so nothing was written. Add this line to {file}: {line}",
						values
					)
				: tf(
						"Husky manages this repository's hooks (core.hooksPath={hooksPath}), so nothing was removed. Remove this line from {file}: {line}",
						values
					)
		}\n`
	);
	return 1;
}

export async function installHook(ctx: CliContext): Promise<number> {
	const location = await hookLocation(ctx);
	if (location.huskyDirectory) {
		return huskyInstructions(ctx, location, location.huskyDirectory, true);
	}
	const path = location.hookFile;
	const chainedPath = join(location.hooksDirectory, CHAINED_HOOK_NAME);
	const existing = await readIfPresent(path);
	if (existing?.includes(HOOK_MARKER)) {
		const current = hookScript(existsSync(chainedPath));
		if (existing !== current) {
			await writeHook(path, current);
		}
		ctx.io.out(
			`${tf("The pre-commit hook at {path} is already installed.", { path })}\n`
		);
		return 0;
	}
	await mkdir(location.hooksDirectory, { recursive: true });
	if (existing === null) {
		await writeHook(path, hookScript(false));
		ctx.io.out(`${tf("Installed the pre-commit hook at {path}.", { path })}\n`);
		return 0;
	}
	if (!ctx.flags.force || existsSync(chainedPath)) {
		ctx.io.err(
			`${tf("Refusing to replace the existing pre-commit hook at {path}. Pass --force to keep it and run it before the secret scan, or add this line to it: {line}", { path, line: HOOK_COMMAND })}\n`
		);
		return 1;
	}
	await rename(path, chainedPath);
	await writeHook(path, hookScript(true));
	ctx.io.out(
		`${tf("Installed the pre-commit hook at {path}; the previous hook moved to {chained} and runs first.", { path, chained: chainedPath })}\n`
	);
	return 0;
}

export async function uninstallHook(ctx: CliContext): Promise<number> {
	const location = await hookLocation(ctx);
	if (location.huskyDirectory) {
		return huskyInstructions(ctx, location, location.huskyDirectory, false);
	}
	const path = location.hookFile;
	const chainedPath = join(location.hooksDirectory, CHAINED_HOOK_NAME);
	const existing = await readIfPresent(path);
	if (existing === null) {
		ctx.io.out(
			`${tf("No pre-commit hook is installed at {path}.", { path })}\n`
		);
		return 0;
	}
	if (!existing.includes(HOOK_MARKER)) {
		ctx.io.err(
			`${tf("The pre-commit hook at {path} was not installed by ryu-cli; leaving it in place.", { path })}\n`
		);
		return 1;
	}
	if (existsSync(chainedPath)) {
		await rename(chainedPath, path);
		ctx.io.out(
			`${tf("Removed the secret-scan hook at {path} and restored the previous hook.", { path })}\n`
		);
		return 0;
	}
	await rm(path);
	ctx.io.out(`${tf("Removed the pre-commit hook at {path}.", { path })}\n`);
	return 0;
}
