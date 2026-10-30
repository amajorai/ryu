// React-query keys, timing constants, and the catalog-kind mapping used by
// useAvailableUpdates.ts.

import type { UpdateKind } from "@/src/hooks/useAvailableUpdates-types.ts";

// Match the owning Store sections' react-query keys so no duplicate fetch fires.
export const APP_KEY = (url: string) => ["update", "check", url] as const;
export const AGENT_CATALOG_KEY = (url: string) =>
	["agents", "catalog", url] as const;
export const SIDECAR_CATALOG_KEY = (url: string) =>
	["catalog", "sidecars", url] as const;
export const APPS_KEY = (url: string) => ["apps", "list", url] as const;
export const PLUGINS_CATALOG_KEY = (url: string) =>
	["plugins", "catalog", "all", url] as const;
export const MODEL_UPDATES_KEY = (url: string) =>
	["models", "updates", url] as const;
export const SKILL_UPDATES_KEY = (url: string) =>
	["skills", "updates", url] as const;
export const MCP_UPDATES_KEY = (url: string) =>
	["mcp", "updates", url] as const;
export const APP_VERSION_KEY = ["app", "version"] as const;

// Upstream version checks are cheap on Core (VersionCache) but still remote;
// keep them fresh for a minute so re-opening the popup is instant.
export const UPDATES_STALE_MS = 60_000;

// When Core does the work in the background, re-check on this ladder after an
// apply so the row reflects reality instead of the pre-press snapshot.
export const BACKGROUND_RECHECK_MS = [4000, 15_000, 45_000];

/** A catalog category maps to the update kind shown in the UI. */
export function catalogKind(category: string): UpdateKind {
	switch (category) {
		case "provider":
			return "engine";
		case "voice":
			return "voice";
		case "media":
			return "media";
		case "agent":
			return "agent";
		default:
			return "tool";
	}
}
