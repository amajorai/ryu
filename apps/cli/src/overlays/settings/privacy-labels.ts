// Privacy settings copy that is spliced into other text or picked at runtime:
// the noun phrase a failed save names ("Couldn't save the analytics choice:
// …") and the support-access state. Each is an explicit `tr`/`tf` literal so
// the catalog extractor collects it and the reader sees it translated.

import { formatCliDateTime } from "../../i18n/format.ts";
import { tf, tr } from "../../i18n/translate.ts";
import type { PrivacyPreferences } from "./privacy-preferences.ts";

/** The preferences a privacy save can write, as named in its error. */
export type PrivacySaveTarget =
	| "analytics"
	| "community"
	| "profileActivity"
	| "crashReports"
	| "diagnosticsExport"
	| "diagnosticsEndpoint"
	| "diagnosticsContentMode"
	| "supportAccess";

/**
 * What "Couldn't save {label}" names for a save, in the reader's language.
 * `supportAccess` is whether access is on before the toggle (so the save ends it).
 */
export function privacySaveLabel(
	target: PrivacySaveTarget,
	supportAccess: boolean
): string {
	switch (target) {
		case "analytics":
			return tr("the analytics choice");
		case "community":
			return tr("the community-stats choice");
		case "profileActivity":
			return tr("the profile-activity choice");
		case "crashReports":
			return tr("the crash-report choice");
		case "diagnosticsExport":
			return tr("the diagnostics-export choice");
		case "diagnosticsEndpoint":
			return tr("the diagnostics endpoint");
		case "diagnosticsContentMode":
			return tr("the diagnostics content mode");
		default:
			return supportAccess
				? tr("ending support access")
				: tr("granting support access");
	}
}

/** The support-access row's value: on (until when), expired, or off. */
export function supportStateLabel(
	preferences: Pick<PrivacyPreferences, "supportAccess" | "supportExpiry">,
	now: number
): string {
	if (!preferences.supportAccess) {
		return tr("OFF");
	}
	if (preferences.supportExpiry === 0) {
		return tr("ON · no expiry");
	}
	if (now < preferences.supportExpiry) {
		return tf("ON until {date}", {
			date: formatCliDateTime(preferences.supportExpiry) ?? "",
		});
	}
	return tr("Expired");
}
