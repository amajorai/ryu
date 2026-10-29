import type {
	AppUpdateSource,
	PreparedAppUpdate,
} from "@/src/lib/app-update-preparation.ts";
import type { ReleaseChannel } from "@/src/lib/release-channel.ts";

export const APP_UPDATE_DOWNLOAD_TITLE = "Download updates automatically";
export const APP_UPDATE_DOWNLOAD_DESCRIPTION =
	"Download updates in the background. Ryu asks before installing and restarting.";
export const APP_UPDATE_DOWNLOAD_ARIA_LABEL =
	"Download app updates automatically";
export const APP_UPDATE_INSTALL_ACTION = "Install and restart";

export type PreparedUpdateAction =
	| { kind: "clear_and_notify" }
	| { kind: "notify_download" }
	| { kind: "prepare" }
	| { kind: "prompt_install" }
	| { kind: "replace" };

export function choosePreparedUpdateAction(input: {
	automaticDownload: boolean;
	latest: string;
	preparedVersion: PreparedAppUpdate["version"] | null;
}): PreparedUpdateAction {
	if (input.preparedVersion === input.latest) {
		return { kind: "prompt_install" };
	}
	if (input.preparedVersion) {
		return input.automaticDownload
			? { kind: "replace" }
			: { kind: "clear_and_notify" };
	}
	return input.automaticDownload
		? { kind: "prepare" }
		: { kind: "notify_download" };
}

export type AppUpdatePinPolicy =
	| { kind: "none" }
	| { allowed: boolean; kind: "required"; tag: string };

/**
 * The verdict's release, as the nightly and canary feeds need it.
 *
 * Those builds publish their feed only on their own versioned tag (the rolling
 * `nightly`/`canary` tags are retired), so the install has to follow the
 * verdict's `tag`. That tag is node-asserted, and `checkForUpdate` accepts an
 * arbitrary node URL, so it is trusted only when the LOCAL node answered (the
 * same gate as pinned installs) and only when it names exactly the advertised
 * version on the client's own channel. A remote node could otherwise choose
 * which signed build lands on this machine.
 */
export interface AppUpdateLatestRelease {
	fromLocalNode: boolean;
	tag?: string | null;
	version: string;
}

function trustedChannelTag(
	channel: ReleaseChannel,
	latest: AppUpdateLatestRelease | undefined
): string | null {
	if (!latest?.fromLocalNode) {
		return null;
	}
	const tag = latest.tag?.trim() ?? "";
	const version = latest.version.trim();
	if (tag === "" || version === "" || tag !== `v${version}`) {
		return null;
	}
	// The prerelease identifier must be the client's channel, so a nightly
	// build cannot be steered onto a canary tag (or a stable/beta one).
	const prerelease = version.split("+", 1)[0]?.split("-").slice(1).join("-");
	return prerelease?.split(".")[0] === channel ? tag : null;
}

/**
 * Without a trusted `latest` tag, nightly and canary have no feed to read and
 * the caller falls back to a manual download.
 */
export function resolveAppUpdateSource(input: {
	channel: ReleaseChannel;
	latest?: AppUpdateLatestRelease;
	pin: AppUpdatePinPolicy;
}): AppUpdateSource | null {
	if (input.pin.kind === "required") {
		if (
			!(input.pin.allowed && input.pin.tag) ||
			(input.channel !== "stable" && input.channel !== "beta")
		) {
			return null;
		}
		return {
			channel: input.channel,
			kind: "tag",
			tag: input.pin.tag,
		};
	}

	if (input.channel === "stable") {
		return { kind: "stable" };
	}
	if (input.channel === "beta") {
		return { channel: input.channel, kind: "channel" };
	}
	const tag = trustedChannelTag(input.channel, input.latest);
	return tag ? { channel: input.channel, kind: "tag", tag } : null;
}
