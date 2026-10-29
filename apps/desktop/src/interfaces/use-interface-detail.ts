// The phase-1b hydration loop (spec §3.2 "Detail store hydration"): while an
// interface is on screen and the window is visible, read the newest message
// page of the threads whose detail matters, derive their detail, and keep it in
// useInterfaceDetailStore. The read plan is a pure function so its caps,
// ordering and sweep budget are unit-tested.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	deriveThreadDetail,
	interfaceDetailRevision,
} from "@/src/lib/interface-detail.ts";
import {
	ensureInterfaceDetail,
	type InterfaceDetailEntry,
	isInterfaceDetailCurrent,
	type LiveTabEntry,
	resetInterfaceNode,
	useInterfaceDetailStore,
} from "@/src/store/useInterfaceDetailStore.ts";
import { sidebarTodoProgressKey } from "@/src/store/useSidebarTodoProgressStore.ts";
import type { Conversation } from "@/types/chat.ts";

/** Running mains and running helper sessions share this cap. */
export const RUNNING_READ_CAP = 8;
/** Threads with an ask, a blocker or unread messages, read once per revision. */
export const OTHER_READ_CAP = 16;
/** Idle-thread sweep budget per window. */
export const SWEEP_READ_CAP = 16;
export const SWEEP_WINDOW_MS = 5 * 60_000;
/** The sweep covers main threads updated within this window. */
export const SWEEP_AGE_MS = 7 * 24 * 60 * 60_000;
export const HYDRATE_INTERVAL_MS = 5000;
const STAGGER_MS = 150;

export interface DetailCandidate {
	conversation: Conversation;
	/** The parent main thread, for a helper session. */
	parentId: string | null;
	/** Has an ask, a blocker or unread messages. */
	priority: boolean;
	revision: string;
	/** Its own run is live (sessions), or it or a helper runs (mains). */
	running: boolean;
	session: boolean;
}

export interface HydrationPlan {
	other: DetailCandidate[];
	running: DetailCandidate[];
	/** Every running main and session is in `running` (none over the cap). */
	runningWithinCap: boolean;
	sweep: DetailCandidate[];
	/** Every main updated within 7 days is read at its current revision. */
	sweepComplete: boolean;
}

function newestFirst(a: DetailCandidate, b: DetailCandidate): number {
	return (
		b.conversation.updatedAt - a.conversation.updatedAt ||
		a.conversation.id.localeCompare(b.conversation.id)
	);
}

/**
 * Which conversations to read now. `current(candidate)` says whether the
 * store already holds a ready read at the candidate's revision; `sweepReads`
 * are the times of sweep reads already spent in the current window.
 */
export function planHydration(input: {
	candidates: readonly DetailCandidate[];
	current: (candidate: DetailCandidate) => boolean;
	nowMs: number;
	sweepReads: readonly number[];
}): HydrationPlan {
	const { candidates, current, nowMs } = input;
	const runningMains = candidates
		.filter((c) => c.running && !c.session)
		.sort(newestFirst);
	const runningSessions = candidates
		.filter((c) => c.running && c.session)
		.sort(newestFirst);
	const runningAll = [...runningMains, ...runningSessions];
	const running = runningAll.slice(0, RUNNING_READ_CAP);
	const taken = new Set(running.map((c) => c.conversation.id));
	const other = candidates
		.filter(
			(c) =>
				!(c.session || taken.has(c.conversation.id)) &&
				c.priority &&
				!current(c)
		)
		.sort(newestFirst)
		.slice(0, OTHER_READ_CAP);
	for (const c of other) {
		taken.add(c.conversation.id);
	}
	const recentMains = candidates.filter(
		(c) => !c.session && nowMs - c.conversation.updatedAt <= SWEEP_AGE_MS
	);
	const spent = input.sweepReads.filter(
		(at) => nowMs - at < SWEEP_WINDOW_MS
	).length;
	const budget = Math.max(0, SWEEP_READ_CAP - spent);
	const sweep = recentMains
		.filter((c) => !(taken.has(c.conversation.id) || current(c)))
		.sort(newestFirst)
		.slice(0, budget);
	return {
		other,
		running,
		runningWithinCap: runningAll.length <= RUNNING_READ_CAP,
		sweep,
		sweepComplete: recentMains.every((c) => current(c)),
	};
}

