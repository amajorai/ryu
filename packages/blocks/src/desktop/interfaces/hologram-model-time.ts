import {
	activeLocale,
	dateFormatter,
	isEnglishLocale,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import { type InterfaceThread, threadStatus } from "@ryuhq/protocol/interfaces";
import { DAY, MINUTE } from "./hologram-model.ts";
import { threadStatusLabel } from "./interface-renderer.ts";

/** Hologram clocks, date stamps, countdowns and status phrases, in the UI locale. */

const pad = (value: number) => String(value).padStart(2, "0");

/** 24-hour local clock, "19:42" or "19:42:07". */
export function clock(time: number, seconds = false): string {
	const date = new Date(time);
	const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return seconds ? `${base}:${pad(date.getSeconds())}` : base;
}

/**
 * "WED 14 OCT" in English; the locale's short weekday and date elsewhere,
 * upper-cased where the script has letter case ("MI., 14. OKT.").
 */
export function dateStamp(
	time: number,
	locale: string = activeLocale()
): string {
	const english = isEnglishLocale(locale);
	return dateFormatter(english ? "en-GB" : locale, {
		day: "2-digit",
		month: "short",
		weekday: "short",
	})
		.format(new Date(time))
		.toLocaleUpperCase(english ? "en" : locale);
}

/**
 * Which day a time falls on, relative to now: "Today", a weekday within the
 * week either side ("Thu"), or a date beyond that ("23 Oct").
 */
export function dayTag(
	time: number,
	now: number,
	locale: string = activeLocale()
): string {
	const date = new Date(time);
	const startOf = (value: Date) =>
		new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
	const days = Math.round((startOf(date) - startOf(new Date(now))) / DAY);
	if (days === 0) {
		return tr("Today");
	}
	if (Math.abs(days) < 7) {
		return dateFormatter(locale, { weekday: "short" }).format(date);
	}
	return dateFormatter(isEnglishLocale(locale) ? "en-GB" : locale, {
		day: "numeric",
		month: "short",
	}).format(date);
}

/** "in 40m", "in 3h", "in 2d" (or "now") until an upcoming start. */
export function countdown(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const minutes = Math.round((start - now) / MINUTE);
	const relative = relativeTimeFormatter(locale, "narrow", "always");
	if (minutes < 1) {
		return relativeTimeFormatter(locale, "narrow").format(0, "second");
	}
	if (minutes < 60) {
		return relative.format(minutes, "minute");
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return relative.format(hours, "hour");
	}
	return relative.format(Math.round(hours / 24), "day");
}

/** Short status phrase for a thread's meta line. */
export function statusPhrase(thread: InterfaceThread): string {
	const status = threadStatus(thread);
	if (status === "attention") {
		return thread.runState === "interrupted"
			? tr("Run interrupted")
			: tr("Run failed");
	}
	return status === "working" ? tr("Running") : threadStatusLabel(status);
}
