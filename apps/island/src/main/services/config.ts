// Main-process configuration for the Core and Shadow service clients.
//
// Core (:7980) defaults to the local sidecar but is user-repointable at a remote
// node — compute is swappable across nodes. Shadow (:3030) is NOT: it captures
// THIS physical machine's screen/input/OCR, so it is permanently pinned to the
// local sidecar. Any persisted or patched `shadowBaseUrl` is ignored (see
// `normalize` / `saveSettings`) — repointing it would surface a remote/headless
// box's activity in your companion as if it were yours. An optional bearer token
// (Core's `RYU_TOKEN`) is attached to every Core request when present. Settings
// persist as JSON under Electron's `userData` directory.
//
// Token custody: only a token the user configured explicitly is persisted, and
// only sealed with Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux
// libsecret/kwallet) as `coreTokenSealed`. An inherited `RYU_TOKEN` and the local
// node token Core minted are resolved at runtime and never written here. Where
// `safeStorage` has no real OS backend (Linux `basic_text`) the explicit token
// lives in memory for the session only. The file is written owner-only (0600).
// Files from older builds that hold a plaintext `coreToken` are migrated on load.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_JWT_HEADER } from "@ryuhq/core-client/client";
import { ryuHomeDir, serviceDir } from "@ryuhq/core-client/data-dir";
import { resolveLocalNodeToken } from "@ryuhq/core-client/node-token";
// A namespace import: `safeStorage` is optional in test doubles of electron.
import * as electron from "electron";
import type {
	EngineSettings,
	IslandSettings,
	IslandSettingsPatch,
} from "../../shared/ipc.ts";
import { parseStoredServiceConfig } from "./config-contract.ts";
import {
	currentIslandUserJwt,
	identityBrokerFor,
	startIslandIdentity,
} from "./identity.ts";

/** Persisted service configuration. */
export interface IslandServiceConfig {
	/** Core base URL, no trailing slash. */
	coreBaseUrl: string;
	/** Optional bearer token sent to Core as `Authorization: Bearer <token>`. */
	coreToken: string | null;
	/** Proactive-engine tunables (cadence + cooldown). */
	engine: EngineSettings;
	/** Shadow base URL, no trailing slash. */
	shadowBaseUrl: string;
}

/** Default cadence/cooldown for the proactive engine. */
const DEFAULT_ENGINE: EngineSettings = {
	pollIntervalSeconds: 15,
	cooldownSeconds: 120,
};

// Profile-aware defaults: under RYU_PROFILE=dev (the repo's `bun dev` default)
// every backend port shifts +1000 (Core :8980, Shadow :4030), matching
// apps/core/src/profile.rs. Release stays byte-identical to the old values. The
// dev island has its own userData dir (distinct branding in index.ts), so the
// persisted island-services.json never bleeds between profiles.
const IS_DEV_PROFILE = (() => {
	const profile = (process.env.RYU_PROFILE ?? "").trim().toLowerCase();
	return profile !== "" && profile !== "release";
})();

const DEFAULT_CONFIG: IslandServiceConfig = {
	coreBaseUrl: IS_DEV_PROFILE
		? "http://127.0.0.1:8980"
		: "http://127.0.0.1:7980",
	shadowBaseUrl: IS_DEV_PROFILE
		? "http://127.0.0.1:4030"
		: "http://127.0.0.1:3030",
	coreToken: null,
	engine: DEFAULT_ENGINE,
};

/** Clamp a numeric setting to a sane positive range, falling back on NaN. */
function clampSeconds(value: number | undefined, fallback: number): number {
	if (value === undefined || Number.isNaN(value) || value <= 0) {
		return fallback;
	}
	return Math.min(Math.round(value), 3600);
}

const CONFIG_FILE = "island-services.json";

/** Trailing slashes to strip from a base URL. */
const TRAILING_SLASHES = /\/+$/;

let cached: IslandServiceConfig | null = null;
/** The user's explicitly configured token (persisted sealed), if any. */
let explicitToken: string | null = null;
/** A sealed token read before `safeStorage` was ready; opened on a later load. */
let pendingSealedToken: string | null = null;
/**
 * The sealed token string currently on disk. Carried forward by every persist
 * so a save made while `safeStorage` cannot open or seal it (no keyring, a
 * denied keychain prompt) does not delete the configured token.
 */
