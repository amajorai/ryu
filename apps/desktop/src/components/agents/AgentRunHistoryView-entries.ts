import {
	AlertCircleIcon,
	CheckmarkCircle02Icon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";
import { formatDate, startOfDisplayDayMs } from "@ryu/ui/lib/timezone.ts";
import { formatDistanceToNow } from "date-fns";
import { useMemo } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useRuns } from "@/src/hooks/useRuns.ts";

/** Prefix Core uses for the ephemeral conversation id of a workflow node run. */
const WORKFLOW_RUN_PREFIX = "wfrun-";
/** Prefix Core uses for a new persistent conversation created by a routine. */
const AGENT_RUN_PREFIX = "agentrun_";

/** A unified history entry, whether it originated as a chat or an automated run. */
export interface HistoryEntry {
	/** True for automated/scheduled runs; false for interactive chats. */
	automated: boolean;
	id: string;
	/** Message count when known (only automated runs carry it in the stream). */
	messageCount?: number;
	/** Latest assistant message preview, when Core returned one for the chat list. */
	preview?: string;
	/** Lifecycle status from Core, including awaiting_input and interrupted. */
	runStatus?: string;
	title: string;
	/** Unix ms of the last activity — used for ordering and the relative label. */
	updatedAt: number;
}

/** An automated run is one Core drove on its own: it either carries a run
 *  lifecycle status, or it is a workflow node's ephemeral conversation. */
function isAutomated(id: string, runStatus?: string): boolean {
	return (
		Boolean(runStatus) ||
		id.startsWith(WORKFLOW_RUN_PREFIX) ||
		id.startsWith(AGENT_RUN_PREFIX)
	);
}

export function statusMeta(status: string | undefined): {
	icon: typeof CheckmarkCircle02Icon;
	label: string;
	variant: "default" | "secondary" | "destructive" | "outline";
	spin?: boolean;
} | null {
	switch (status) {
		case "running":
			return {
				icon: Loading03Icon,
				label: "Running",
				variant: "default",
				spin: true,
			};
		case "completed":
			return {
				icon: CheckmarkCircle02Icon,
				label: "Completed",
				variant: "secondary",
			};
		case "failed":
			return { icon: AlertCircleIcon, label: "Failed", variant: "destructive" };
		case "awaiting_input":
			return {
				icon: AlertCircleIcon,
				label: "Needs input",
				variant: "outline",
			};
		case "interrupted":
			return {
				icon: AlertCircleIcon,
				label: "Interrupted",
				variant: "outline",
			};
		default:
			return null;
	}
}

export function relativeTime(ms: number): string {
	try {
		return formatDistanceToNow(new Date(ms), { addSuffix: true });
	} catch {
		return "";
	}
}

/**
 * Merge the two agent-filtered run sources into one ordered, de-duplicated list.
 * Conversations (warm, app-level) are the base; the runs stream overlays live
 * `run_status` and can surface a freshly-started background run before the
 * conversation list has refreshed.
 */
export function useAgentHistory(agentId: string | null): HistoryEntry[] {
	const { conversations } = useChatHistoryContext();
	const { runs } = useRuns();

	return useMemo(() => {
		if (!agentId) {
			return [];
		}
		const byId = new Map<string, HistoryEntry>();

		for (const conv of conversations) {
			if (conv.agentId !== agentId) {
				continue;
			}
			byId.set(conv.id, {
				id: conv.id,
				title: conv.title,
				updatedAt: conv.updatedAt,
				runStatus: conv.runStatus,
				automated: isAutomated(conv.id, conv.runStatus),
				preview:
					conv.lastMessageRole === "assistant" && conv.lastMessage
						? compactPreview(conv.lastMessage)
						: undefined,
			});
		}

		for (const run of runs) {
			if (run.agent_id !== agentId) {
				continue;
			}
			const existing = byId.get(run.id);
			byId.set(run.id, {
				id: run.id,
				title: run.title ?? existing?.title ?? "Untitled run",
				updatedAt: run.updated_at || existing?.updatedAt || 0,
				preview: existing?.preview,
				runStatus: run.run_status ?? existing?.runStatus,
				messageCount: run.message_count,
				automated: true,
			});
		}

		return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
	}, [agentId, conversations, runs]);
}

function compactPreview(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

export interface ActivityDay {
	entries: HistoryEntry[];
	key: string;
	label: string;
}

/**
 * Consecutive runs of entries sharing a civil day in the selected display
 * zone (not the machine zone), labelled relative to that zone's today.
 */
export function groupHistoryByDay(
	entries: HistoryEntry[],
	now: number = Date.now()
): ActivityDay[] {
	const today = startOfDisplayDayMs(now);
	const yesterday = startOfDisplayDayMs(now, 1);
	const groups: ActivityDay[] = [];
	for (const entry of entries) {
		const dayStart = startOfDisplayDayMs(entry.updatedAt);
		const key = String(dayStart);
		// Only today's own civil day is "Today": a run stamped on a later day (a
		// node whose clock runs ahead) keeps its real date rather than joining it.
		const label =
			dayStart === today
				? "Today"
				: dayStart === yesterday
					? "Yesterday"
					: formatDate(entry.updatedAt, { month: "short", day: "numeric" });
		const current = groups.at(-1);
		if (current?.key === key) {
			current.entries.push(entry);
		} else {
			groups.push({ entries: [entry], key, label });
		}
	}
	return groups;
}
