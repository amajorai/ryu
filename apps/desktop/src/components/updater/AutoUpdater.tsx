import { useEffect, useRef } from "react";
import {
	installUpdate,
	offerManualDownload,
	showDownloadUpdatePrompt,
	showPreparationFailure,
	showPreparedUpdatePrompt,
} from "@/src/components/updater/AutoUpdater-install.ts";
import { prepareUpdate } from "@/src/components/updater/AutoUpdater-source.ts";
import { notifyUpdatesWindowLapsed } from "@/src/components/updater/AutoUpdater-window-notices.ts";
import { choosePreparedUpdateAction } from "@/src/components/updater/app-update-policy.ts";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { checkForUpdate } from "@/src/lib/api/update.ts";
import {
	clearPreparedAppUpdate,
	getAutomaticAppUpdateDownload,
	getPreparedAppUpdate,
} from "@/src/lib/app-update-preparation.ts";
import {
	clearPendingAppUpdate,
	dueAppUpdate,
	getPendingAppUpdate,
} from "@/src/lib/app-update-schedule.ts";
import { verdictAppliesToApp } from "@/src/lib/app-version.ts";

export {
	installUpdate,
	showDownloadUpdatePrompt,
	showPreparedUpdatePrompt,
} from "@/src/components/updater/AutoUpdater-install.ts";
export {
	applyReleaseUpdate,
	scheduleReleaseUpdate,
} from "@/src/components/updater/AutoUpdater-node-update.ts";
export {
	canDeferAppUpdate,
	isEligibleForAppUpdate,
	prepareUpdate,
} from "@/src/components/updater/AutoUpdater-source.ts";
export { notifyUpdatesWindowLapsed } from "@/src/components/updater/AutoUpdater-window-notices.ts";

// Launch-time auto-updater for the desktop. On mount it asks Core whether an
// update is available (Core remains the source of truth for the verdict). The
// Tauri process downloads and durably verifies the artifact; the webview only
// decides whether to download now and presents the explicit install action.
//
// - Automatic download ON  → prepare the update, then ask to install/restart.
// - Automatic download OFF → ask before downloading, then ask to install.
// - Lifetime owner past their updates window → Core offers the newest build the
//   window COVERS, and that build is installed pinned to its OWN signed feed
//   (the static feed always resolves to the absolute latest). Once the owner is
//   already at that ceiling they get one prompt per newly-published version,
//   rather than the silent "no update available" a bare clamp would produce.
//
// A missing signed feed degrades to the existing manual-download action. No
// launch-time branch installs or relaunches the app.
export function AutoUpdater() {
	const getNode = useActiveNodeGetter();
	const ranRef = useRef(false);

	useEffect(() => {
		// Check exactly once per launch.
		if (ranRef.current) {
			return;
		}
		ranRef.current = true;

		const run = async () => {
			const node = getNode();
			const target = toTarget(node);
			// A deferred install the user already agreed to comes FIRST, before any
			// check. This is the primary execution path for a desktop deferral, not
			// a fallback: the app is normally asleep or quit at 03:00, so "the next
			// launch after the window" is when the promise is actually kept. See
			// `lib/app-update-schedule.ts` for why that is the only promise this
			// surface may make.
			if (await installDeferredUpdate(node)) {
				return;
			}
			// ALWAYS clamped, regardless of which node answers. This verdict has
			// exactly one consumer — `installUpdate`, which drives THIS APP'S OWN
			// bundle — so the window that governs it is this user's, not the queried
			// node's. Keying the clamp on `isLocalNode` instead meant a lapsed owner
			// whose active node was a cloud Core got an unclamped verdict, failed the
			// eligibility guard, and so never reached the pinned branch: the feature
			// would nag them every launch while never delivering the build their
			// window does cover.
			//
			// This does NOT withhold updates from a remote node. Clamping is a query
			// parameter, not a mutation, and the surfaces that update a NODE's own
			// Core/Gateway binaries (the node selector, the Download Center,
			// Preflight) call `checkForUpdate` without it — see
			// `CheckForUpdateOptions.clamp`.
			const verdict = await checkForUpdate(target, { clamp: true });
			if (!verdict.update_available) {
				// Already at the ceiling their window covers, but a newer Ryu exists.
				await notifyUpdatesWindowLapsed(verdict);
				return;
			}
			// Core answered about ITSELF — `verdict.current` is the answering Core
			// binary's version, and Core is a SEPARATE install from this app bundle
			// (on macOS the desktop downloads `ryu-core` into `~/.ryu/bin`). A Core
			// left behind at an older version therefore reported a perfectly true
			// "0.0.14 → 0.1.3" that this app, already on 0.1.3, presented as
			// "Update available — v0.1.3". Everything below drives THIS APP'S bundle,
			// so the app's own version is what the release has to beat.
			if (!(await verdictAppliesToApp(verdict))) {
				return;
			}

			// An install this user already BOOKED for tonight must not be started
			// now, and must not be nagged about again — they made the decision once.
			// Anything still pending here is not yet due, since a due record was
			// installed and cleared above.
			const booked = await getPendingAppUpdate();
			if (booked) {
				if (booked.version === verdict.latest) {
					// "Install later" already pins and authorizes this release. Prepare
					// it now so the quiet-window handoff does not spend that window
					// downloading, but do not install before the booked instant.
					await prepareUpdate(verdict, { node, pinned: true }).catch(
						() => undefined
					);
					return;
				}
				// A newer release superseded the booked one. Leaving the stale record
				// would install an older build at the window — which the native
				// updater refuses anyway, so the deferral would silently do nothing
				// forever. Drop it and treat the new release as a fresh decision.
				await clearPendingAppUpdate();
			}

			const [automaticDownload, prepared] = await Promise.all([
				getAutomaticAppUpdateDownload(),
				getPreparedAppUpdate().catch(() => null),
			]);
			const action = choosePreparedUpdateAction({
				automaticDownload,
				latest: verdict.latest,
				preparedVersion: prepared?.version ?? null,
			});
			switch (action.kind) {
				case "prompt_install":
					showPreparedUpdatePrompt(verdict, { node });
					return;
				case "clear_and_notify":
					await clearPreparedAppUpdate();
					showDownloadUpdatePrompt(verdict, { node });
					return;
				case "notify_download":
					showDownloadUpdatePrompt(verdict, { node });
					return;
				case "replace":
					await clearPreparedAppUpdate();
					break;
				case "prepare":
					break;
				default: {
					const exhaustive: never = action;
					return exhaustive;
				}
			}
			try {
				const ready = await prepareUpdate(verdict, { node });
				if (ready) {
					showPreparedUpdatePrompt(verdict, { node });
				} else {
					offerManualDownload(
						verdict,
						verdict.html_url ?? "https://ryuhq.com/downloads?ref=ryu-app"
					);
				}
			} catch (error) {
				showPreparationFailure(verdict, { node }, error);
			}
		};

		run().catch(() => undefined);
	}, [getNode]);

	// OPPORTUNISTIC, not the mechanism. If the app happens to be open and the
	// machine awake when the window arrives, install then — that is the one case
	// where a desktop deferral can behave like the node's. It is a supplement to
	// the launch check above, never a replacement: a lid-shut laptop runs no
	// timers, and `dueAppUpdate` compares WALL CLOCK precisely so that a machine
	// which slept through the hour still reports the record as due.
	useEffect(() => {
		const timer = setInterval(
			() => {
				installDeferredUpdate(getNode()).catch(() => undefined);
			},
			10 * 60 * 1000
		);
		return () => clearInterval(timer);
	}, [getNode]);

	return null;
}

