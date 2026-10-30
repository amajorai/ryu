// Types for useAvailableUpdates.ts (split out to keep that hook under the file limits).

import type { UpdateCheck } from "@/src/lib/api/update.ts";

/** The artifact families that can carry an available update. */
export type UpdateKind =
	| "app"
	| "agent"
	| "engine"
	| "tool"
	| "voice"
	| "media"
	| "plugin"
	| "skill"
	| "mcp"
	| "model";

/** One artifact with a newer version available. `key` is globally unique. */
export interface AvailableUpdate {
	/** App updates carry the raw verdict so apply can hand off to the native updater. */
	appVerdict?: UpdateCheck;
	currentVersion: string | null;
	/** The id/name the apply endpoint expects (agent id, sidecar name, plugin id). */
	id: string;
	/** `${kind}:${id}` — stable across refetches, used as the React key + apply id. */
	key: string;
	kind: UpdateKind;
	latestVersion: string | null;
	/** Extra apply payload for models (needs both repo + filename to re-download). */
	model?: { repoId: string; file: string };
	name: string;
	/** Release notes / changelog, when the source provides them (app only today). */
	notes?: string | null;
	/** Installed skill slug (skills only), to look up the skill's enabled state. */
	slug?: string;
	/** Catalog source that must apply the update (skills, MCP servers). */
	source?: string;
}

/**
 * What an apply achieved, so the result can be reported rather than guessed at.
 *
 * `silent` marks the one path that owns its own user-facing progress — the
 * native desktop updater, which toasts download progress and then relaunches.
 * Everything else reports through this hook, so there is exactly one place that
 * decides what an update press says.
 */
export interface ApplyOutcome {
	detail: string | null;
	silent: boolean;
}

export interface UseAvailableUpdatesResult {
	/** Keys currently being applied (for per-row spinners). */
	applyingKeys: Set<string>;
	/** Apply one update; resolves when the update action completes. */
	applyUpdate: (update: AvailableUpdate) => Promise<void>;
	/** True while the first fetch of any source is in flight. */
	loading: boolean;
	/** Re-run every source's check. */
	refresh: () => void;
	updates: AvailableUpdate[];
}
