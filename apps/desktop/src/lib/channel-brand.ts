// apps/desktop/src/lib/channel-brand.ts
//
// WHAT CHANNEL THIS BUILD *IS*, AS A NAME — distinct from `release-channel.ts`,
// which holds the channel the user *chose to follow* for updates. A stable
// install can be pointed at the nightly feed; only the running bundle's own
// version says what it currently is.
//
// A build is self-describing: its version names its channel (`channelOf`,
// mirroring Core's `channel_of` in apps/core/src/update/mod.rs). This turns that
// channel id into the display name the app wears: "Research Preview" for a bare
// `0.1.4`, "Nightly" for `0.1.4-nightly.20260806.12`.
//
// The SAME table drives the OS-registered app name: `scripts/release/channel-brand.mjs`
// reads `release-channels.json` at build time and stamps `productName` into
// tauri.conf.json, so the Dock/taskbar/`.desktop` entry and any in-app label can
// never disagree — one table, not two.

import { channelOf } from "@ryuhq/core-client/node-compat.ts";
import CHANNELS from "@/src/lib/release-channels.json" with { type: "json" };

interface ChannelBrand {
	/** Suffix shown after the app name — "Nightly", "Research Preview", … */
	label: string;
	/** Icon tile colour for that channel (read by the build-time icon stamp). */
	tile: string;
}

const TABLE = new Map(
	Object.entries(CHANNELS satisfies Record<string, ChannelBrand>)
);

/** The base product name, without any channel suffix. */
export const APP_NAME = "Ryu";

/**
 * The channel id for a version string, or `"stable"` when it carries no
 * prerelease. `null`/empty (no Tauri shell — browser dev server, e2e harness)
 * also reads as stable rather than inventing a channel.
 */
export function channelOfVersion(version: string | null | undefined): string {
	if (!version) {
		return "stable";
	}
	return channelOf(version);
}

/**
 * The channel's display suffix, e.g. `"Nightly"`. An unknown channel — a future
 * prerelease id this build has never heard of — gets a Title-Cased form of the
 * id itself rather than being dropped, so an unrecognised build still announces
 * that it is not stable.
 */
export function channelLabel(channel: string): string {
	const known = TABLE.get(channel)?.label;
	if (known) {
		return known;
	}
	return channel.charAt(0).toUpperCase() + channel.slice(1);
}

/**
 * The full OS-registered style name for a version — `"Ryu (Nightly)"`. Matches
 * what `channel-brand.mjs` stamps as `productName`, so an in-app label and the
 * name macOS/Windows/Linux show are the same string.
 */
export function appDisplayName(version: string | null | undefined): string {
	return `${APP_NAME} (${channelLabel(channelOfVersion(version))})`;
}
