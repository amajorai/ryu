// The Lifetime Desktop trial's name and scope as whole translated literals.
// `DESKTOP_TRIAL_LABEL` and `DESKTOP_TRIAL_INCLUDES` in `@ryu/auth/lib/plans`
// stay the English source; the sibling test keeps these literals equal to them.

import type { LiteralMessage } from "@ryu/i18n/react";

/** "Lifetime Desktop trial", in the active locale. */
export function desktopTrialLabel(tl: LiteralMessage): string {
	return tl("Lifetime Desktop trial");
}

/** What the trial includes and excludes, in the active locale. */
export function desktopTrialIncludes(tl: LiteralMessage): string {
	return tl(
		"Full desktop app access. Managed inference, credits and cloud nodes are not included."
	);
}

/** The access-state title once the trial has run out. */
export function desktopTrialEndedTitle(tl: LiteralMessage): string {
	return tl("Lifetime Desktop trial ended");
}
