import { localDayKey } from "@ryuhq/protocol/interfaces";
import { HOUR_MS } from "./mission-control-model-types.ts";

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** 24-hour wall-clock time, `HH:MM:SS`. */
export function clockTime(at: number): { hours: string; seconds: string } {
	const date = new Date(at);
	return {
		hours: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
		seconds: pad(date.getSeconds()),
	};
}

/** `HH:MM` for a timestamp, or an empty string when it is not a date. */
export function shortTime(iso: string | number): string {
	const at = typeof iso === "number" ? iso : Date.parse(iso);
	if (Number.isNaN(at)) {
		return "";
	}
	const date = new Date(at);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The local UTC offset, e.g. `UTC+2` or `UTC-5:30`. */
export function utcOffsetLabel(at: number): string {
	const offset = -new Date(at).getTimezoneOffset();
	if (offset === 0) {
		return "UTC";
	}
	const sign = offset > 0 ? "+" : "-";
	const hours = Math.floor(Math.abs(offset) / 60);
	const minutes = Math.abs(offset) % 60;
	return `UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ""}`;
}

/**
 * Time to a run in one unit style: `59m 56s` within the hour, `5h 20m` within
 * a day, `2d 4h` beyond, and `Due` once it has passed. Seconds only show in
 * the final hour.
 */
export function countdown(target: string, now: number): string {
	const at = Date.parse(target);
	if (Number.isNaN(at)) {
		return "";
	}
	const seconds = Math.floor((at - now) / 1000);
	if (seconds <= 0) {
		return "Due";
	}
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m ${pad(seconds % 60)}s`;
}

/** Whether a countdown to `target` currently shows seconds. */
export function countdownTicks(target: string, now: number): boolean {
	const left = Date.parse(target) - now;
	return left > 0 && left < HOUR_MS;
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const DAY_MONTH = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});

/** `Tue 13 Oct`-style date in the user's locale. */
export function clockDate(at: number): string {
	const date = new Date(at);
	return `${WEEKDAY.format(date)} ${DAY_MONTH.format(date)}`;
}

/** When an upcoming run starts, relative to today: `15:00`, `Tomorrow 09:00`, `Fri 17:00`. */
export function runWhen(start: string, now: number): string {
	const at = Date.parse(start);
	if (Number.isNaN(at)) {
		return "";
	}
	const date = new Date(at);
	const today = new Date(now);
	const time = shortTime(at);
	if (localDayKey(date) === localDayKey(today)) {
		return time;
	}
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	if (localDayKey(date) === localDayKey(tomorrow)) {
		return `Tomorrow ${time}`;
	}
	if (at - now < 6 * 86_400_000) {
		return `${WEEKDAY.format(date)} ${time}`;
	}
	return `${DAY_MONTH.format(date)} ${time}`;
}
