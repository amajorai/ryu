// apps/desktop/src/lib/release-channel.ts
//
// The desktop's release channel (Canary / Nightly / Beta / Stable). This governs
// which per-channel updater feed the Tauri updater checks: switching the channel
// changes the `latest.json` the updater downloads from, so a user on Beta gets
// beta builds while a Stable user stays on stable.
//
// Persisted in localStorage (like the other desktop toggles in
// `usePersistedToggle`) and synced across every consumer via an external store so
// the Settings picker and native window title stay current when either changes.
// Default is "stable" — an unset/legacy install behaves exactly as before
// (the stable feed, the pre-existing JS updater path).

import { useCallback, useSyncExternalStore } from "react";
import { channelLabel } from "@/src/lib/channel-brand.ts";

export type ReleaseChannel = "canary" | "nightly" | "beta" | "stable";

export const RELEASE_CHANNEL_KEY = "ryu:release-channel";

export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = "stable";

/**
 * Ordered most-bleeding-edge → most-stable, for the picker.
 *
 * Labels come from the SAME table that names the shipped bundle
 * (`release-channels.json`, read at build time by
 * `scripts/release/channel-brand.mjs`), so the row a user picks here reads
 * exactly like the app metadata they end up running — including the active
 * prerelease label when one exists.
 */
export const RELEASE_CHANNELS: {
	channel: ReleaseChannel;
	description: string;
	label: string;
}[] = [
	{
		channel: "canary",
		label: channelLabel("canary"),
		description: "Every build. Expect rough edges.",
	},
	{
		channel: "nightly",
		label: channelLabel("nightly"),
		description: "Nightly builds with the latest features.",
	},
	{
		channel: "beta",
		label: channelLabel("beta"),
		description: "Pre-release builds, mostly stable.",
	},
	{
		channel: "stable",
		label: channelLabel("stable"),
		description: "The recommended, fully tested release.",
	},
];

const CHANNEL_SET = new Set<ReleaseChannel>([
	"canary",
	"nightly",
	"beta",
	"stable",
]);

function isReleaseChannel(value: unknown): value is ReleaseChannel {
	return typeof value === "string" && CHANNEL_SET.has(value as ReleaseChannel);
}

const listeners = new Set<() => void>();

function read(): ReleaseChannel {
	try {
		const raw = localStorage.getItem(RELEASE_CHANNEL_KEY);
		return isReleaseChannel(raw) ? raw : DEFAULT_RELEASE_CHANNEL;
	} catch {
		return DEFAULT_RELEASE_CHANNEL;
	}
}

/** Non-reactive read, for the updater install path (outside React). */
export function getReleaseChannel(): ReleaseChannel {
	return read();
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === RELEASE_CHANNEL_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** `[channel, setChannel]`, synced across all consumers + windows. */
export function useReleaseChannel(): [
	ReleaseChannel,
	(next: ReleaseChannel) => void,
] {
	const channel = useSyncExternalStore(
		subscribe,
		read,
		() => DEFAULT_RELEASE_CHANNEL
	);

	const setChannel = useCallback((next: ReleaseChannel) => {
		try {
			localStorage.setItem(RELEASE_CHANNEL_KEY, next);
		} catch {
			// Persistence is best-effort.
		}
		for (const cb of listeners) {
			cb();
		}
	}, []);

	return [channel, setChannel];
}
