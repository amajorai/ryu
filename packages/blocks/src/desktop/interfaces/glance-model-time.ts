import { activeLocale, dateFormatter, translate as tr } from "@ryu/i18n/lite";

/** Glance clock faces and upcoming-run times, in the UI locale. */

export interface GlanceClock {
	/** "Tuesday, October 13" */
	date: string;
	/** "AM"/"PM" in 12-hour locales, null in 24-hour ones. */
	period: string | null;
	/** "9:41" */
	time: string;
}

export function glanceClock(
	now: Date,
	locale: string = activeLocale()
): GlanceClock {
	const parts = dateFormatter(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).formatToParts(now);
	let time = "";
	let period: string | null = null;
	for (const part of parts) {
		if (part.type === "dayPeriod") {
			period = part.value.trim();
		} else if (part.type !== "literal" || time !== "") {
			time += part.value;
		}
	}
	return {
		date: dateFormatter(locale, {
			day: "numeric",
			month: "long",
			weekday: "long",
		}).format(now),
		period,
		time: time.trim(),
	};
}

export const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function startOfDay(date: Date): number {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate()
	).getTime();
}

/** When an upcoming run starts, phrased for a glance in the same units as thread ages: "in 40m", "Tomorrow 9 AM". */
export function glanceRunWhen(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const until = start - now;
	if (until < MINUTE_MS) {
		return tr("Now");
	}
	const minutes = Math.round(until / MINUTE_MS);
	if (minutes < 60) {
		return tr("in {minutes}m", { minutes });
	}
	const date = new Date(start);
	const days = Math.round(
		(startOfDay(date) - startOfDay(new Date(now))) / DAY_MS
	);
	const time = dateFormatter(locale, {
		hour: "numeric",
		minute: date.getMinutes() === 0 ? undefined : "2-digit",
	}).format(date);
	if (days <= 0) {
		return until < 6 * HOUR_MS
			? tr("in {hours}h", { hours: Math.round(until / HOUR_MS) })
			: tr("Today {time}", { time });
	}
	if (days === 1) {
		return tr("Tomorrow {time}", { time });
	}
	if (days < 7) {
		const weekday = dateFormatter(locale, {
			weekday: "short",
		}).format(date);
		return `${weekday} ${time}`;
	}
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
	}).format(date);
}
