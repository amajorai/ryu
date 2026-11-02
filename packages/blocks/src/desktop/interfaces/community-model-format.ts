import {
	activeLocale,
	formatRelativeTime,
	isEnglishLocale,
	numberFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import type { InterfaceAgent, ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { Community, CommunityPost } from "./community-model.ts";
import { fullTimestamp, threadStatusLabel } from "./interface-renderer.ts";

/**
 * Reddit's relative time in the UI locale: "just now", "5 min. ago",
 * "2 days ago" in English; "vor 5 Min." in German.
 */
export function redditAge(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) {
		return "";
	}
	if (now - time < 60_000) {
		return tr("just now");
	}
	return formatRelativeTime(locale, time, {
		now,
		numeric: "always",
		style: "short",
	});
}

/** Reddit's short counts: 999, 1k, 1.2k, 12k (the locale's compact form elsewhere). */
export function shortCount(
	value: number,
	locale: string = activeLocale()
): string {
	if (!isEnglishLocale(locale)) {
		return numberFormatter(locale, {
			maximumFractionDigits: 1,
			notation: "compact",
		}).format(value);
	}
	if (Math.abs(value) < 1000) {
		return String(value);
	}
	const thousands = value / 1000;
	const rounded =
		Math.abs(thousands) >= 10
			? Math.round(thousands)
			: Math.round(thousands * 10) / 10;
	return `${rounded}k`;
}

/** "3 threads": a community's thread count, as an ICU message. */
export function threadCountLabel(count: number): string {
	return tr("{count, plural, one {# thread} other {# threads}}", {
		count,
	});
}

/** The short flair a post carries for its status. */
export const STATUS_FLAIR: Record<ThreadStatus, string> = {
	attention: "Run failed",
	quiet: "Not started",
	waiting: "Waiting on agent",
	working: "Working",
	"your-turn": "Your turn",
};

/** A post's flair text: interrupted runs say so instead of "failed". */
export function flairLabel(post: CommunityPost): string {
	if (post.status === "attention" && post.thread.runState === "interrupted") {
		return tr("Interrupted");
	}
	return post.status === "attention"
		? tr("Run failed")
		: threadStatusLabel(post.status);
}

/** `r/WebsiteRedesign`, `u/you`. */
export function communityLabel(community: Community): string {
	return `${community.prefix}${community.handle}`;
}

/** `u/forge` for an agent poster, `u/you` with none. */
export function posterLabel(agent: InterfaceAgent | null): string {
	if (!agent) {
		return "u/you";
	}
	const handle = agent.name.toLowerCase().replace(/[^a-z0-9_]+/g, "");
	return `u/${handle || "agent"}`;
}

/** A full timestamp for `title` attributes, in the UI locale. */
export function absoluteTime(iso: string): string {
	return fullTimestamp(iso);
}
