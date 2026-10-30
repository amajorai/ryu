import { decideUpdateEligibility } from "@ryu/auth/lib/plans";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { sileo } from "sileo";
import { resolveAppUpdateSource } from "@/src/components/updater/app-update-policy.ts";
import {
	updateToastBody,
	updateToastId,
} from "@/src/components/updater/ReleaseNotes.tsx";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import { prepareAppUpdate } from "@/src/lib/app-update-preparation.ts";
import { getReleaseChannel } from "@/src/lib/release-channel.ts";
import { getUpdatesCutoffMs } from "@/src/lib/updates-window.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import {
	canDeferAppUpdate,
	notifyUpdateOutsideWindow,
} from "./update-deferral.ts";
import { canPinInstall, installUpdate } from "./update-install.ts";

export interface AppUpdateOptions {
	node?: { url: string };
	pinned?: boolean;
}

export function isEligibleForAppUpdate(verdict: UpdateCheck): boolean {
	const releasedAtMs = verdict.published_at
		? Date.parse(verdict.published_at)
		: Number.NaN;
	const eligibility = decideUpdateEligibility({
		cutoffMs: getUpdatesCutoffMs(),
		nowMs: Date.now(),
		releasePublishedAtMs: Number.isFinite(releasedAtMs) ? releasedAtMs : null,
	});
	return eligibility.eligible || verdict.cutoff_waived_for_security === true;
}

export function sourceForUpdate(
	verdict: UpdateCheck,
	options?: AppUpdateOptions
) {
	const channel = getReleaseChannel();
	if (verdict.restricted_by_cutoff) {
		const tag = verdict.tag ?? "";
		return resolveAppUpdateSource({
			channel,
			pin: {
				allowed: canPinInstall(verdict, tag, channel, options?.node),
				kind: "required",
				tag,
			},
		});
	}
	if (options?.pinned) {
		return resolveAppUpdateSource({
			channel,
			pin: {
				allowed: canDeferAppUpdate(verdict, options.node),
				kind: "required",
				tag: verdict.tag ?? "",
			},
		});
	}
	return resolveAppUpdateSource({
		channel,
		latest: {
			fromLocalNode: options?.node !== undefined && isLocalNode(options.node),
			tag: verdict.tag,
			version: verdict.latest,
		},
		pin: { kind: "none" },
	});
}

export async function prepareUpdate(
	verdict: UpdateCheck,
	options?: AppUpdateOptions
) {
	if (!isEligibleForAppUpdate(verdict)) {
		notifyUpdateOutsideWindow(verdict);
		return null;
	}
	const source = sourceForUpdate(verdict, options);
	if (!source) {
		return null;
	}
	return prepareAppUpdate({
		expectedVersion: verdict.latest,
		source,
	});
}

export function showPreparedUpdatePrompt(
	verdict: UpdateCheck,
	options?: AppUpdateOptions
): void {
	toast.info({
		title: `Update ready — v${verdict.latest}`,
		description: updateToastBody({
			notes: verdict.notes,
			htmlUrl: verdict.html_url,
			fallback: "Downloaded and verified. Install when you're ready.",
			footnote: verdict.cutoff_waived_for_security
				? "This is a security update, included regardless of your updates window."
				: undefined,
		}),
		id: updateToastId(verdict.latest),
		duration: null,
		button: {
			title: "Install and restart",
			onClick: () => {
				installUpdate(verdict, options).catch(() => undefined);
			},
		},
	});
}

export function showDownloadUpdatePrompt(
	verdict: UpdateCheck,
	options?: AppUpdateOptions
): void {
	toast.info({
		title: `Update available — v${verdict.latest}`,
		description: updateToastBody({
			notes: verdict.notes,
			htmlUrl: verdict.html_url,
			fallback: "Download it now and install when you're ready.",
		}),
		id: updateToastId(verdict.latest),
		duration: null,
		button: {
			title: "Download update",
			onClick: () => {
				prepareAndPrompt(verdict, options).catch((error) => {
					showPreparationFailure(verdict, options, error);
				});
			},
		},
	});
}

/**
 * Prepare an update from a toast button and show what comes next.
 *
 * `prepareUpdate` answers `null` when the update is outside the updates window
 * (it already said so), or when no signed feed could serve it — a missing source,
 * or a release whose feed is not up yet. The second case must still leave the
 * user a way forward; otherwise "Download update" is a button that does nothing.
 */
export async function prepareAndPrompt(
	verdict: UpdateCheck,
	options: AppUpdateOptions | undefined
): Promise<void> {
	const prepared = await prepareUpdate(verdict, options);
	if (prepared) {
		showPreparedUpdatePrompt(verdict, options);
		return;
	}
	if (isEligibleForAppUpdate(verdict)) {
		offerManualDownload(
			verdict,
			verdict.html_url ?? "https://ryuhq.com/downloads?ref=ryu-app"
		);
	}
}

const RAW_ERROR_SHAPE = /[{}[\]<>]|\b(?:[45]\d\d|ECONN\w+|ENOTFOUND)\b/;
const MAX_ERROR_SENTENCE = 160;

/**
 * One readable sentence for an updater failure. A message that is already a
 * sentence (the node's own copy) passes through; raw shapes — JSON, markup,
 * status codes, socket errors, stack-length text — map to `fallback`.
 */
export function updateErrorSentence<TError>(
	error: TError,
	fallback: string
): string {
	const message = (
		error instanceof Error ? error.message : String(error ?? "")
	).trim();
	if (
		!message ||
		message.length > MAX_ERROR_SENTENCE ||
		RAW_ERROR_SHAPE.test(message)
	) {
		return fallback;
	}
	return message;
}

export function showPreparationFailure<TError>(
	verdict: UpdateCheck,
	options: AppUpdateOptions | undefined,
	error: TError
): void {
	sileo.error({
		title: "Update download failed",
		description: updateErrorSentence(
			error,
			"Check your connection and try again."
		),
		duration: null,
		button: {
			title: "Retry download",
			onClick: () => {
				prepareAndPrompt(verdict, options).catch((retryError) => {
					showPreparationFailure(verdict, options, retryError);
				});
			},
		},
	});
}

export function openDownloads(url: string) {
	window.open(url, "_blank", "noopener");
}

/**
 * The universal fallback: point the user at the release page and let them run
 * the installer by hand. Used whenever we know an update exists but cannot drive
 * it ourselves — no signed feed, a failed native install, or a pin we refused.
 */
export function offerManualDownload(
	verdict: UpdateCheck,
	downloadsUrl: string
): void {
	sileo.info({
		title: `Update v${verdict.latest} available`,
		description: "Open the download page to update manually.",
		duration: null,
		button: {
			title: "Open downloads",
			onClick: () => {
				openDownloads(downloadsUrl);
			},
		},
	});
}
