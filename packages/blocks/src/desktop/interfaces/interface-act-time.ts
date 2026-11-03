import {
	activeLocale,
	dateFormatter,
	isEnglishLocale,
	numberFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import { actDayOffset, actDuration } from "@ryuhq/protocol/interface-act-parts";
import type { ClockOptions } from "@ryuhq/protocol/interfaces";

/*
 * The act layer's times in the UI language. Same counting as the protocol's
 * `waitLabel` and `clockLabel` (ages round down, countdowns round up; today,
 * tomorrow, a weekday, a date), with every word and unit from the catalog or
 * `Intl`. In English they read exactly as the protocol helpers do.
 */

const CJK_UNIT_GAP = /(\d)[\s  ]+(?=[぀-ヿ㐀-鿿가-힯])/gu;
const UNIT_INITIAL = { day: "d", hour: "h", minute: "m" } as const;

function english(locale: string): boolean {
	return isEnglishLocale(locale);
}

function unitText(
	value: number,
	unit: "day" | "hour" | "minute",
	display: "long" | "short",
	locale: string
): string {
	return numberFormatter(locale, { style: "unit", unit, unitDisplay: display })
		.format(value)
		.replace(CJK_UNIT_GAP, "$1");
}

/**
 * A whole duration: "14 minutes" / "3 hours" (long, for accessible names) or
 * "14m" / "3h" (short); "less than a minute" / "<1m" under a minute.
 */
export function actDurationLabel(
	ms: number,
	{ long = false, roundUp = false }: { long?: boolean; roundUp?: boolean } = {}
): string {
	const locale = activeLocale();
	const part = actDuration(ms, roundUp);
	if (!part) {
		if (long) {
			return tr("less than a minute");
		}
		return english(locale)
			? "<1m"
			: `<${unitText(1, "minute", "short", locale)}`;
	}
	if (long) {
		return unitText(part.value, part.unit, "long", locale);
	}
	return english(locale)
		? `${part.value}${UNIT_INITIAL[part.unit]}`
		: unitText(part.value, part.unit, "short", locale);
}

function parseMs(iso: string | null | undefined): number | null {
	if (!iso) {
		return null;
	}
	const value = Date.parse(iso);
	return Number.isFinite(value) ? value : null;
}

/**
 * The protocol's `waitLabel` in the UI language: "14m", "~14m", "in 4m",
 * "≤ 4m"; long: "14 minutes", "about 14 minutes", "within 4 minutes".
 */
export function waitLabel(
	since: string | null,
	nowMs: number,
	opts?: {
		approx?: boolean;
		long?: boolean;
		until?: string | null;
		untilApprox?: boolean;
	}
): string | null {
	const long = opts?.long === true;
	const until = parseMs(opts?.until);
	if (until !== null) {
		const left = actDurationLabel(until - nowMs, { long, roundUp: true });
		if (opts?.untilApprox) {
			return long ? tr("within {duration}", { duration: left }) : `≤ ${left}`;
		}
		return tr("in {duration}", { duration: left });
	}
	const start = parseMs(since);
	if (start === null) {
		return null;
	}
	const age = actDurationLabel(nowMs - start, { long });
	if (!opts?.approx) {
		return age;
	}
	return long ? tr("about {duration}", { duration: age }) : `~${age}`;
}

/**
 * The protocol's `clockLabel` in the UI language: the time today,
 * "tomorrow 09:00", a short weekday within six days, else a short date.
 */
export function clockLabel(
	iso: string,
	nowMs: number,
	opts?: ClockOptions
): string {
	const at = parseMs(iso);
	if (at === null) {
		return iso;
	}
	const locale = opts?.locale ?? activeLocale();
	const timeZone = opts?.timeZone;
	const time = dateFormatter(locale, {
		hour: "2-digit",
		minute: "2-digit",
		timeZone,
	}).format(at);
	const days = actDayOffset(iso, nowMs, opts) ?? 0;
	if (days === 0) {
		return time;
	}
	if (days === 1) {
		return tr("tomorrow {time}", { time });
	}
	const day =
		days > 1 && days <= 6
			? dateFormatter(locale, { timeZone, weekday: "short" }).format(at)
			: dateFormatter(locale, {
					day: "numeric",
					month: "short",
					timeZone,
				}).format(at);
	return `${day} ${time}`;
}
