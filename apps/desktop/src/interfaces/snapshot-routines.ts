// Cron routines: which firing started a run, and the thread of a failed
// per-firing run.

import type {
	InterfaceEvent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { conversationParticipantIds } from "@/src/lib/agent-conversation-groups.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import { cronFireTimes } from "@/src/lib/calendar/events.ts";
import type { Conversation } from "@/types/chat.ts";
import { toIso } from "./snapshot-util.ts";

/** Core fires cron jobs within the matching minute on a 30 s tick. */
const ROUTINE_START_GATE_MS = 90_000;

/**
 * The cron routine whose firing started this run, or null. Set only when the
 * thread runs, is the `target.conversationId` of exactly one enabled agent job,
 * that job is cron (never interval), needs no approval, and fired at F with
 * `0 ≤ S − F ≤ 90 s` where S is the thread's runStartedAt.
 */
export function routineRunFor(
	thread: Pick<InterfaceThread, "id" | "running" | "runStartedAt">,
	jobs: readonly ScheduledJob[] | undefined
): { firedAt: string; jobId: string } | null {
	const start = thread.runStartedAt
		? Date.parse(thread.runStartedAt)
		: Number.NaN;
	if (!(thread.running && Number.isFinite(start) && jobs)) {
		return null;
	}
	const owners = jobs.filter(
		(job) =>
			job.enabled &&
			job.target.type === "agent" &&
			job.target.conversationId === thread.id
	);
	const job = owners.length === 1 ? owners[0] : undefined;
	if (job?.schedule.kind !== "cron" || job.requireApproval) {
		return null;
	}
	const fires = cronFireTimes(
		job,
		new Date(start - ROUTINE_START_GATE_MS),
		new Date(start)
	).filter((fire) => fire.getTime() <= start);
	const fired = fires.at(-1);
	return fired ? { firedAt: toIso(fired.getTime()), jobId: job.id } : null;
}

/**
 * Fill the thread of a failed per-firing run: Core records no run id for it,
 * but its `agentrun_*` conversation exists. Linked only when exactly one
 * conversation matches the agent, the routine name and a creation time inside
 * the run.
 */
export function linkOrphanRuns(
	events: readonly InterfaceEvent[],
	conversations: readonly Conversation[]
): InterfaceEvent[] {
	return events.map((event) => {
		const start = Date.parse(event.start);
		const end = event.end ? Date.parse(event.end) : Number.NaN;
		if (
			event.kind !== "past" ||
			event.outcome !== "failure" ||
			event.threadId ||
			!event.agentId ||
			!(Number.isFinite(start) && Number.isFinite(end))
		) {
			return event;
		}
		const matches = conversations.filter(
			(conversation) =>
				conversation.id.startsWith("agentrun_") &&
				conversationParticipantIds(conversation).includes(
					event.agentId ?? ""
				) &&
				conversation.title.trim() === event.title &&
				conversation.createdAt >= start &&
				conversation.createdAt <= end
		);
		return matches.length === 1 && matches[0]
			? { ...event, threadId: matches[0].id }
			: event;
	});
}