let storedSealedToken: string | null = null;
/** Placeholder `getSettings` returns instead of a stored token. */
export const REDACTED_TOKEN = "••••••";
const PLACEHOLDER = /^[•*]+$/;
let coreGeneration = 0;
const coreChangeListeners = new Set<() => void>();
export function onCoreConfigChange(listener: () => void): () => void {
	coreChangeListeners.add(listener);
	return () => {
		coreChangeListeners.delete(listener);
	};
}

/** Executable UI bundles belong to one Core source and credential generation. */
export function coreConfigGeneration(): number {
	loadConfig();
	return coreGeneration;
}

function configPath(): string {
	return join(electron.app.getPath("userData"), CONFIG_FILE);
}

function stripTrailingSlash(url: string): string {
	return url.replace(TRAILING_SLASHES, "");
}

function normalizeEngine(
	partial: Partial<EngineSettings> | undefined
): EngineSettings {
	return {
		pollIntervalSeconds: clampSeconds(
			partial?.pollIntervalSeconds,
			DEFAULT_ENGINE.pollIntervalSeconds
		),
		cooldownSeconds: clampSeconds(
			partial?.cooldownSeconds,
			DEFAULT_ENGINE.cooldownSeconds
		),
	};
}

/** True only when `safeStorage` encrypts with a real OS-held key. */
function sealingAvailable(): boolean {
	const { safeStorage } = electron;
	try {
		if (!safeStorage?.isEncryptionAvailable()) {
			return false;
		}
		// Linux `basic_text` uses a hardcoded key: that is not encryption.
		return (
			process.platform !== "linux" ||
			!["basic_text", "unknown"].includes(
				safeStorage.getSelectedStorageBackend()
			)
		);
	} catch {
		return false;
	}
}

function sealToken(token: string): string | null {
	if (!sealingAvailable()) {
		return null;
	}
	try {
		return electron.safeStorage.encryptString(token).toString("base64");
	} catch {
		return null;
	}
}

function openToken(sealed: string): string | null {
	try {
		return electron.safeStorage.decryptString(Buffer.from(sealed, "base64"));
	} catch {
		return null;
	}
}

/** The token sources that must never be persisted (env and Core's minted file). */
function runtimeToken(coreBaseUrl: string): string | null {
	return process.env.RYU_TOKEN ?? resolveLocalNodeToken(coreBaseUrl) ?? null;
}

