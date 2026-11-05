import type { LiteralMessage } from "@ryu/i18n/react";
import { TEAMS_MAX_SEATS } from "./pricing-seat-model.ts";

// The organization seat stepper's spoken value. Each case is a whole message,
// so a screen reader hears the locale's own plural ("12 Plätze"), and the step
// past the Teams maximum (the Enterprise handoff, shown as "51+") is its own
// sentence instead of an English "51+ seats" the DOM localizer can only match
// against an unrelated "{plan} seats" template.

/** The stepper's value text: "12 seats", or "51+ seats" past the Teams maximum. */
export function organizationSeatValueText(
	tl: LiteralMessage,
	value: number
): string {
	if (value > TEAMS_MAX_SEATS) {
		return tl("{minimum}+ seats", { minimum: TEAMS_MAX_SEATS + 1 });
	}
	return tl("{count, plural, one {# seat} other {# seats}}", { count: value });
}
