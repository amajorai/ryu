import type { LiteralMessage } from "@ryu/i18n/react";
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
	verdict: UpdateCheck,
	tl: LiteralMessage
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
		? tl("Your lifetime updates ended on {cutoffDate}.", {
				cutoffDate: formatUpdatesCutoff(windowEnd),
			})
		: tl("Your lifetime updates have ended.");
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
			? tl(
					"You're on v{currentVersion}, and Ryu stays on the newest build they cover.",
					{
						currentVersion: current,
					}
				)
			: "";

	sileo.info({
		title: tl("Ryu v{newestVersion} is out", { newestVersion: newest }),
		// Name the redeem URL rather than just the offer: the button below opens
		// Billing, and Billing has no redeem affordance, so the free-year path is
		// only reachable if the notice itself names where it lives.
		description: [
			ended,
			ceiling,
			tl("Renew, or earn a free year at ryu.com/redeem."),
		]
			.filter(Boolean)
			.join(" "),
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
export function notifyUpdateOutsideWindow(
	verdict: UpdateCheck,
	tl: LiteralMessage
): void {
	const windowEnd = getUpdatesWindowEnd();
	sileo.info({
		title: tl("v{latest} is outside your updates window", {
			latest: verdict.latest,
		}),
		description: windowEnd
			? tl(
					"Ryu did not install it because your lifetime updates ended on {cutoffDate}. Renew, or earn a free year at ryu.com/redeem.",
					{ cutoffDate: formatUpdatesCutoff(windowEnd) }
				)
			: tl(
					"Ryu did not install it because your lifetime updates have ended. Renew, or earn a free year at ryu.com/redeem."
				),
		duration: 8000,
		button: {
			title: "Renew",
			onClick: () => {
				useSettingsDialog.getState().openSettings("billing");
			},
		},
	});
}
