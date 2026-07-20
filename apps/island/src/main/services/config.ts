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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type {
	EngineSettings,
	IslandSettings,
	IslandSettingsPatch,
} from "../../shared/ipc.ts";

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
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
		return fallback;
	}
	return Math.min(Math.round(value), 3600);
}

const CONFIG_FILE = "island-services.json";

/** Trailing slashes to strip from a base URL. */
const TRAILING_SLASHES = /\/+$/;

let cached: IslandServiceConfig | null = null;

function configPath(): string {
	return join(app.getPath("userData"), CONFIG_FILE);
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

function normalize(partial: Partial<IslandServiceConfig>): IslandServiceConfig {
	const coreToken = partial.coreToken ?? process.env.RYU_TOKEN ?? null;
	return {
		coreBaseUrl: stripTrailingSlash(
			partial.coreBaseUrl ?? DEFAULT_CONFIG.coreBaseUrl
		),
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
		return cached;
	}
	let parsed: Partial<IslandServiceConfig> = {};
	try {
		const path = configPath();
		if (existsSync(path)) {
			parsed = JSON.parse(
				readFileSync(path, "utf8")
			) as Partial<IslandServiceConfig>;
		}
	} catch {
		// Corrupt or unreadable file: fall back to defaults.
		parsed = {};
	}
	cached = normalize(parsed);
	return cached;
}

/** Merge and persist a config patch, returning the updated config. */
export function saveConfig(
	patch: Partial<IslandServiceConfig>
): IslandServiceConfig {
	const next = normalize({ ...loadConfig(), ...patch });
	try {
		writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf8");
	} catch {
		// Best-effort persistence; keep the in-memory value regardless.
	}
	cached = next;
	return next;
}

/** Project the persisted config onto the renderer-facing settings surface. */
export function getSettings(): IslandSettings {
	const cfg = loadConfig();
	return {
		coreBaseUrl: cfg.coreBaseUrl,
		shadowBaseUrl: cfg.shadowBaseUrl,
		coreToken: cfg.coreToken,
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
	if (patch.coreToken !== undefined) {
		configPatch.coreToken = patch.coreToken;
	}
	if (patch.engine) {
		configPatch.engine = { ...current.engine, ...patch.engine };
	}
	saveConfig(configPatch);
	return getSettings();
}

/** Build the headers Core expects, including the bearer token when set. */
export function coreHeaders(
	extra?: Record<string, string>
): Record<string, string> {
	const cfg = loadConfig();
	const headers: Record<string, string> = {
		Accept: "application/json",
		...extra,
	};
	if (cfg.coreToken) {
		headers.Authorization = `Bearer ${cfg.coreToken}`;
	}
	return headers;
}
