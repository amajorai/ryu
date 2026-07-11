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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commandDev } from "./cli/dev.ts";
import { PluginManifestSchema } from "./manifest.ts";

// Lower-case hex `sha256(utf8_bytes(code))`. This is the EXACT encoding Core
// recomputes on install (`hex::encode(Sha256::digest(utf8))`), so the hash written
// into the signed manifest verifies byte-for-byte on the Rust side. The `code`
// passed here MUST be the same UTF-8 string stored/served/fetched, so the two ends
// hash identical bytes (never re-minify between pack/publish and install).
function uiCodeSha256(code: string): string {
	return createHash("sha256").update(code, "utf8").digest("hex");
}

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

// Resolve the plugin's sandboxed-UI entry module — the source `ryu pack` bundles
// into `ui_code`. Two authoring shapes carry one:
//   1. A `companion` runnable's `config.ui_entry` (companion surface plugins).
//   2. A Ryu App's `contributes.widgets[].ui_entry` (widget apps via `defineApp`).
// Companion runnables take precedence; the first non-empty entry wins. Returns
// null for a manifest-only plugin (no bundled UI) so packing stays
// backward-compatible in that case.
function resolveUiEntry(manifest: LoadedManifest): string | null {
	for (const runnable of manifest.runnables) {
		if (runnable.kind !== "companion") {
			continue;
		}
		const entry = (runnable.config as Record<string, unknown> | undefined)
			?.ui_entry;
		if (typeof entry === "string" && entry.trim().length > 0) {
			return entry;
		}
	}
	for (const widget of manifest.contributes?.widgets ?? []) {
		const entry = widget.ui_entry;
		if (typeof entry === "string" && entry.trim().length > 0) {
			return entry;
		}
	}
	return null;
}

// Resolve a companion's `ui_format` discriminator. `"html"` (Path B) means the
// `ui_entry` file is ALREADY a self-contained HTML document (a
// vite-plugin-singlefile build for a heavy app like the whiteboard) and must be
// shipped VERBATIM as `ui_code` — NOT run through `Bun.build`, which would try to
// bundle an HTML file as an ESM entry and fail. Anything else (absent / `"js"`) is
// the default: `ui_entry` is an ESM module `Bun.build` bundles into `ui_code`.
function resolveUiFormat(manifest: LoadedManifest): "html" | "js" {
	for (const runnable of manifest.runnables) {
		if (runnable.kind !== "companion") {
			continue;
		}
		const fmt = (runnable.config as Record<string, unknown> | undefined)
			?.ui_format;
		if (typeof fmt === "string" && fmt.trim().toLowerCase() === "html") {
			return "html";
		}
	}
	return "js";
}

// Read a Path B (`ui_format:"html"`) companion's prebuilt HTML entry verbatim. The
// file is the finished, self-contained document (CSS/JS/fonts already inlined by
// the singlefile bundler); `ryu pack` ships it as `ui_code` untouched so its
// sha256 matches byte-for-byte on install.
function readUiEntryHtml(dir: string, uiEntry: string): string {
	const entryPath = resolve(dir, uiEntry);
	if (!existsSync(entryPath)) {
		exitError(`companion ui_entry (html) not found: ${entryPath}`);
	}
	return readFileSync(entryPath, "utf8");
}

// Bundle the plugin's UI entry into ONE self-contained browser ESM module string.
// No external imports are emitted: the `RyuPlugin` API is INJECTED at runtime by
// the host bootstrap (the plugin calls `activate(context)`), not imported, so the
// bundle carries only the plugin's own code. Throws on a build error so `pack`
// fails loudly rather than emitting a half-built bundle.
async function bundleUiEntry(dir: string, uiEntry: string): Promise<string> {
	const entryPath = resolve(dir, uiEntry);
	if (!existsSync(entryPath)) {
		exitError(`companion ui_entry not found: ${entryPath}`);
	}
	const result = await Bun.build({
		entrypoints: [entryPath],
		target: "browser",
		format: "esm",
		minify: false,
	});
	if (!result.success) {
		const messages = result.logs.map((l) => String(l.message)).join("; ");
		exitError(`failed to bundle ui_entry '${uiEntry}': ${messages}`);
	}
	const output = result.outputs[0];
	if (!output) {
		exitError(`bundling ui_entry '${uiEntry}' produced no output`);
	}
	return await output.text();
}

