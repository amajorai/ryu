// Post-apply revalidation for useAvailableUpdates.ts: refetches the source that
// owned an applied update so its row clears once the new version is installed.

import type { QueryClient } from "@tanstack/react-query";
import {
	AGENT_CATALOG_KEY,
	APP_KEY,
	APPS_KEY,
	BACKGROUND_RECHECK_MS,
	MCP_UPDATES_KEY,
	MODEL_UPDATES_KEY,
	PLUGINS_CATALOG_KEY,
	SIDECAR_CATALOG_KEY,
	SKILL_UPDATES_KEY,
} from "./useAvailableUpdates-keys.ts";
import type { AvailableUpdate } from "./useAvailableUpdates-types.ts";

export function invalidateAfterApply(
	qc: QueryClient,
	url: string,
	update: AvailableUpdate
): void {
	// Revalidate the source that owned this update so the row clears once
	// the new version is installed.
	const invalidate = (key: readonly unknown[]) =>
		Promise.resolve(qc.invalidateQueries({ queryKey: key })).catch(
			() => undefined
		);
	// Kinds Core installs in the BACKGROUND resolve their request the moment
	// the work is queued, so an immediate refetch still reports the old
	// version and the row stays put looking like nothing happened. Re-check
	// on a short ladder: the first pass catches the "installing" state (which
	// drops the row), the later ones catch the finished version.
	const recheck = (key: readonly unknown[]) => {
		invalidate(key);
		for (const delayMs of BACKGROUND_RECHECK_MS) {
			setTimeout(() => invalidate(key), delayMs);
		}
	};
	switch (update.kind) {
		case "app":
			invalidate(APP_KEY(url));
			break;
		case "agent":
			invalidate(AGENT_CATALOG_KEY(url));
			// The Agents page's per-row control reads a DIFFERENT key, so
			// without this it kept offering an update already applied here.
			invalidate(["agent-update", url, update.id]);
			break;
		case "plugin":
			invalidate(APPS_KEY(url));
			invalidate(PLUGINS_CATALOG_KEY(url));
			break;
		case "model":
			recheck(MODEL_UPDATES_KEY(url));
			break;
		case "skill":
			invalidate(SKILL_UPDATES_KEY(url));
			break;
		case "mcp":
			invalidate(MCP_UPDATES_KEY(url));
			break;
		default:
			recheck(SIDECAR_CATALOG_KEY(url));
	}
}