/** Write the config without any plaintext token; fails closed on sealing. */
function persist(next: IslandServiceConfig): void {
	const freshlySealed = explicitToken ? sealToken(explicitToken) : null;
	if (freshlySealed) {
		storedSealedToken = freshlySealed;
	}
	const coreTokenSealed = freshlySealed ?? storedSealedToken;
	const stored = {
		coreBaseUrl: next.coreBaseUrl,
		engine: next.engine,
		...(coreTokenSealed ? { coreTokenSealed } : {}),
	};
	try {
		const path = configPath();
		writeFileSync(path, JSON.stringify(stored, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		// `mode` applies only when the file is created; tighten older files too.
		chmodSync(path, 0o600);
	} catch {
		// Best-effort persistence; keep the in-memory value regardless.
	}
}

function normalize(
	partial: ReturnType<typeof parseStoredServiceConfig>
): IslandServiceConfig {
	// `resolveLocalNodeToken` is the last resort, after an explicitly configured
	// token and an inherited `RYU_TOKEN`. Core authenticates its local API by
	// default now, and the island is its own Electron process rather than a child
	// of Core — so without the file fallback it inherits nothing and every Core
	// call 401s.
	//
	// The resolved base URL is passed so the MINTED token can only be sent to a
	// local Core: `coreBaseUrl` is persisted config and patchable over IPC, so
	// without the gate a redirected island would ship this machine's node secret
	// to whatever host it was pointed at.
	const resolvedCoreBaseUrl = stripTrailingSlash(
		partial.coreBaseUrl ?? DEFAULT_CONFIG.coreBaseUrl
	);
	const coreToken = explicitToken ?? runtimeToken(resolvedCoreBaseUrl);
	return {
		coreBaseUrl: resolvedCoreBaseUrl,
		// Device-bound: never honour an override. Shadow always points at the
		// local sidecar regardless of what was persisted or patched in.
		shadowBaseUrl: DEFAULT_CONFIG.shadowBaseUrl,
		coreToken: coreToken && coreToken.length > 0 ? coreToken : null,
		engine: normalizeEngine(partial.engine),
	};
}

/** Load the persisted config, falling back to defaults on any read error. */
export function loadConfig(): IslandServiceConfig {
	if (cached) {
		if (pendingSealedToken && sealingAvailable()) {
			openPendingToken(cached);
		}
		return cached;
	}
	let parsed: ReturnType<typeof parseStoredServiceConfig> = {};
	try {
		const path = configPath();
		if (existsSync(path)) {
			parsed = parseStoredServiceConfig(readFileSync(path, "utf8"));
		}
	} catch {
		// Corrupt or unreadable file: fall back to defaults.
		parsed = {};
	}
	const baseUrl = stripTrailingSlash(
		parsed.coreBaseUrl ?? DEFAULT_CONFIG.coreBaseUrl
	);
	let migrate = false;
	if (parsed.coreTokenSealed) {
		// Kept even when it cannot be opened now, so a later save does not
		// delete a token that a working keyring could still open.
		storedSealedToken = parsed.coreTokenSealed;
		if (sealingAvailable()) {
			explicitToken = openToken(parsed.coreTokenSealed);
		} else {
			pendingSealedToken = parsed.coreTokenSealed;
		}
	} else if (parsed.coreToken) {
		// An older build persisted whichever token it resolved, so a copy of the
		// inherited env token or Core's minted token may sit here in plaintext.
		// Keep only a token that came from neither, and rewrite the file sealed.
		explicitToken =
			parsed.coreToken === runtimeToken(baseUrl) ? null : parsed.coreToken;
		// Rewrite now only if the token can be sealed (or there is none to keep).
		// Until then the file is left as it is; a save made while sealing is
		// still unavailable rewrites it without the plaintext token, and the
		// token then lives in memory for this session only.
		migrate = explicitToken === null || sealingAvailable();
	}
	cached = normalize(parsed);
	if (migrate) {
		persist(cached);
	}
	return cached;
}

/** Open a sealed token that was read before `safeStorage` became ready. */
function openPendingToken(current: IslandServiceConfig): void {
	const sealed = pendingSealedToken;
	pendingSealedToken = null;
	explicitToken = sealed ? openToken(sealed) : null;
	const next = normalize(current);
	cached = next;
	if (next.coreToken !== current.coreToken) {
		coreGeneration += 1;
		for (const listener of coreChangeListeners) {
			listener();
		}
	}
}

/** Merge and persist a config patch, returning the updated config. */
export function saveConfig(
	patch: Partial<IslandServiceConfig>
): IslandServiceConfig {
	const current = loadConfig();
	if (patch.coreToken !== undefined) {
		// An explicit patch replaces the configured token (null clears it, and the
		// runtime sources take over again).
		explicitToken =
			patch.coreToken && patch.coreToken.length > 0 ? patch.coreToken : null;
		pendingSealedToken = null;
		storedSealedToken = null;
	}
	const next = normalize({
		coreBaseUrl: patch.coreBaseUrl ?? current.coreBaseUrl,
		engine: patch.engine ?? current.engine,
	});
	if (
		next.coreBaseUrl !== current.coreBaseUrl ||
		next.coreToken !== current.coreToken
	) {
		coreGeneration += 1;
	}
	persist(next);
	cached = next;
	if (
		next.coreBaseUrl !== current.coreBaseUrl ||
		next.coreToken !== current.coreToken
	) {
		for (const listener of coreChangeListeners) {
			listener();
		}
	}
	return next;
}

/** Project the persisted config onto the renderer-facing settings surface. */
export function getSettings(): IslandSettings {
	const cfg = loadConfig();
	return {
		coreBaseUrl: cfg.coreBaseUrl,
		shadowBaseUrl: cfg.shadowBaseUrl,
		// The renderer never receives a stored token, only whether one is set.
		coreToken: explicitToken ? REDACTED_TOKEN : null,
		engine: { ...cfg.engine },
	};
}

/**
 * Apply a settings patch from the renderer. Engine tunables merge field-by-field
 * (a partial `engine` patch keeps untouched fields) before persistence.
 */
export function saveSettings(patch: IslandSettingsPatch): IslandSettings {
	const current = loadConfig();
	const configPatch: Partial<IslandServiceConfig> = {};
	if (patch.coreBaseUrl !== undefined) {
		configPatch.coreBaseUrl = patch.coreBaseUrl;
	}
	// `shadowBaseUrl` is intentionally NOT patchable: Shadow is device-bound and
	// stays pinned to the local sidecar (see the file header + `normalize`).
	// Echoing the redacted placeholder back keeps the stored token.
	if (
		patch.coreToken !== undefined &&
		!(patch.coreToken && PLACEHOLDER.test(patch.coreToken))
	) {
		configPatch.coreToken = patch.coreToken;
	}
	if (patch.engine) {
		configPatch.engine = { ...current.engine, ...patch.engine };
	}
	saveConfig(configPatch);
	if (patch.coreBaseUrl !== undefined || configPatch.coreToken !== undefined) {
		refreshCoreIdentity();
	}
	return getSettings();
}

/** Build the headers Core expects, including the bearer token when set.
 *
 * `X-Ryu-Surface` identifies this client as the island so Core can filter plugin
 * listings and contributions to the ones that declare island support. Without it
 * Core sees an unknown caller and — correctly, since an unknown caller must never
 * be filtered to nothing — returns the UNFILTERED set, so the island was showing
 * plugins that explicitly do not support it. Mirrors the desktop's
 * `identityHeaders()` and the mobile/cli/web clients. */
interface CoreRequestHeaders {
	Accept: string;
	"X-Ryu-Surface": string;
	[header: string]: string;
}

export function coreHeaders(
	extra?: Record<string, string>
): CoreRequestHeaders {
	const cfg = loadConfig();
	const headers: CoreRequestHeaders = {
		Accept: "application/json",
		"X-Ryu-Surface": "island",
		...extra,
	};
	if (cfg.coreToken) {
		headers.Authorization = `Bearer ${cfg.coreToken}`;
	}
	const userJwt = currentIslandUserJwt();
	if (userJwt) {
		headers[USER_JWT_HEADER] = userJwt;
	}
	return headers;
}

/** Start identifying the signed-in user to the configured Core. Call once at
 * startup and again whenever the Core target changes. */
export function refreshCoreIdentity(): void {
	const cfg = loadConfig();
	startIslandIdentity(
		identityBrokerFor({
			coreBaseUrl: cfg.coreBaseUrl,
			coreToken: cfg.coreToken,
			defaultCoreBaseUrl: DEFAULT_CONFIG.coreBaseUrl,
		})
	);
}

// ── Shadow API token ─────────────────────────────────────────────────────────
//
// Shadow's HTTP surface is bearer-gated (apps/shadow/src/server.rs: everything
// except /health requires a shared secret). The island runs its Shadow client
// in the MAIN process, so it can read the same persisted token Shadow resolves:
// SHADOW_API_TOKEN env first (operator override), then the token file Core
// mints/injects at Shadow spawn (`<data dir>/services/shadow/api-token`, with
// the data dir resolved like Core: `RYU_DIR` > Storage pointer > `~/.ryu<sfx>`).

/** The persisted Shadow token file. */
function shadowTokenPath(): string {
	return join(serviceDir(ryuHomeDir(), "shadow"), "api-token");
}

/** Cached token so the 15 s poll loop does not re-read the file every tick. */
let cachedShadowToken: string | null = null;

/**
 * Resolve the Shadow API bearer, or `null` when unavailable (the Shadow client
 * then sends nothing and degrades exactly like an absent Shadow). Successful
 * reads are cached; a miss re-resolves on the next call so a token minted after
 * island startup (first Shadow spawn) is picked up. The bearer is only ever
 * sent after Shadow proves it holds it (`shadow-peer-proof.ts`).
 */
export function shadowApiToken(): string | null {
	if (cachedShadowToken) {
		return cachedShadowToken;
	}
	const envToken = (process.env.SHADOW_API_TOKEN ?? "").trim();
	if (envToken) {
		cachedShadowToken = envToken;
		return cachedShadowToken;
	}
	const path = shadowTokenPath();
	try {
		if (!existsSync(path)) {
			return null;
		}
		const token = readFileSync(path, "utf8").trim();
		if (token) {
			cachedShadowToken = token;
			return cachedShadowToken;
		}
	} catch {
		// Unreadable token file — the client sends nothing and degrades.
	}
	return null;
}

/**
 * Drop the cached Shadow token so the next call re-reads it. Called when the
 * listener fails the peer proof: Core rotates the token file when it finds
 * Shadow's port held by another process, so a cached copy may be stale.
 */
export function forgetShadowApiToken(): void {
	cachedShadowToken = null;
}
