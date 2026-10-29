import { decideUpdateEligibility } from "@ryu/auth/lib/plans";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useRef } from "react";
import { sileo } from "sileo";
import {
	choosePreparedUpdateAction,
	resolveAppUpdateSource,
} from "@/src/components/updater/app-update-policy.ts";
import {
	updateToastBody,
	updateToastId,
} from "@/src/components/updater/ReleaseNotes.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	applyNodeUpdate,
	checkForUpdate,
	scheduleNodeUpdate,
	type UpdateCheck,
} from "@/src/lib/api/update.ts";
import {
	clearPreparedAppUpdate,
	getAutomaticAppUpdateDownload,
	getPreparedAppUpdate,
	installPreparedAppUpdate,
	prepareAppUpdate,
} from "@/src/lib/app-update-preparation.ts";
import {
	clearPendingAppUpdate,
	dueAppUpdate,
	getPendingAppUpdate,
} from "@/src/lib/app-update-schedule.ts";
import { getAppVersion, verdictAppliesToApp } from "@/src/lib/app-version.ts";
import {
	getReleaseChannel,
	type ReleaseChannel,
} from "@/src/lib/release-channel.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import {
	formatUpdatesCutoff,
	getUpdatesCutoffMs,
	getUpdatesWindowEnd,
	markNaggedForVersion,
	shouldNagForVersion,
} from "@/src/lib/updates-window.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

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

/**
 * Whether this release can honestly be booked for the quiet hour.
 *
 * A deferral only means anything if the build that lands later is the one the
 * user agreed to now, and that requires all three:
 *
 * - a LOCAL node answered. The verdict is replayed hours later without a
 *     re-check, so a remote node's `tag` would let it choose which signed Ryu
 *     build lands on this machine — the exposure `canPinInstall` exists to
 *     deny. The live "Update now" path is not exposed the same way: it resolves
 *     the static feed, which always yields genuine-latest whatever a node says.
 * - a `tag`. Without one there is nothing to pin to, and the install would
 *     fall through to the static feed and deliver whatever is newest at 03:00.
 * - a FIXED channel. `nightly` / `canary` are rolling pointers, so pinning to
 *     one installs whatever it holds at the window — the unpinned behaviour
 *     with extra steps.
 *
 * Exported so the surface can hide the offer rather than fail at the window.
 * Not offering a promise you cannot keep is the whole point of this feature.
 */
export function canDeferAppUpdate(
	verdict: UpdateCheck,
	node: { url: string } | undefined
): boolean {
	const channel = getReleaseChannel();
	return (
		node !== undefined &&
		isLocalNode(node) &&
		(verdict.tag ?? "") !== "" &&
		channel !== "nightly" &&
		channel !== "canary"
	);
}

/**
 * Prompt a lifetime owner whose updates window has closed: a newer Ryu exists,
 * they are on the newest build their window covers, and they have two ways to
 * get another year.
 *
 * UNPROMPTED, so it is rationed: no-ops unless the verdict is genuinely clamped,
 * and fires AT MOST ONCE per newly-published version — a persistent purchase
 * prompt on every launch forever is a nag trap. A user-initiated install that
 * has to be refused must NOT route through here; it would be swallowed by this
 * budget the moment the launch check already spent it. See
 * {@link notifyUpdateOutsideWindow}.
 */
export async function notifyUpdatesWindowLapsed(
	verdict: UpdateCheck
): Promise<void> {
	if (!verdict.restricted_by_cutoff) {
		return;
	}
	const newest = verdict.latest_unrestricted ?? verdict.latest;
	if (!(newest && shouldNagForVersion(newest))) {
		return;
	}
	markNaggedForVersion(newest);

	const windowEnd = getUpdatesWindowEnd();
	const ended = windowEnd
		? `Your lifetime updates ended on ${formatUpdatesCutoff(windowEnd)}.`
		: "Your lifetime updates have ended.";
	// Only claim a ceiling Core actually computed. `cutoff_unresolved` means it
	// could not resolve the covered build (`latest` is a placeholder), and an
	// UNCLAMPED verdict never had a ceiling computed at all — there `latest` is
	// the absolute newest release, which is the opposite of what this sentence
	// would be asserting.
	// The build named here is the one the user sees in the About/Updates row — the
	// APP's, from Tauri. `verdict.current` is the answering Core's, and the two are
	// separate installs that routinely differ.
	const current = (await getAppVersion()) ?? verdict.current;
	const ceiling =
		verdict.restricted_by_cutoff && !verdict.cutoff_unresolved
			? ` You're on v${current}, and Ryu stays on the newest build they cover.`
			: "";

	sileo.info({
		title: `Ryu v${newest} is out`,
		// Name the redeem URL rather than just the offer: the button below opens
		// Billing, and Billing has no redeem affordance, so "post about Ryu" with no
		// destination is a promise the app cannot keep.
		description: `${ended}${ceiling} Buy lifetime access again at the current price for another year — or post about Ryu at ryu.com/redeem to earn a free year.`,
		duration: null,
		button: {
			title: "Extend updates",
			onClick: () => {
				useSettingsDialog.getState().openSettings("billing");
			},
		},
	});
}

/**
 * Refuse a user-initiated install that falls outside the owner's updates window.
 *
 * The counterpart to {@link notifyUpdatesWindowLapsed}, and deliberately NOT
 * rationed. That one is an unprompted launch nag with a once-per-version budget;
 * this one answers a button the user just pressed, and the launch check has
 * normally already spent that budget on the same version. Routing this through
 * it made the Download Center, Preflight and node-selector Update actions
 * silently do nothing — the exact dead-button state the guard was added to fix.
 *
 * Answers factually and dismisses itself: an explicit action deserves an
 * explicit answer, not a persistent purchase prompt.
 */
function notifyUpdateOutsideWindow(verdict: UpdateCheck): void {
	const windowEnd = getUpdatesWindowEnd();
	const ended = windowEnd
		? `your lifetime updates ended on ${formatUpdatesCutoff(windowEnd)}`
		: "your lifetime updates have ended";
	sileo.info({
		title: `v${verdict.latest} is outside your updates window`,
		description: `Ryu did not install it because ${ended}. Buy lifetime access again at the current price for another year — or post about Ryu at ryu.com/redeem to earn a free year.`,
		duration: 8000,
		button: {
			title: "Extend updates",
			onClick: () => {
				useSettingsDialog.getState().openSettings("billing");
			},
		},
	});
}

interface AppUpdateOptions {
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

function sourceForUpdate(verdict: UpdateCheck, options?: AppUpdateOptions) {
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
async function prepareAndPrompt(
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

function showPreparationFailure<TError>(
	verdict: UpdateCheck,
	options: AppUpdateOptions | undefined,
	error: TError
): void {
	sileo.error({
		title: "Update download failed",
		description: error instanceof Error ? error.message : String(error),
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
function offerManualDownload(verdict: UpdateCheck, downloadsUrl: string): void {
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
function canPinInstall(
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
					description:
						error instanceof Error
							? error.message
							: "Close and reopen Ryu to finish loading the update.",
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
			description: error instanceof Error ? error.message : String(error),
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
