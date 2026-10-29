// Resolve the Ryu data directory and the files local surfaces share with Core.
//
// Mirrors `crates/core/runtime-install/src/data_paths.rs` (resolution) and
// `crates/core/sidecar-runtime/src/layout.rs` (what lives where under the
// root). Resolution order, identical to Core:
//
//   1. `RYU_DIR` — the explicit relocation override (non-empty).
//   2. The Storage pointer `<os config>/ryu<sfx>/data-path.json` (`data_dir`).
//   3. The profile default `~/.ryu<sfx>` (`""` for release, `-<profile>` else).
//
// NODE-ONLY. This imports `node:fs`/`node:os` and must never be pulled into a
// browser bundle.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RELEASE_PROFILE = "release";

/** The environment slice the resolver reads. */
export type DataDirEnvironment = Readonly<Record<string, string | undefined>>;

/** The active profile name (`RYU_PROFILE`, lowercased; unset → release). */
export function ryuProfile(env: DataDirEnvironment = process.env): string {
	return (env.RYU_PROFILE ?? "").trim().toLowerCase() || RELEASE_PROFILE;
}

/** Data/config dir suffix: `""` for release, `-<profile>` otherwise. */
export function profileSuffix(profile: string): string {
	return profile === RELEASE_PROFILE ? "" : `-${profile}`;
}

/**
 * The OS config dir, matching Rust's `dirs::config_dir()`: `%APPDATA%` on
 * Windows, `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` (else
 * `~/.config`) elsewhere.
 */
export function osConfigDir(
	env: DataDirEnvironment = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir()
): string {
	if (platform === "win32") {
		return env.APPDATA?.trim() || join(home, "AppData", "Roaming");
	}
	if (platform === "darwin") {
		return join(home, "Library", "Application Support");
	}
	const xdg = env.XDG_CONFIG_HOME?.trim();
	return xdg?.startsWith("/") ? xdg : join(home, ".config");
}

/** `<os config>/ryu<sfx>/data-path.json` — the Storage relocation pointer. */
export function dataPathPointerFile(
	env: DataDirEnvironment = process.env,
	home: string = homedir()
): string {
	return join(
		osConfigDir(env, process.platform, home),
		`ryu${profileSuffix(ryuProfile(env))}`,
		"data-path.json"
	);
}

function readPointer(path: string): string | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "data_dir" in parsed) {
			const dir = (parsed as { data_dir?: unknown }).data_dir;
			if (typeof dir === "string" && dir.trim() !== "") {
				return dir;
			}
		}
	} catch {
		// A corrupt pointer makes Core refuse to start; a client falls back to
		// the profile default instead of guessing a third location.
	}
	return null;
}

/**
 * The Ryu data directory, resolved exactly like Core:
 * `RYU_DIR` > Storage pointer > `~/.ryu<sfx>`. `home` is the user home the
 * profile default and config dir hang off (defaults to `os.homedir()`).
 */
export function ryuHomeDir(
	env: DataDirEnvironment = process.env,
	home: string = homedir()
): string {
	const explicit = env.RYU_DIR?.trim();
	if (explicit) {
		return explicit;
	}
	const pointed = readPointer(dataPathPointerFile(env, home));
	if (pointed) {
		return pointed;
	}
	return join(home, `.ryu${profileSuffix(ryuProfile(env))}`);
}

// ── Layout (mirror of crates/core/sidecar-runtime/src/layout.rs) ─────────────

/** `<root>/state/<rel>` — Core JSON state (e.g. `nodes.json`). */
export function statePath(root: string, ...rel: string[]): string {
	return join(root, "state", ...rel);
}

/** `<root>/secrets/<file>` — a key, token or credential file. */
export function secretPath(root: string, file: string): string {
	return join(root, "secrets", file);
}

/** `<root>/logs/<file>`. */
export function logPath(root: string, file: string): string {
	return join(root, "logs", file);
}

/** `<root>/bin` — Core/Gateway runtime and small standalone tools. */
export function binDir(root: string): string {
	return join(root, "bin");
}

/** `<root>/plugins` — installed plugin packages. */
export function pluginsDir(root: string): string {
	return join(root, "plugins");
}

/** `<root>/services/<name>` — first-party service state (shadow, ghost, …). */
export function serviceDir(root: string, name: string): string {
	return join(root, "services", name);
}

/** `<root>/plugin-data/<id with / → +>` — one plugin's/app's own data. */
export function pluginDataDir(root: string, pluginId: string): string {
	return join(root, "plugin-data", pluginId.replaceAll("/", "+"));
}
