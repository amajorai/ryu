// The hardware panel's byte sizes (RAM, disk, VRAM) in the viewer's number
// format: "41.3 GB" in English, "41,3 GB" in German, the locale's own digits
// and unit names elsewhere. Core sends English `*_human` strings next to the
// raw byte counts; those strings are only the fallback when a count is absent.

import { activeLocale } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";

const MIB = 1024 ** 2;

/**
 * A byte count rounded the way Core's `human_bytes` rounds it (base 1024,
 * whole bytes below 1 MB, whole megabytes, gigabytes with one decimal below
 * 100 and none from 100 up), in `locale`'s number format. Falls back to
 * Core's preformatted `human` string when the count is missing.
 */
export function fmtBytes(
	bytes: number | null | undefined,
	human: string,
	locale: string = activeLocale()
): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
		return human;
	}
	const count = Math.max(0, bytes);
	if (count < MIB) {
		return formatByteSize(count, locale, { maxUnit: "byte" });
	}
	return formatByteSize(count, locale, {
		fractionDigits: (value, unit) =>
			unit === "gigabyte" && value < 100 ? 1 : 0,
		maxUnit: "gigabyte",
		minUnit: "megabyte",
	});
}

export interface UsageAmounts {
	totalBytes: number | null;
	totalHuman: string;
	usedBytes: number | null;
	usedHuman: string;
}

/**
 * "41.3 GB / 63.7 GB": used over total as one translatable sentence, or
 * whichever side is known when the other is missing ("" when neither is).
 */
export function usageText(
	amounts: UsageAmounts,
	tl: LiteralMessage,
	locale: string = activeLocale()
): string {
	const used = fmtBytes(amounts.usedBytes, amounts.usedHuman, locale);
	const total = fmtBytes(amounts.totalBytes, amounts.totalHuman, locale);
	if (used && total) {
		return tl("{used} / {total}", { total, used });
	}
	return total || used;
}
