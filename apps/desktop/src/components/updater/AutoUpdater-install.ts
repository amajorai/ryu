import { toast } from "@ryu/ui/components/sileo.tsx";
import { sileo } from "sileo";
import {
	type AppUpdateOptions,
	isEligibleForAppUpdate,
	prepareUpdate,
} from "@/src/components/updater/AutoUpdater-source.ts";
import { notifyUpdateOutsideWindow } from "@/src/components/updater/AutoUpdater-window-notices.ts";
import {
	updateToastBody,
	updateToastId,
} from "@/src/components/updater/ReleaseNotes.tsx";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import {
	clearPreparedAppUpdate,
	getPreparedAppUpdate,
	installPreparedAppUpdate,
} from "@/src/lib/app-update-preparation.ts";

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

function openDownloads(url: string) {
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
// Install only through the native prepared-artifact boundary. An explicit click
// may download first when no verified artifact exists; automatic launch checks
// call `prepareUpdate` instead and never enter this function.
let installFailureToastId: string | undefined;
let installFailureToastSequence = 0;

export async function installUpdate(
	verdict: UpdateCheck,
	options?: AppUpdateOptions
): Promise<void> {
	if (!isEligibleForAppUpdate(verdict)) {
		notifyUpdateOutsideWindow(verdict);
		return;
	}

	// Both the Settings action and the notification's Retry enter here. Retire
	// only this install's previous failure before starting another eligible try;
	// native cancellation must not leave an obsolete persistent error behind.
	if (installFailureToastId !== undefined) {
		sileo.dismiss(installFailureToastId);
		installFailureToastId = undefined;
	}

	const downloadsUrl =
		verdict.html_url ?? "https://ryuhq.com/downloads?ref=ryu-app";
	let progressId: ReturnType<typeof sileo.info> | undefined;
	try {
		const prepared = await getPreparedAppUpdate().catch(() => null);
		if (prepared?.version !== verdict.latest) {
			if (prepared) {
				await clearPreparedAppUpdate();
			}
			progressId = sileo.info({
				title: `Downloading update v${verdict.latest}…`,
				description: "Ryu will ask before installing and restarting.",
				duration: null,
			});
			const downloaded = await prepareUpdate(verdict, options);
			if (progressId !== undefined) {
				sileo.dismiss(progressId);
				progressId = undefined;
			}
			if (!downloaded) {
				offerManualDownload(verdict, downloadsUrl);
				return;
			}
		}

		progressId = sileo.info({
			title: `Preparing to install v${verdict.latest}…`,
			description: "Checking the runtime release. Ryu asks before restarting.",
			duration: null,
		});
		const installed = await installPreparedAppUpdate();
		sileo.dismiss(progressId);
		progressId = undefined;
		if (installed === null) {
			return;
		}
		if (!installed) {
			offerManualDownload(verdict, downloadsUrl);
			return;
		}
		sileo.success({
			title: "Update installer finished",
			description: "Restarting Ryu to load the new release…",
			duration: 2000,
		});
		const { relaunch } = await import("@tauri-apps/plugin-process");
		setTimeout(() => {
			relaunch().catch((error) => {
				sileo.error({
					title: "Couldn't restart Ryu",
					description: updateErrorSentence(
						error,
						"Close and reopen Ryu to finish loading the update."
					),
					duration: null,
				});
			});
		}, 1500);
	} catch (error) {
		if (progressId !== undefined) {
			sileo.dismiss(progressId);
		}
		installFailureToastId = toast.error({
			// Sileo removes dismissed IDs after their exit animation. A failed
			// retry needs a fresh ID so the older dismissal cannot remove it.
			id: `ryu-app-update-install-error-${++installFailureToastSequence}`,
			title: "Update failed",
			description: updateErrorSentence(
				error,
				"Ryu couldn't install the update. Try again."
			),
			duration: null,
			button: {
				title: "Retry",
				onClick: () => {
					installUpdate(verdict, options).catch(() => undefined);
				},
			},
		});
	}
}
