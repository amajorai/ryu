// packages/blocks/src/session-box/cost-notice-copy.ts
//
// The copy of the one-time computer-use cost notice and the rate shown in
// Computer Use settings. Every sentence is one whole ICU message: the Box
// size and the per-start minimum are selected inside the message (so the
// size names, their specs and the minimum's units translate with it), and the
// hourly rate is a USD amount in the reader's locale (`$0.025`, `0,025 $`).

import {
	activeLocale,
	isEnglishLocale,
	numberFormatter,
	unitFormatter,
} from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { SessionBoxCostNotice } from "./wire.ts";

/**
 * An hourly rate in micro-USD as a USD amount in `locale`, with at least
 * cents and no trailing zeros past them: in English `25000` is `$0.025` and
 * `40000` is `$0.04`; in German `25000` is `0,025 $`.
 */
export function formatHourlyRate(
	microUsd: number,
	locale: string = activeLocale()
): string {
	return numberFormatter(locale, {
		currency: "USD",
		maximumFractionDigits: 6,
		minimumFractionDigits: 2,
		style: "currency",
	}).format(microUsd / 1_000_000);
}

interface MinimumValues {
	count: number;
	unit: "minute" | "second";
}

function minimumValues(seconds: number): MinimumValues {
	return seconds % 60 === 0 && seconds > 0
		? { count: seconds / 60, unit: "minute" }
		: { count: seconds, unit: "second" };
}

/**
 * A per-start minimum for a value slot inside an already translated
 * sentence: the English compound adjective (`5-minute`, `90-second`) in
 * English, and the locale's own duration elsewhere (`5 Minuten`, `5分`).
 * Whole sentences select the minimum inside the message instead.
 */
export function minimumStartWords(
	seconds: number,
	locale: string = activeLocale()
): string {
	const { count, unit } = minimumValues(seconds);
	if (isEnglishLocale(locale)) {
		return `${count}-${unit}`;
	}
	return unitFormatter(locale, unit, "long").format(count);
}

/** The notice's heading: what starts, at what rate, with the minimum. */
export function costNoticeHeading(
	notice: SessionBoxCostNotice,
	tl: LiteralMessage
): string {
	if (notice.ratePerHourMicroUsd === null) {
		return tl("Computer use starts a paid cloud Box");
	}
	return tl(
		"Computer use starts a cloud Box at {hourlyRate}/hour, {unit, select, minute {{count, plural, one {#-minute} other {#-minute}}} other {{count, plural, one {#-second} other {#-second}}}} minimum per start",
		{
			...minimumValues(notice.minimumSecondsPerStart),
			hourlyRate: formatHourlyRate(notice.ratePerHourMicroUsd),
		}
	);
}

/** The notice's sentence about what starts and what it costs. */
export function costNoticeText(
	notice: SessionBoxCostNotice,
	tl: LiteralMessage
): string {
	const size = notice.size ?? "small";
	const minimum = minimumValues(notice.minimumSecondsPerStart);
	if (notice.ratePerHourMicroUsd === null) {
		return tl(
			"Computer use and the browser run on a cloud Box of its own ({size, select, large {large: 8 vCPU, 16 GB} default {default: 4 vCPU, 8 GB} other {small: 2 vCPU, 4 GB}}), and Ryu could not read its hourly rate right now. Time is billed in whole minutes with a {unit, select, minute {{count, plural, one {#-minute} other {#-minute}}} other {{count, plural, one {#-second} other {#-second}}}} minimum each time the Box starts; a resume within the hour already paid owes no new minimum. It parks when idle and stops when credits run out. Ryu asks once.",
			{ ...minimum, size }
		);
	}
	return tl(
		"Computer use and the browser run on a cloud Box of its own ({size, select, large {large: 8 vCPU, 16 GB} default {default: 4 vCPU, 8 GB} other {small: 2 vCPU, 4 GB}}), and it costs {hourlyRate} an hour while it runs, from your credits. Time is billed in whole minutes with a {unit, select, minute {{count, plural, one {#-minute} other {#-minute}}} other {{count, plural, one {#-second} other {#-second}}}} minimum each time the Box starts; a resume within the hour already paid owes no new minimum. It parks when idle and stops when credits run out. Ryu asks once.",
		{
			...minimum,
			hourlyRate: formatHourlyRate(notice.ratePerHourMicroUsd),
			size,
		}
	);
}
