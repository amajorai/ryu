import { toast } from "@ryu/ui/components/sileo.tsx";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyNodeUpdate,
	scheduleNodeUpdate,
	type UpdateCheck,
} from "@/src/lib/api/update.ts";
import {
	clearPreparedAppUpdate,
	getPreparedAppUpdate,
	installPreparedAppUpdate,
} from "@/src/lib/app-update-preparation.ts";
import type { ReleaseChannel } from "@/src/lib/release-channel.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { getUpdatesCutoffMs } from "@/src/lib/updates-window.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { notifyUpdateOutsideWindow } from "./update-deferral.ts";
import {
	type AppUpdateOptions,
	isEligibleForAppUpdate,
	offerManualDownload,
	prepareUpdate,
	updateErrorSentence,
} from "./update-prompts.ts";

/**
 * Apply the release-train update to the node the user is looking at.
 *
 * The single definition of "which updater is the right one", because it is not
 * always this app's: Core, Gateway and the CLI ship INSIDE the desktop bundle,
 * so for a local node the native updater moves all of them together. For a
 * remote node (a cloud or LAN Core) that same updater would replace the local
 * app and leave the remote binaries untouched — there the node must update
 * itself through `POST /api/update/apply`.
 *
 * Returns a message when it did remote work, `null` when the native updater took
 * over (it owns its own progress toasts and relaunch).
 */
/**
 * Defer a REMOTE node's update to that node's next quiet hour.
 *
 * Only meaningful for a node the desktop does not own. A local node's update
 * ships inside this app bundle and is installed by the native updater, which
 * has its own restart flow — there is nothing on the node to defer.
 *
 * Returns a human sentence naming the time AND the zone. "03:00" alone is the
 * ambiguity deferring exists to remove: the node's zone is usually not the
 * viewer's, and a user in Singapore scheduling a Frankfurt node means
 * Frankfurt's night.
 */
export async function scheduleReleaseUpdate(
	target: ApiTarget,
	node: { url: string },
	verdict: UpdateCheck
): Promise<string> {
	if (isLocalNode(node)) {
		throw new Error(
			"This node updates with the app itself, so there is nothing to schedule."
		);
	}
	if (!verdict.asset) {
		throw new Error(
			`No install asset published for v${verdict.latest} on this node's platform.`
		);
	}
	const pending = await scheduleNodeUpdate(
		target,
		verdict.asset,
		verdict.latest
	);
	const when = formatDateTime(pending.scheduled_for);
	return `v${pending.version} will install at ${when} (${pending.time_zone}).`;
}

export async function applyReleaseUpdate(
	target: ApiTarget,
	node: { url: string },
	verdict: UpdateCheck
): Promise<string | null> {
	if (!isLocalNode(node)) {
		if (!verdict.asset) {
			throw new Error(
				`No install asset published for v${verdict.latest} on this node's platform.`
			);
		}
		// `POST /api/update/apply` is deliberately ungated: the caller supplies the
		// asset URL, so an entitlement check there would be theatre. Do not "fix"
		// it — see docs/auto-update.md.
		const result = await applyNodeUpdate(target, verdict.asset);
		return result.message;
	}
	await installUpdate(verdict, { node });
	return null;
}

/**
 * Whether a clamped verdict may be installed by pinning to `verdict.tag`.
 *
 * Every input is a fact the CLIENT owns — never a flag the node asserted.
 * `checkForUpdate` accepts an arbitrary node URL, so a hostile or compromised
 * node could otherwise choose which signed Ryu build lands on this machine, and
 * signature verification does not help when the attacker is picking among
 * legitimately signed releases.
 */
export function canPinInstall(
	verdict: UpdateCheck,
	tag: string,
	channel: ReleaseChannel,
	node: { url: string } | undefined
): boolean {
	if (node === undefined || !isLocalNode(node)) {
		return false;
	}
	const cutoffMs = getUpdatesCutoffMs();
	const publishedAtMs = verdict.published_at
		? Date.parse(verdict.published_at)
		: Number.NaN;
	// A security-waived release is published STRICTLY AFTER the cutoff by
	// construction (Core only waives to a marked release newer than the window),
	// so the at-or-before test below is its exact complement: without this
	// allowance the waiver could never install and the whole escape hatch would be
	// inert — a lapsed owner would never receive a security fix.
	//
	// This is the one node-asserted input we accept, and the exposure is bounded:
	// the pin resolves to `releases/download/<tag>/…` on Ryu's own repo, the tag
	// charset is validated in Rust, minisign verification is unchanged, and
	// tauri-plugin-updater refuses any version not strictly newer than the running
	// one. So a hostile node can at most choose among genuinely signed Ryu
	// releases newer than the current build — it cannot downgrade or substitute.
	const withinWindow =
		Number.isFinite(publishedAtMs) &&
		cutoffMs !== null &&
		publishedAtMs <= cutoffMs;
	return (
		cutoffMs !== null &&
		(withinWindow || verdict.cutoff_waived_for_security === true) &&
		tag !== "" &&
		// A rolling pointer (`nightly` / `canary`) does not identify a specific
		// build, so pinning to it is meaningless — it would install whatever the
		// pointer currently holds.
		channel !== "nightly" &&
		channel !== "canary"
	);
}

// Install only through the native prepared-artifact boundary. An explicit click
// may download first when no verified artifact exists; automatic launch checks
// call `prepareUpdate` instead and never enter this function.
export let installFailureToastId: string | undefined;

export let installFailureToastSequence = 0;

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
