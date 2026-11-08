import type { OnboardingLocalError } from "@ryu/blocks/desktop/onboarding-types.ts";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	desktopCommandErrorText,
	desktopCommandRejectionText,
} from "@/src/lib/desktop-command-error-messages.ts";

/**
 * The onboarding card's reason for a failed `ensure_core_installed` or
 * `start_ryu_core`: the coded rejection's whole translated sentence, with the
 * raw installer/OS text kept only as the technical detail. An uncoded
 * rejection (an older native build, a bridge failure) gets the generic
 * sentence and keeps its text as the detail, so nothing English becomes the
 * sentence itself.
 */
export function localCoreErrorText(
	error: unknown,
	tl: LiteralMessage
): OnboardingLocalError {
	const coded = desktopCommandErrorText(error, tl);
	if (coded) {
		return coded;
	}
	const raw = (desktopCommandRejectionText(error) ?? String(error)).trim();
	return {
		message: tl("Ryu could not start its local runtime."),
		detail: raw === "" ? null : raw,
	};
}
