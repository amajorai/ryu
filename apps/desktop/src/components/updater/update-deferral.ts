import { sileo } from "sileo";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import {
	clearPendingAppUpdate,
	dueAppUpdate,
} from "@/src/lib/app-update-schedule.ts";
import { getAppVersion, verdictAppliesToApp } from "@/src/lib/app-version.ts";
import { getReleaseChannel } from "@/src/lib/release-channel.ts";
import {
	formatUpdatesCutoff,
	getUpdatesWindowEnd,
	markNaggedForVersion,
	shouldNagForVersion,
} from "@/src/lib/updates-window.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { installUpdate } from "./update-install.ts";

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
export async function installDeferredUpdate(node: {
	url: string;
}): Promise<boolean> {
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
		// Billing, and Billing has no redeem affordance, so the free-year path is
		// only reachable if the notice itself names where it lives.
		description: `${ended}${ceiling} Renew, or earn a free year at ryu.com/redeem.`,
		duration: null,
		button: {
			title: "Renew",
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
export function notifyUpdateOutsideWindow(verdict: UpdateCheck): void {
	const windowEnd = getUpdatesWindowEnd();
	const ended = windowEnd
		? `your lifetime updates ended on ${formatUpdatesCutoff(windowEnd)}`
		: "your lifetime updates have ended";
	sileo.info({
		title: `v${verdict.latest} is outside your updates window`,
		description: `Ryu did not install it because ${ended}. Renew, or earn a free year at ryu.com/redeem.`,
		duration: 8000,
		button: {
			title: "Renew",
			onClick: () => {
				useSettingsDialog.getState().openSettings("billing");
			},
		},
	});
}
