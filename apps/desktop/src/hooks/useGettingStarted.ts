import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import {
	GETTING_STARTED_QUESTS,
	type GettingStartedQuest,
	getCompletedSnapshot,
	markQuestComplete,
	type QuestStatus,
	subscribeGettingStarted,
} from "@/src/lib/getting-started.ts";

export type ResolvedQuest = GettingStartedQuest & { status: QuestStatus };

export interface GettingStarted {
	allDone: boolean;
	completedCount: number;
	/** The first incomplete quest (rendered as in_progress), or null when done. */
	nextQuest: ResolvedQuest | null;
	quests: ResolvedQuest[];
	/** Follow a quest: open its page and stamp it complete. */
	run: (id: string) => void;
	total: number;
}

/**
 * Single source of truth for the onboarding checklist. Safe to call from any
 * component under the app providers (home + sidebar both qualify) and returns a
 * consistent view: completed quests, the next step, and a runner that navigates.
 */
export function useGettingStarted(): GettingStarted {
	const completedIds = useSyncExternalStore(
		subscribeGettingStarted,
		getCompletedSnapshot
	);
	const { conversations } = useChatHistoryContext();
	const { openTab } = useTabsContext();

	// Real signal: once any conversation exists, "send your first message" is done
	// for good (stamped so deleting every chat never reopens it).
	const hasChats = conversations.length > 0;
	useEffect(() => {
		if (hasChats) {
			markQuestComplete("chat");
		}
	}, [hasChats]);

	const quests = useMemo<ResolvedQuest[]>(() => {
		const done = new Set(completedIds);
		if (hasChats) {
			done.add("chat");
		}
		let markedNext = false;
		return GETTING_STARTED_QUESTS.map((quest) => {
			if (done.has(quest.id)) {
				return { ...quest, status: "completed" as const };
			}
			if (!markedNext) {
				markedNext = true;
				return { ...quest, status: "in_progress" as const };
			}
			return { ...quest, status: "pending" as const };
		});
	}, [completedIds, hasChats]);

	const completedCount = quests.filter(
		(quest) => quest.status === "completed"
	).length;
	const total = quests.length;
	const allDone = completedCount === total;
	const nextQuest =
		quests.find((quest) => quest.status === "in_progress") ?? null;

	const run = useCallback(
		(id: string) => {
			const quest = GETTING_STARTED_QUESTS.find((item) => item.id === id);
			if (!quest) {
				return;
			}
			openTab(quest.path, { forceNew: quest.forceNew });
			markQuestComplete(id);
		},
		[openTab]
	);

	return { quests, completedCount, total, allDone, nextQuest, run };
}