/**
 * Install a deferred update whose window has passed. Returns whether one was
 * taken over, so the caller can skip its own check.
 *
 * THE RECORD IS CLEARED BEFORE THE INSTALL, NEVER AFTER — installing replaces
 * this bundle and relaunches, so no line after `installUpdate` is guaranteed to
 * run. A record that survived its own install would come due again on the next
 * launch and reinstall forever. Clearing first costs a genuine failure one
 * missed window instead of a restart loop, which is the same trade Core's
 * scheduler makes.
 *
 * `pinned` is what keeps the promise honest: the stored verdict is the one the
 * user was shown, and re-checking now would resolve the static feed to whatever
 * is newest at THIS moment — a different build, with different release notes,
 * on a machine they deliberately chose not to touch during the day.
 */
async function installDeferredUpdate(node: { url: string }): Promise<boolean> {
	const due = await dueAppUpdate();
	if (!due) {
		return false;
	}
	// The booking may already have been satisfied — by the toast's "Update now",
	// by an auto-install, or by the user installing a build by hand. Nothing else
	// clears the record, so without this the stale one replays forever: the
	// native updater refuses a version that is not newer, we fall back to a
	// "v0.1.5 available" toast shown to someone already on v0.1.5, and the real
	// check for that launch is skipped behind it.
	if (!(await verdictAppliesToApp(due.verdict))) {
		await clearPendingAppUpdate();
		return false;
	}
	// Clearing FIRST, and refusing to install when it fails. Installing replaces
	// this bundle and relaunches, so no line after `installUpdate` is guaranteed
	// to run — a record that survived its own install comes due again next launch
	// and reinstalls forever. If the record cannot be removed at all (a locked or
	// read-only file), the honest move is to leave the normal check to run rather
	// than start a loop nothing can break out of.
	if (!(await clearPendingAppUpdate())) {
		return false;
	}
	await installUpdate(due.verdict, { node, pinned: true });
	return true;
}
