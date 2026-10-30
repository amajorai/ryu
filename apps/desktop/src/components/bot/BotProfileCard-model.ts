import {
	Activity01Icon,
	Message01Icon,
	Shield01Icon,
	Target01Icon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import { getGoal } from "@ryuhq/core-client/goals.ts";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ActivityItem } from "@/src/lib/api/activity.ts";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type BotFeedSource,
	feedSourceForActivity,
} from "@/src/lib/bot-feed.ts";
import type { Conversation } from "@/types/chat.ts";

export type BotProfileTab = "overview" | "approvals" | "goals" | "feed";

const BOT_PROFILE_COLLAPSED_KEY = "ryu:bot-profile-card-collapsed:v1";
export const GOAL_QUERY_PREFIX = "bot-profile-goal";

export const FEED_SOURCE_LABELS = {
	approvals: "Approvals",
	goals: "Goals",
	notes: "Notes",
	runs: "Work",
	watch: "Watch",
} satisfies Record<BotFeedSource, string>;

export const FEED_SOURCE_ICONS = {
	approvals: Shield01Icon,
	goals: Target01Icon,
	notes: Message01Icon,
	runs: Activity01Icon,
	watch: ViewIcon,
} satisfies Record<BotFeedSource, typeof Activity01Icon>;

export const FEED_SOURCE_OPTIONS: { id: BotFeedSource; description: string }[] =
	[
		{ id: "runs", description: "Work Ryu completed or continued" },
		{ id: "approvals", description: "Actions waiting for your decision" },
		{ id: "goals", description: "Goal checks and follow-ups" },
		{ id: "watch", description: "Monitors and things Ryu is watching" },
		{ id: "notes", description: "Notes you or an app added" },
	];

export function readCollapsed(): boolean {
	try {
		return localStorage.getItem(BOT_PROFILE_COLLAPSED_KEY) === "true";
	} catch {
		return false;
	}
}

export function saveCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(BOT_PROFILE_COLLAPSED_KEY, String(collapsed));
	} catch {
		// The card remains usable when local storage is unavailable.
	}
}

export function statusLabel(status: ApprovalRequest["status"]): string {
	return status === "pending" ? "Waiting for you" : status;
}

export function sourceLabel(item: ActivityItem): string {
	return FEED_SOURCE_LABELS[feedSourceForActivity(item)];
}

export function sourceIcon(item: ActivityItem): typeof Activity01Icon {
	return FEED_SOURCE_ICONS[feedSourceForActivity(item)];
}

export function relativeAge(createdAtSeconds: number): string {
	const delta = Math.max(0, Date.now() - createdAtSeconds * 1000);
	if (delta < 60_000) {
		return "now";
	}
	if (delta < 3_600_000) {
		return `${Math.floor(delta / 60_000)}m`;
	}
	if (delta < 86_400_000) {
		return `${Math.floor(delta / 3_600_000)}h`;
	}
	return `${Math.floor(delta / 86_400_000)}d`;
}

export function useBotGoalRows(
	conversations: Conversation[],
	target: ApiTarget
) {
	const candidates = useMemo(
		() =>
			[...conversations]
				.filter((conversation) => (conversation.messageCount ?? 0) > 0)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 12),
		[conversations]
	);
	const queries = useQueries({
		queries: candidates.map((conversation) => ({
			queryKey: [
				GOAL_QUERY_PREFIX,
				target.url,
				conversation.id,
				conversation.updatedAt,
			],
			queryFn: () => getGoal(target, conversation.id),
			retry: false,
			staleTime: 30_000,
		})),
	});
	const rows = candidates.flatMap((conversation, index) => {
		const goal = queries[index]?.data;
		if (!(goal?.goal && goal.status)) {
			return [];
		}
		return [
			{
				conversation,
				goal,
			},
		];
	});
	return {
		error: queries.some((query) => query.isError),
		loading: queries.some((query) => query.isPending),
		rows,
		retry: () => Promise.all(queries.map((query) => query.refetch())),
	};
}
