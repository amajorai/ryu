// apps/desktop/src/lib/api/update.ts
//
// Typed client for Core's unified update service (`/api/version`,
// `/api/update/check`). Core is the single source of truth for the update
// *verdict* and the shared *auto-update toggle* (stored in the cross-surface
// preferences KV, so the same setting governs every surface). The actual
// install on desktop is performed by tauri-plugin-updater — but whether to
// surface the toast, and whether to auto-install, is decided from Core's verdict
// + this setting, so all surfaces stay consistent.

import { type ApiTarget, request } from "./client.ts";
import { getPreference, setPreference } from "./preferences.ts";

/** Matches Core's `update::ComponentVersion`. */
export interface ComponentVersion {
	name: string;
	version: string;
}

/** Matches Core's `update::VersionInfo` (`GET /api/version`). */
export interface VersionInfo {
	components: ComponentVersion[];
	platform: string;
	ryu_version: string;
}

/** Matches Core's `update::ReleaseAsset`. */
export interface ReleaseAsset {
	kind: string;
	name: string;
	size: number;
	url: string;
}

/** Matches Core's `update::UpdateCheck` (`GET /api/update/check`). */
export interface UpdateCheck {
	asset: ReleaseAsset | null;
	current: string;
	html_url: string | null;
	latest: string;
	notes: string | null;
	update_available: boolean;
}

/** Read the installed Ryu version + per-component builds. */
export function getVersionInfo(target: ApiTarget): Promise<VersionInfo> {
	return request<VersionInfo>(target, "/api/version");
}

/**
 * Ask Core whether an update is available. Fails soft: on any error returns a
 * "no update" verdict so a flaky check never blocks the UI.
 */
export async function checkForUpdate(target: ApiTarget): Promise<UpdateCheck> {
	try {
		return await request<UpdateCheck>(target, "/api/update/check");
	} catch {
		return {
			current: "",
			latest: "",
			update_available: false,
			notes: null,
			html_url: null,
			asset: null,
		};
	}
}

// --- Forced updates (build-time policy) -------------------------------------
//
// While true, the desktop installs an available update on every launch,
// IGNORING the user's auto-update toggle. This is deliberate: Ryu is free during
// the beta (see `betaFree` in @ryu/auth/lib/plans), and when it becomes paid the
// switch ships as a release — forced updates guarantee nobody can sit on an old,
// still-free build past that point. The toggle below remains the source of truth
// for *non-forced* behaviour, so flipping this back to false restores user
// control without any other change.
//
// Forcing never hard-blocks the shell: if the signed updater feed is unreachable
// (unsigned/dev builds), the installer degrades to a manual-download toast rather
// than trapping the user — see AutoUpdater.installUpdate.
export const FORCE_AUTO_UPDATE = true;

// --- Auto-update toggle (shared cross-surface via Core preferences) ---------
// Key matches Core's `update::AUTO_UPDATE_PREF_KEY`. Stored as `{ "enabled": bool }`.

export const AUTO_UPDATE_PREF_KEY = "auto-updates";

/** Whether automatic updates are enabled. Defaults to `true` when unset. */
export async function getAutoUpdateEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, AUTO_UPDATE_PREF_KEY);
	if (!raw) {
		return true;
	}
	try {
		const parsed = JSON.parse(raw) as { enabled?: unknown };
		return parsed.enabled !== false;
	} catch {
		return true;
	}
}

/** Persist the auto-update toggle. Returns success. */
export function setAutoUpdateEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		AUTO_UPDATE_PREF_KEY,
		JSON.stringify({ enabled })
	);
}
