// packages/blocks/src/desktop/model-byte-label.ts
//
// Model catalog sizes (file sizes, RAM, GPU memory, free disk) in the UI
// language. Core sends each size twice: the byte count and an English
// `*_human` string from `human_bytes` (`crates/core/model-catalog/src/device.rs`).
// This formats the byte count with the same rounding, so English reads exactly
// as Core wrote it ("4.9 GB") and other locales get their own decimal mark and
// unit ("4,9 GB"). The English string is only the fallback for a missing count.

import { activeLocale } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";

const MIB = 1024 * 1024;

/**
 * A model or device size from its byte count, rounded like Core's
 * `human_bytes`: whole bytes below 1 MiB, whole MB below 1 GiB, one decimal in
 * GB below 100 GB, then whole GB (never TB). Without a usable byte count it
 * returns `fallback` (Core's English string), or "" when that is missing too.
 */
export function modelBytesLabel(
	bytes: number | null | undefined,
	fallback: string | null | undefined,
	locale: string = activeLocale()
): string {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
		return fallback ?? "";
	}
	if (bytes < MIB) {
		return formatByteSize(bytes, locale, { maxUnit: "byte" });
	}
	return formatByteSize(bytes, locale, {
		fractionDigits: (value, unit) =>
			unit === "gigabyte" && value < 100 ? 1 : 0,
		maxUnit: "gigabyte",
		minUnit: "megabyte",
	});
}
