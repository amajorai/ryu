#!/usr/bin/env bun
/**
 * `ryu` CLI — entry-point for the Ryu developer SDK command-line tool.
 *
 * Usage:
 *   bunx ryu pack <dir>
 *   bunx ryu publish <dir>
 *
 * Commands:
 *   pack <dir>      Validate the plugin.json in <dir> and emit a publish-ready
 *                   Plugin bundle at <dir>/dist/plugin.bundle.json.
 *                   Exits 0 on success; exits 1 with the failing field on error.
 *   publish <dir>   Validate the plugin.json and POST it to the Ryu Marketplace
 *                   publish endpoint with the author's auth token. The item is
 *                   stored as `pending` until a moderator approves it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commandDev } from "./cli/dev.ts";
import { PluginManifestSchema } from "./manifest.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function printUsage(): void {
	process.stderr.write(
		[
			"Ryu dev SDK",
			"",
			"Usage:",
			"  bunx ryu pack <dir>      Validate and bundle a plugin.json Plugin",
			"  bunx ryu publish <dir>   Validate and publish a plugin.json Plugin to the Ryu Marketplace",
			"  bunx ryu dev <entry>     Run a Runnable locally with an interactive chat loop",
			"",
		].join("\n")
	);
}

function exitError(message: string): never {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

// ── shared manifest loading ─────────────────────────────────────────────────

type LoadedManifest = ReturnType<typeof PluginManifestSchema.parse>;

// Read + parse + validate the plugin.json in `dir`. Exits with the failing
// field on any error. Shared by pack and publish so both validate identically.
function loadManifest(dir: string): LoadedManifest {
	const manifestPath = join(dir, "plugin.json");
	if (!existsSync(manifestPath)) {
		exitError(`plugin.json not found in: ${dir}`);
	}

	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch (err) {
		exitError(`could not read ${manifestPath}: ${String(err)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		exitError(`plugin.json is not valid JSON: ${manifestPath}`);
	}

	const result = PluginManifestSchema.safeParse(parsed);
	if (!result.success) {
		const first = result.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const message = first?.message ?? "validation failed";
		exitError(`plugin.json validation failed at '${field}': ${message}`);
	}
	return result.data;
}

// ── pack command ──────────────────────────────────────────────────────────────

function commandPack(rawDir: string): void {
	const dir = resolve(rawDir);
	const manifest = loadManifest(dir);

	// Emit bundle into <dir>/dist/plugin.bundle.json
	const outDir = join(dir, "dist");
	if (!existsSync(outDir)) {
		mkdirSync(outDir, { recursive: true });
	}
	const outPath = join(outDir, "plugin.bundle.json");
	writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf8");

	process.stdout.write(
		`packed ${manifest.id}@${manifest.version} → ${outPath}\n`
	);
}

// ── publish command ─────────────────────────────────────────────────────────

// Resolve the publish base URL: env override, else the dev control-plane server.
function publishBaseUrl(): string {
	const raw = (process.env.RYU_MARKETPLACE_API_URL ?? "").trim();
	return (raw || "http://localhost:3000").replace(/\/+$/, "");
}

// Resolve the author's auth token: env (RYU_AUTH_TOKEN), sent as a Bearer token
// the control plane's createContext accepts (Better Auth session JWT or OAuth
// access token). Never read from a committed file.
function authToken(): string {
	const token = (process.env.RYU_AUTH_TOKEN ?? "").trim();
	if (!token) {
		exitError(
			"publish requires an auth token: set RYU_AUTH_TOKEN to your Ryu access token"
		);
	}
	return token;
}

// An SDK-authored Plugin always publishes as a `plugin` (a plugin.json bundle of
// runnables). It is deliberately NOT published as `skill`: Core's skill install
// path needs a `descriptor.raw.install_source` (a from-source owner/repo), which
// a plugin.json manifest does not carry, so a skill-kind publish would be
// uninstallable. Model / mcp items are published through their own tools.
const SDK_PUBLISH_KIND = "plugin" as const;

async function commandPublish(rawDir: string): Promise<void> {
	const dir = resolve(rawDir);
	const manifest = loadManifest(dir);
	const token = authToken();
	const kind = SDK_PUBLISH_KIND;

	const url = `${publishBaseUrl()}/api/marketplace/publish`;
	const body = {
		id: manifest.id,
		kind,
		name: manifest.name,
		version: manifest.version,
		manifest,
		// The descriptor is the manifest itself for a plugin/skill Plugin; Core maps
		// it on install. Grants are read from the manifest server-side too.
		descriptor: manifest,
		grants: manifest.permission_grants ?? [],
	};

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitError(`could not reach ${url}: ${String(err)}`);
	}

	const text = await resp.text();
	if (!resp.ok) {
		exitError(`publish failed (${resp.status}): ${text}`);
	}
	process.stdout.write(
		`published ${manifest.id}@${manifest.version} (${kind}) → pending moderation\n${text}\n`
	);
}

// ── main ──────────────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;

if (!command) {
	printUsage();
	process.exit(1);
}

if (command === "pack") {
	const dir = args[0];
	if (!dir) {
		exitError("pack requires a directory argument: bunx ryu pack <dir>");
	}
	commandPack(dir);
} else if (command === "publish") {
	const dir = args[0];
	if (!dir) {
		exitError("publish requires a directory argument: bunx ryu publish <dir>");
	}
	commandPublish(dir).catch((err: unknown) => {
		exitError(String(err));
	});
} else if (command === "dev") {
	const entry = args[0];
	if (!entry) {
		exitError("dev requires an entry argument: bunx ryu dev <entry>");
	}
	commandDev(entry).catch((err: unknown) => {
		exitError(String(err));
	});
} else {
	printUsage();
	exitError(`unknown command: ${command}`);
}