/** Build the candidates from the conversation list and the run overlay. */
export function detailCandidates(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined,
	priorityIds: ReadonlySet<string>
): DetailCandidate[] {
	const runningParents = new Set<string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (
			conversation.hierarchy?.role === "session" &&
			parent &&
			statusOf(conversation) === "running"
		) {
			runningParents.add(parent);
		}
	}
	return conversations
		.filter((conversation) => !conversation.archived)
		.map((conversation) => {
			const status = statusOf(conversation);
			const session = conversation.hierarchy?.role === "session";
			return {
				conversation,
				parentId: session
					? (conversation.hierarchy?.spawnedByConversationId ?? null)
					: null,
				priority:
					priorityIds.has(conversation.id) ||
					status === "failed" ||
					status === "interrupted",
				revision: interfaceDetailRevision({
					messageCount:
						conversation.messageCount ?? conversation.messages.length,
					runStatus: status,
					updatedAt: conversation.updatedAt,
				}),
				running:
					status === "running" ||
					(!session && runningParents.has(conversation.id)),
				session,
			};
		});
}

/** What the snapshot builder needs from the store. */
export interface InterfaceDetailInput {
	/** Detail entries by conversation id (mains and helper sessions). */
	entries: ReadonlyMap<string, InterfaceDetailEntry>;
	/** Live-tab entries by thread id. */
	live: ReadonlyMap<string, LiveTabEntry>;
	/** Every running main and session fits the read cap. */
	runningWithinCap: boolean;
	sweepComplete: boolean;
}

