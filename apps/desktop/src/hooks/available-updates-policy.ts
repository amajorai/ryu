// apps/desktop/src/hooks/available-updates-policy.ts
//
// The pure decisions behind the download center's "available updates" rows,
// kept apart from `useAvailableUpdates` (react-query + node store) so each rule
// is unit-tested on its own.

import { channelOf } from "@ryuhq/core-client/node-compat.ts";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import {
	isNewerVersion,
	releaseIsNewerThanApp,
} from "@/src/lib/app-version.ts";

/**
 * Whether the release-train ("Ryu app") row shows.
 *
 * On the LOCAL node the gate is the app's own version, not `verdict.current`:
 * Core answers about itself, and a `ryu-core` left behind at an older version
 * would otherwise keep a row the native updater can never clear. A remote node
 * updates itself through `POST /api/update/apply`, so its own verdict decides.
 */
export function showsAppUpdateRow(
	verdict: UpdateCheck | undefined,
	isLocal: boolean,
	appVersion: string | null | undefined
): boolean {
	if (!verdict?.update_available) {
		return false;
	}
	return !isLocal || releaseIsNewerThanApp(appVersion, verdict.latest);
}

/**
 * Whether an installed plugin trails its catalog version: semver-newer within
 * the installed build's channel. A plain `!==` offered downgrades (a stale
 * catalog) and cross-channel "updates" that Core's channel-scoped apply
 * resolves to a no-op, so the row could never clear.
 */
export function pluginHasUpdate(
	installedVersion: string | null | undefined,
	catalogVersion: string | null | undefined
): boolean {
	if (!(installedVersion && catalogVersion)) {
		return false;
	}
	return (
		channelOf(installedVersion) === channelOf(catalogVersion) &&
		isNewerVersion(installedVersion, catalogVersion)
	);
}

/**
 * "Update all" order: the app update goes LAST. On a local node it installs the
 * bundle and exits the app, which would cut every update queued behind it.
 */
export function withAppUpdateLast<TUpdate extends { kind: string }>(
	updates: readonly TUpdate[]
): TUpdate[] {
	return [
		...updates.filter((update) => update.kind !== "app"),
		...updates.filter((update) => update.kind === "app"),
	];
}
