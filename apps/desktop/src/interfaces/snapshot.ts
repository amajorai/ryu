// The desktop's adapter from its live chat state to the Interface Protocol's
// one read model. Every interface renders this snapshot, so this is the only
// place that knows how desktop conversations, agents, and teams are shaped.
// The pieces live in `snapshot-*.ts`; this module builds the snapshot and
// re-exports their public names.

import {
	agentActs,
	compareAsks,
	estimateProgress,
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceAgent,
	type InterfaceAsk,
	type InterfaceGroup,
	type InterfaceSnapshot,
	redactSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { Conversation } from "@/types/chat.ts";
import {
	ASK_BLIND_SPOTS_1A,
	approvalToAsk,
	inputAsk,
	replyAsk,
} from "./snapshot-approvals.ts";
import { applyLimitPrecedence, scheduleBlockers } from "./snapshot-blockers.ts";
import {
	permissionAsks,
	questionAsks,
	questionCovered,
} from "./snapshot-detail-asks.ts";
import { applyDetail, applyLive } from "./snapshot-live.ts";
import { linkOrphanRuns, routineRunFor } from "./snapshot-routines.ts";
import {
	helperRollup,
	isInterfaceThread,
	overlayRunStatus,
	projectGroups,
	runningAncestorIds,
	toThread,
} from "./snapshot-threads.ts";
import {
	type BuildInterfaceSnapshotInput,
	MAX_INTERFACE_THREADS,
} from "./snapshot-types.ts";
import { activeTranslate, toIso } from "./snapshot-util.ts";

export {
	MAX_INTERFACE_EVENTS,
	MAX_INTERFACE_TRANSACTIONS,
	toInterfaceAccount,
	toInterfaceEvents,
} from "./snapshot-account.ts";
export {
	type ApprovalThreadIndex,
	ASK_BLIND_SPOTS_1A,
	approvalActionFields,
	approvalTarget,
	approvalToAsk,
} from "./snapshot-approvals.ts";
export {
	chooseAgentLimit,
	modelsMatch,
	resolveRunStart,
} from "./snapshot-live.ts";
export { linkOrphanRuns, routineRunFor } from "./snapshot-routines.ts";
export {
	stabilizeSnapshot,
	withInterfaceAccount,
} from "./snapshot-stabilize.ts";
export {
	omittedInterfaceThreads,
	overlayRunStatus,
	resolveSnapshotProjects,
} from "./snapshot-threads.ts";
export type {
	BuildInterfaceSnapshotInput,
	InterfaceLiveInput,
	RunFrameStatus,
	SnapshotAgentInput,
	SnapshotProjectInput,
	SnapshotTeamInput,
	TerminalSeen,
} from "./snapshot-types.ts";
export { MAX_INTERFACE_THREADS } from "./snapshot-types.ts";
export type { SnapshotTranslate } from "./snapshot-util.ts";
/** The protocol's redactor; `buildInterfaceSnapshot` runs it last when privacy is "redacted". */
export { redactSnapshot };

/**
 * Project the desktop's chat state into an {@link InterfaceSnapshot}. Pure and
 * deterministic: threads are ordered newest first (id as tiebreaker) and capped
 * at {@link MAX_INTERFACE_THREADS}. With `live`, it adds the useful-state
 * fields (spec §3.2) and redacts last when privacy is "redacted".
 */
export function buildInterfaceSnapshot({
	account,
	agents,
	conversations,
	detail,
	events,
	jobs,
	live,
	nowMs,
	projects = [],
	teams,
	translate: tl = activeTranslate,
}: BuildInterfaceSnapshotInput): InterfaceSnapshot {
	const statusOf = (conversation: Conversation) =>
		overlayRunStatus(conversation, live?.runs);
	// Helpers roll up before sessions are filtered out.
	const helpers = helperRollup(conversations, statusOf);
	// Sessions anywhere down the spawn chain keep their main thread live.
	const runningAncestors = runningAncestorIds(conversations, statusOf);
	let threads = conversations
		.filter(isInterfaceThread)
		.map((conversation) => {
			const status = statusOf(conversation);
			let thread = toThread(conversation, status);
			const rollup = helpers.get(conversation.id);
			// A running helper (or a session further down its spawn chain) keeps
			// its parent live, as the sidebar shows it.
			const lifted = !thread.running && runningAncestors.has(conversation.id);
			if (rollup || lifted) {
				thread = {
					...thread,
					...(rollup ? { helpers: rollup } : {}),
					running: thread.running || lifted,
					// While a helper runs, the thread's state is "running", so its
					// status, sentence and blockers agree with the lift.
					runState: lifted ? "running" : thread.runState,
				};
			}
			return live
				? applyDetail(applyLive(thread, status, live, tl), status, live, detail)
				: thread;
		})
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
		)
		.slice(0, MAX_INTERFACE_THREADS);
	const threadIds = new Set(threads.map((thread) => thread.id));

	// Routines: link orphans, keep only snapshot threads, then derive blockers.
	const linkedEvents = events
		? linkOrphanRuns(events, conversations).map((event) =>
				event.threadId && !threadIds.has(event.threadId)
					? { ...event, threadId: null }
					: event
			)
		: undefined;
	if (live) {
		const routineFailures = scheduleBlockers(linkedEvents ?? [], tl);
		const clock = nowMs ?? Date.now();
		threads = threads.map((thread) => {
			let next = thread;
			const failure = routineFailures.get(thread.id);
			const summary =
				!next.blocker ||
				(next.blocker.kind === "error" && next.blocker.source === "run-stream");
			if (failure && summary) {
				next = { ...next, blocker: failure };
			}
			const routineRun = routineRunFor(next, jobs);
			if (routineRun) {
				next = { ...next, routineRun };
				const progress = estimateProgress(next, clock, linkedEvents);
				if (progress && !next.progress) {
					next = { ...next, progress };
				}
			}
			return next;
		});
	}

	const workingAgentIds = new Set<string>();
	for (const thread of threads) {
		if (thread.running) {
			for (const agentId of thread.agentIds) {
				workingAgentIds.add(agentId);
			}
		}
	}

	const interfaceAgents: InterfaceAgent[] = agents.map((agent) => {
		const projected: InterfaceAgent = {
			avatarUrl: agent.avatarUrl,
			description: agent.description ?? "",
			id: agent.id,
			name: agent.name,
			status: workingAgentIds.has(agent.id) ? "working" : "idle",
		};
		if (live) {
			projected.model = agent.model ?? null;
			if (live.limits?.has(agent.id)) {
				projected.limit = live.limits.get(agent.id) ?? null;
			}
		}
		return projected;
	});

	const teamGroups: InterfaceGroup[] = teams.map((team) => ({
		id: team.id,
		kind: "team",
		memberAgentIds: [...team.members],
		name: team.name,
	}));

	const snapshot: InterfaceSnapshot = {
		...(account ? { account } : {}),
		agents: interfaceAgents,
		...(linkedEvents ? { events: linkedEvents } : {}),
		groups: [...teamGroups, ...projectGroups(projects, threads)],
		threads,
		version: INTERFACE_PROTOCOL_VERSION,
	};
	if (!live) {
		return snapshot;
	}
	const clock = nowMs ?? Date.now();
	const sessionParents = new Map<string, string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (conversation.hierarchy?.role === "session" && parent) {
			sessionParents.set(conversation.id, parent);
		}
	}
	const asks: InterfaceAsk[] = [];
	for (const approval of live.approvals ?? []) {
		if (approval.status === "pending") {
			asks.push(approvalToAsk(approval, { sessionParents, threadIds }, tl));
		}
	}
	if (detail) {
		asks.push(
			...questionAsks(conversations, statusOf, detail, threadIds, clock),
			...permissionAsks(
				threads,
				new Set(
					conversations
						.filter((conversation) => statusOf(conversation) === "running")
						.map((conversation) => conversation.id)
				),
				detail,
				clock
			)
		);
	}
	for (const thread of threads) {
		const input = inputAsk(thread, live.awaitingSince?.get(thread.id));
		if (input) {
			asks.push(input);
		}
		const reply = replyAsk(thread);
		if (reply) {
			asks.push(reply);
		}
	}
	snapshot.asks = asks.sort(compareAsks);
	snapshot.askBlindSpots =
		detail && questionCovered(conversations, statusOf, detail)
			? ASK_BLIND_SPOTS_1A.filter((kind) => kind !== "question")
			: [...ASK_BLIND_SPOTS_1A];
	snapshot.observedAt = toIso(clock);
	snapshot.privacy = live.privacy;
	const limited = applyLimitPrecedence(snapshot, clock, tl);
	// Focus threads use the same priority the scenes act on.
	const acts = agentActs(limited, clock);
	limited.agents = limited.agents.map((agent) => ({
		...agent,
		focusThreadId: acts.get(agent.id)?.threadId ?? null,
	}));
	return live.privacy === "redacted" ? redactSnapshot(limited) : limited;
}