function useWindowVisible(): boolean {
	return useSyncExternalStore(
		(listener) => {
			document.addEventListener("visibilitychange", listener);
			return () => document.removeEventListener("visibilitychange", listener);
		},
		() => document.visibilityState !== "hidden",
		() => true
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The node the interface detail was last read for, across remounts. */
let detailNodeUrl: string | null = null;

/**
 * Note the node the interfaces read from. A different node than last time
 * resets the detail reads, and the previous node's live entries and answered
 * permissions (`resetInterfaceNode`). Returns whether it reset.
 */
export function noteInterfaceNode(nodeUrl: string): boolean {
	const previous = detailNodeUrl;
	detailNodeUrl = nodeUrl;
	if (previous === null || previous === nodeUrl) {
		return false;
	}
	resetInterfaceNode(previous);
	return true;
}

/**
 * Run the hydration loop while `enabled` and the window is visible, and return
 * the store's entries for the snapshot. Running threads are re-read every
 * tick, bypassing the hover-prefetch cache; everything else once per revision.
 */
export function useInterfaceDetail(input: {
	agentOf: (conversation: Conversation) => string | null;
	conversations: readonly Conversation[];
	enabled: boolean;
	priorityIds: ReadonlySet<string>;
	statusOf: (conversation: Conversation) => string | undefined;
}): InterfaceDetailInput {
	const { enabled } = input;
	const visible = useWindowVisible();
	const node = useActiveNode();
	const { loadMessagesPageResult } = useChatHistoryContext();
	const latest = useRef(input);
	latest.current = input;
	const loadRef = useRef(loadMessagesPageResult);
	loadRef.current = loadMessagesPageResult;
	const sweepReads = useRef<number[]>([]);
	const nodeUrl = node.url;

	// A node switch starts the detail over: nothing read or published for the
	// previous node may answer an ask shown for this one.
	useEffect(() => {
		noteInterfaceNode(nodeUrl);
	}, [nodeUrl]);

	useEffect(() => {
		if (!(enabled && visible)) {
			return;
		}
		let cancelled = false;
		const keyOf = (id: string) =>
			sidebarTodoProgressKey({ conversationId: id, nodeUrl });
		const tick = async () => {
			const { agentOf, conversations, priorityIds, statusOf } = latest.current;
			const candidates = detailCandidates(conversations, statusOf, priorityIds);
			const entries = useInterfaceDetailStore.getState().entries;
			const nowMs = Date.now();
			// A failed read waits out its backoff before it is planned again.
			const plan = planHydration({
				candidates,
				current: (c) =>
					isInterfaceDetailCurrent(
						entries[keyOf(c.conversation.id)],
						c.revision,
						nowMs
					),
				nowMs,
				sweepReads: sweepReads.current,
			});
			sweepReads.current = sweepReads.current.filter(
				(at) => nowMs - at < SWEEP_WINDOW_MS
			);
			const reads = [
				...plan.running.map((c) => ({ c, force: true, sweep: false })),
				...plan.other.map((c) => ({ c, force: false, sweep: false })),
				...plan.sweep.map((c) => ({ c, force: false, sweep: true })),
			];
			for (const { c, force, sweep } of reads) {
				if (cancelled) {
					return;
				}
				const id = c.conversation.id;
				const parent = c.parentId
					? conversations.find((item) => item.id === c.parentId)
					: undefined;
				const read = ensureInterfaceDetail({
					derive: (messages, hasOlder) =>
						deriveThreadDetail(messages, {
							agentId: agentOf(c.conversation),
							hasOlder,
							liftTo: c.parentId
								? {
										agentId:
											agentOf(c.conversation) ??
											(parent ? agentOf(parent) : null),
										threadId: c.parentId,
									}
								: undefined,
							nowMs: Date.now(),
							// Its own run: a main kept live only by a helper has no
							// live step of its own.
							running: statusOf(c.conversation) === "running",
							threadId: id,
						}),
					force,
					key: keyOf(id),
					load: async () => {
						const result = await loadRef.current(id, undefined, {
							fresh: c.running,
						});
						return {
							hasOlder: result.hasOlderMessages === true,
							messages: result.messages,
							status: result.status,
						};
					},
					revision: c.revision,
				});
				// The sweep budget is spent only by reads that actually start.
				if (sweep && read.started) {
					sweepReads.current.push(Date.now());
				}
				await sleep(STAGGER_MS);
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), HYDRATE_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [enabled, visible, nodeUrl]);

	const storeEntries = useInterfaceDetailStore((state) => state.entries);
	const storeLive = useInterfaceDetailStore((state) => state.live);
	const { conversations, priorityIds, statusOf } = input;
	return useMemo(() => {
		const entries = new Map<string, InterfaceDetailEntry>();
		for (const conversation of conversations) {
			const entry =
				storeEntries[
					sidebarTodoProgressKey({ conversationId: conversation.id, nodeUrl })
				];
			if (entry) {
				entries.set(conversation.id, entry);
			}
		}
		const live = new Map<string, LiveTabEntry>();
		for (const entry of Object.values(storeLive)) {
			// Only tabs talking to this node speak for its threads.
			if (entry?.nodeUrl === nodeUrl) {
				const { nodeUrl: _node, ...tab } = entry;
				live.set(entry.threadId, tab);
			}
		}
		// Coverage is judged on the current list, not the last tick's plan.
		const plan = planHydration({
			candidates: detailCandidates(conversations, statusOf, priorityIds),
			current: (c) => {
				const entry = entries.get(c.conversation.id);
				return entry?.status === "ready" && entry.revision === c.revision;
			},
			nowMs: Date.now(),
			sweepReads: [],
		});
		return {
			entries,
			live,
			runningWithinCap: plan.runningWithinCap,
			sweepComplete: plan.sweepComplete,
		};
	}, [conversations, nodeUrl, priorityIds, statusOf, storeEntries, storeLive]);
}
