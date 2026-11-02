// Provider-usage readouts for the Monitors picker and detail: "42.5% used ·
// resets in 3 hours" in the UI language, with the locale's own decimal
// separator, percent sign and relative time instead of a raw ISO timestamp.

import type { LiteralMessage } from "@ryu/i18n";
import { activeLocale } from "@ryu/i18n/core";
import { formatRelativeTime } from "@ryu/i18n/format-intl";
import {
	formatDecimal,
	formatPercentValue,
} from "./agent-elements/locale-format.ts";

/** When a usage window resets, relative to now ("in 3 hours"); the raw value
 *  when it does not parse as a date. */
export function formatUsageReset(
	resetsAt: string,
	locale: string = activeLocale()
): string {
	return formatRelativeTime(locale, resetsAt) || resetsAt;
}

/** "42.5% used", with " · resets in 3 hours" when the window reports a reset. */
export function usageWindowDetail(
	usedPercent: number,
	resetsAt: string | null | undefined,
	tl: LiteralMessage
): string {
	const percent = formatPercentValue(usedPercent, 1);
	if (!resetsAt) {
		return tl("{percent} used", { percent });
	}
	return tl("{percent} used · resets {when}", {
		percent,
		when: formatUsageReset(resetsAt),
	});
}

/** "1.23 tokens", with " · resets in 3 hours" when the meter reports a reset. */
export function usageMeterDetail(
	value: number,
	unit: string,
	resetsAt: string | null | undefined,
	tl: LiteralMessage
): string {
	const amount = `${formatDecimal(value, 2)} ${unit}`.trim();
	if (!resetsAt) {
		return amount;
	}
	return tl("{amount} · resets {when}", {
		amount,
		when: formatUsageReset(resetsAt),
	});
}
