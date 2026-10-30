import { sileo } from "sileo";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import { getAppVersion } from "@/src/lib/app-version.ts";
import {
	formatUpdatesCutoff,
	getUpdatesWindowEnd,
	markNaggedForVersion,
	shouldNagForVersion,
} from "@/src/lib/updates-window.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

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