async function commandPack(rawDir: string): Promise<void> {
	const dir = resolve(rawDir);
	const manifest = loadManifest(dir);

	// Bundle the companion UI entry, if any. Manifest-only plugins skip this and
	// emit exactly the previous shape (no `ui_code`). A `ui_format:"html"` companion
	// (Path B) ships its prebuilt HTML verbatim; otherwise the ESM entry is bundled.
	const uiEntry = resolveUiEntry(manifest);
	const uiCode = uiEntry
		? resolveUiFormat(manifest) === "html"
			? readUiEntryHtml(dir, uiEntry)
			: await bundleUiEntry(dir, uiEntry)
		: null;

	// Bind the bundled code to the manifest by its sha256. The hash goes INTO the
	// manifest (the surface Core signs on publish, and the corruption self-check on
	// local install-bundle reads); the `ui_code` blob rides alongside as payload.
	const manifestWithHash = uiCode
		? { ...manifest, ui_code_sha256: uiCodeSha256(uiCode) }
		: manifest;

	// Emit bundle into <dir>/dist/plugin.bundle.json
	const outDir = join(dir, "dist");
	if (!existsSync(outDir)) {
		mkdirSync(outDir, { recursive: true });
	}
	const outPath = join(outDir, "plugin.bundle.json");
	const bundle = uiCode
		? { ...manifestWithHash, ui_code: uiCode }
		: manifestWithHash;
	writeFileSync(outPath, JSON.stringify(bundle, null, 2), "utf8");

	const codeNote = uiCode ? ` (+${uiCode.length}B ui_code)` : "";
	process.stdout.write(
		`packed ${manifest.id}@${manifest.version}${codeNote} → ${outPath}\n`
	);
}

// ── publish command ─────────────────────────────────────────────────────────

const TRAILING_SLASHES = /\/+$/;

// Resolve the publish base URL: env override, else the dev control-plane server.
function publishBaseUrl(): string {
	const raw = (process.env.RYU_MARKETPLACE_API_URL ?? "").trim();
	return (raw || "http://localhost:3000").replace(TRAILING_SLASHES, "");
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

	// Compute the carriage payload the SAME way `pack` does — bundle the companion
	// UI entry and hash it INLINE (never depend on a possibly-stale dist/). The
	// hash is injected into the manifest object BEFORE it is sent for signing, so
	// the Gateway signs a manifest that already binds the code; the `ui_code` blob
	// is sent as a sibling (unsigned payload, integrity via the signed hash).
	const uiEntry = resolveUiEntry(manifest);
	const uiCode = uiEntry
		? resolveUiFormat(manifest) === "html"
			? readUiEntryHtml(dir, uiEntry)
			: await bundleUiEntry(dir, uiEntry)
		: null;
	const manifestWithHash = uiCode
		? { ...manifest, ui_code_sha256: uiCodeSha256(uiCode) }
		: manifest;

	// Phase 1.5 rich listing metadata forwarded FLAT into the publish body (not
	// inside the signed manifest blob) so the control plane stores + serves it on
	// detail. Each field is only sent when the author declared it. `developer`
	// resolves the Claude-style `author` (string or `{name}`); `website` maps from
	// the Claude `homepage`; the DISPLAY `runnables` array is derived from the
	// manifest's authored runnables (id/name/kind) with a default enabled state.
	const developer =
		typeof manifest.author === "string"
			? manifest.author
			: manifest.author?.name;
	const runnablesForDisplay = manifest.runnables.map((r) => ({
		id: r.id,
		kind: r.kind,
		name: r.name,
		enabled: true,
	}));
	const listingMetadata = {
		...(manifest.description ? { description: manifest.description } : {}),
		...(manifest.tagline ? { tagline: manifest.tagline } : {}),
		...(developer ? { developer } : {}),
		...(manifest.category ? { category: manifest.category } : {}),
		...(manifest.iconUrl ? { iconUrl: manifest.iconUrl } : {}),
		...(manifest.screenshots?.length
			? { screenshots: manifest.screenshots }
			: {}),
		...(manifest.homepage ? { website: manifest.homepage } : {}),
		...(manifest.privacyPolicyUrl
			? { privacyPolicyUrl: manifest.privacyPolicyUrl }
			: {}),
		...(manifest.termsOfServiceUrl
			? { termsOfServiceUrl: manifest.termsOfServiceUrl }
			: {}),
		...(manifest.capabilities?.length
			? { capabilities: manifest.capabilities }
			: {}),
		...(manifest.examplePrompts?.length
			? { examplePrompts: manifest.examplePrompts }
			: {}),
		...(manifest.setup ? { setup: manifest.setup } : {}),
		...(runnablesForDisplay.length ? { runnables: runnablesForDisplay } : {}),
	};

	const url = `${publishBaseUrl()}/api/marketplace/publish`;
	const body = {
		id: manifest.id,
		kind,
		name: manifest.name,
		version: manifest.version,
		manifest: manifestWithHash,
		// The descriptor is the manifest itself for a plugin/skill Plugin; Core maps
		// it on install. Grants are read from the manifest server-side too.
		descriptor: manifestWithHash,
		grants: manifest.permission_grants ?? [],
		// Rich listing metadata (Phase 1.5) forwarded flat; see above.
		...listingMetadata,
		// Per-item affiliate terms (optional): the commission a referrer earns when
		// a referred user buys this paid item. The server re-validates the rule and
		// stores it as the item's override (else the seller default applies).
		...(manifest.affiliate?.enabled ? { affiliate: manifest.affiliate } : {}),
		// The bundled UI code rides OUTSIDE the signed manifest as payload; the
		// server stores it and serves it on detail. Omitted for manifest-only.
		...(uiCode ? { ui_code: uiCode } : {}),
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
	commandPack(dir).catch((err: unknown) => {
		exitError(String(err));
	});
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
