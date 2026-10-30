import type { InterfaceAgent, ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { Community, CommunityPost } from "./community-model.ts";

const AGE_STEPS: readonly [number, string, string][] = [
	[60, "min.", "min."],
	[24, "hr.", "hr."],
	[30, "day", "days"],
	[12, "mo.", "mo."],
	[Number.POSITIVE_INFINITY, "yr.", "yr."],
];

/** Reddit's relative time: "just now", "5 min. ago", "2 days ago". */
export function redditAge(iso: string, now: number): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) {
		return "";
	}
	let value = Math.floor(Math.max(0, now - time) / 60_000);
	if (value < 1) {
		return "just now";
	}
	for (const [size, one, many] of AGE_STEPS) {
		if (value < size) {
			return `${value} ${value === 1 ? one : many} ago`;
		}
		value = Math.floor(value / size);
	}
	return "";
}

/** Reddit's short counts: 999, 1k, 1.2k, 12k. */
export function shortCount(value: number): string {
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

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
		return "Interrupted";
	}
	return STATUS_FLAIR[post.status];
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

const ABSOLUTE = new Intl.DateTimeFormat("en", {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
	year: "numeric",
});

/** A full timestamp for `title` attributes. */
export function absoluteTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : ABSOLUTE.format(time);
}
