import { localDayKey } from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";

export function clockTime(date: Date): string {
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

/** "Today", "Yesterday", "Tomorrow", or "Mon 12 Oct". */
export function dayLabel(date: Date, now: number): string {
	const key = localDayKey(date);
	const today = new Date(now);
	if (key === localDayKey(today)) {
		return "Today";
	}
	const yesterday = new Date(now);
	yesterday.setDate(today.getDate() - 1);
	if (key === localDayKey(yesterday)) {
		return "Yesterday";
	}
	const tomorrow = new Date(now);
	tomorrow.setDate(today.getDate() + 1);
	if (key === localDayKey(tomorrow)) {
		return "Tomorrow";
	}
	return date.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		weekday: "short",
	});
}

/** dayLabel for mid-sentence use: "today", "yesterday", or "on Sat, Oct 17". */
export function dayPhrase(date: Date, now: number): string {
	const label = dayLabel(date, now);
	return ["Today", "Tomorrow", "Yesterday"].includes(label)
		? label.toLowerCase()
		: `on ${label}`;
}

/** "3 min ago", "2 hr ago", "4 days ago": the long form of compactAge. */
export function relativeAge(iso: string, now: number): string {
	const compact = compactAge(iso, now);
	if (!compact) {
		return "";
	}
	if (compact === "now") {
		return "just now";
	}
	const value = Number.parseInt(compact, 10);
	const unit = compact.slice(String(value).length);
	const names: Record<string, [string, string]> = {
		d: ["day", "days"],
		h: ["hr", "hr"],
		m: ["min", "min"],
		s: ["sec", "sec"],
		w: ["wk", "wk"],
	};
	const [one, many] = names[unit] ?? ["", ""];
	return `${value} ${value === 1 ? one : many} ago`;
}
