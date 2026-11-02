import { activeLocale, dateFormatter, translate as tr } from "@ryu/i18n/lite";

/** The hub's ambient clock, date and greeting, in the UI locale. */

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface HubClock {
	/** "AM"/"PM" in 12-hour locales, empty in 24-hour ones. */
	dayPeriod: string;
	/** "10:42" without the day period, like the reference's ambient clock. */
	time: string;
}

/** "22:42", the machine-readable form for a `<time>` element. */
export function hubClockDateTime(now: number): string {
	const date = new Date(now);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function hubClock(
	now: number,
	locale: string = activeLocale()
): HubClock {
	const parts = dateFormatter(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).formatToParts(new Date(now));
	let time = "";
	let dayPeriod = "";
	for (const part of parts) {
		if (part.type === "dayPeriod") {
			dayPeriod = part.value;
		} else {
			time += part.value;
		}
	}
	return { dayPeriod, time: time.trim() };
}

/** "Wednesday, October 14". */
export function hubDate(now: number, locale: string = activeLocale()): string {
	return dateFormatter(locale, {
		day: "numeric",
		month: "long",
		weekday: "long",
	}).format(new Date(now));
}

export function hubGreeting(now: number): string {
	const hour = new Date(now).getHours();
	if (hour < 5) {
		return tr("Good evening");
	}
	if (hour < 12) {
		return tr("Good morning");
	}
	if (hour < 18) {
		return tr("Good afternoon");
	}
	return tr("Good evening");
}
