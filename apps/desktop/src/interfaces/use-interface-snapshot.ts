import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import {
	type FolderProjectMap,
	folderProjectMapKey,
	parseFolderProjectMap,
} from "@/src/lib/folder-project-migration.ts";
import { workspaceProjectName } from "@/src/lib/workspace-projects.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	approvalActionFields,
	buildInterfaceSnapshot,
	omittedInterfaceThreads,
	overlayRunStatus,
	resolveSnapshotProjects,
	stabilizeSnapshot,
	withInterfaceAccount,
} from "./snapshot.ts";
import { useInterfaceAccount } from "./use-interface-account.ts";
import { useInterfaceDetail } from "./use-interface-detail.ts";
import { useInterfaceEvents } from "./use-interface-events.ts";
import { useInterfaceLimits } from "./use-interface-limits.ts";
import { useInterfaceLive } from "./use-interface-live.ts";

export interface InterfaceSnapshotState {
	/** True until the first conversation and agent loads settle. */
	loading: boolean;
	/** Threads left out of `snapshot` past its cap, oldest first. */
	omittedThreads: number;
	/** Ask Core for conversations and agents again (after `unavailable`). */
	retry: () => void;
	snapshot: InterfaceSnapshot;
	/**
	 * True when conversations or agents could not be loaded and nothing is
	 * cached, so an empty snapshot means "could not load", not "none yet".
	 */
	unavailable: boolean;
}

export interface InterfaceSnapshotOptions {
	/** Include the usage account (`snapshot.account`); fetched only when true. */
	account?: boolean;
	/** Include scheduled runs (`snapshot.events`); fetched only when true. */
	events?: boolean;
	/** Add the useful-state fields (asks, run times, blockers, privacy).
	 *  Off by default so a caller that only lists threads pays for nothing. */
	live?: boolean;
}

/** How often the snapshot's clock (`observedAt`, ages, estimates) moves on. */
const CLOCK_TICK_MS = 30_000;

function useClock(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
		return () => clearInterval(timer);
	}, [enabled]);
	return now;
}

/** This node's folder-project → node-project map, or empty without storage. */
function readFolderProjectMap(nodeUrl: string): FolderProjectMap {
	try {
		return parseFolderProjectMap(
			localStorage.getItem(folderProjectMapKey(nodeUrl))
		);
	} catch {
		return {};
	}
}

/** The live {@link InterfaceSnapshot} over the desktop's shared chat state. */
export function useInterfaceSnapshot(
	options: InterfaceSnapshotOptions = {}
): InterfaceSnapshotState {
	const liveEnabled = options.live === true;
	const { events, jobs } = useInterfaceEvents(options.events === true);
	const {
		conversations,
		conversationsLoadFailed = false,
		conversationsLoading,
		refresh,
	} = useChatHistoryContext();
	const {
		agents,
		error: agentsError,
		loading: agentsLoading,
		reload: reloadAgents,
	} = useAgents();
	const liveInput = useInterfaceLive(liveEnabled);
	const runs = liveInput.runs;
	const statusOf = useCallback(
		(conversation: Conversation) => overlayRunStatus(conversation, runs),
		[runs]
	);
	// Working and blocked agents (by the run overlay) are polled first.
	const urgentAgentIds = useMemo(() => {
		const ids = new Set<string>();
		for (const conversation of conversations) {
			const status = statusOf(conversation);
			if (
				conversation.agentId &&
				(status === "running" ||
					status === "failed" ||
					status === "interrupted")
			) {
				ids.add(conversation.agentId);
			}
		}
		return ids;
	}, [conversations, statusOf]);
	const limits = useInterfaceLimits(liveEnabled, agents, urgentAgentIds);
	const live = useMemo(
		() => (liveEnabled ? { ...liveInput, limits } : undefined),
		[liveEnabled, liveInput, limits]
	);
	const clock = useClock(liveEnabled);
	const agentOf = useCallback(
		(conversation: Conversation) =>
			conversation.agentId ?? conversation.participants?.[0] ?? null,
		[]
	);
	// Threads with an ask or unread answer are read once per revision.
	const priorityIds = useMemo(() => {
		const ids = new Set<string>(liveInput.unread.keys());
		for (const approval of liveInput.approvals ?? []) {
			const action = approvalActionFields(approval);
			const hosted = action?.host_conversation_id ?? action?.conversation_id;
			const id =
				approval.conversation_id ??
				(typeof hosted === "string" ? hosted : null);
			if (id) {
				ids.add(id);
			}
		}
		return ids;
	}, [liveInput.approvals, liveInput.unread]);
	const detailInput = useInterfaceDetail({
		agentOf,
		conversations,
		enabled: liveEnabled,
		priorityIds,
		statusOf,
	});
	const detail = liveEnabled ? detailInput : undefined;
	const { teams } = useTeams();
	const { url: nodeUrl } = useActiveNode();
	const workspaceProjects = useWorkspaceStore((state) => state.projects);
	const projectNames = useWorkspaceStore((state) => state.projectNames);

	// Threads carry node project ids; folder projects are published under the
	// node project they were migrated to. The map is re-read as conversations
	// change, which is when a migration files threads into its projects.
	const projects = useMemo(
		() =>
			resolveSnapshotProjects({
				conversations,
				folderProjectMap: readFolderProjectMap(nodeUrl),
				workspaceProjects: workspaceProjects.map((project) => ({
					id: project.id,
					name: workspaceProjectName(project, projectNames),
				})),
			}),
		[conversations, nodeUrl, workspaceProjects, projectNames]
	);

	const baseSnapshot = useMemo(
		() =>
			buildInterfaceSnapshot({
				agents,
				conversations,
				detail,
				events,
				jobs,
				live,
				// The clock only matters with live inputs; it re-renders on its tick.
				nowMs: live ? Math.max(clock, Date.now()) : undefined,
				projects,
				teams,
			}),
		[agents, clock, conversations, detail, events, jobs, live, projects, teams]
	);
	// Spend links to a thread only when the thread is in this snapshot.
	const threadIds = useMemo(
		() => new Set(baseSnapshot.threads.map((thread) => thread.id)),
		[baseSnapshot.threads]
	);
	const account = useInterfaceAccount(options.account === true, threadIds);
	// Unchanged threads keep their object, so only changed actors re-render.
	const previous = useRef<InterfaceSnapshot | null>(null);
	const snapshot = useMemo(() => {
		const next = stabilizeSnapshot(
			previous.current,
			withInterfaceAccount(baseSnapshot, account)
		);
		previous.current = next;
		return next;
	}, [account, baseSnapshot]);

	const retry = useCallback(() => {
		refresh();
		reloadAgents().catch(() => {
			// The agents hook keeps its own error for the next render.
		});
	}, [refresh, reloadAgents]);

	const loading =
		(conversationsLoading && conversations.length === 0) ||
		(agentsLoading && agents.length === 0);
	const omittedThreads = useMemo(
		() => omittedInterfaceThreads(conversations),
		[conversations]
	);
	return {
		loading,
		omittedThreads,
		retry,
		snapshot,
		unavailable:
			!loading &&
			((conversationsLoadFailed && conversations.length === 0) ||
				(agentsError !== null && agents.length === 0)),
	};
}
