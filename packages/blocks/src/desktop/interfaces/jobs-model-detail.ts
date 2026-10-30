import type { JobRow, JobStatus } from "./jobs-model-core.ts";

// ---------------------------------------------------------------------------
// Detail copy
// ---------------------------------------------------------------------------

/** One honest sentence on why the job has its status. */
export function jobStatusDetail(row: JobRow): string {
	const name = row.freelancer?.name;
	switch (row.status) {
		case "review":
			return `${name ?? "The freelancer"} delivered. Review the work and reply to request changes.`;
		case "in-progress":
			return `${name ?? "The freelancer"} is working on this now.`;
		case "on-hold":
			return row.thread.runState === "interrupted"
				? "The last run was interrupted before it finished. Reply to resume."
				: "The last run failed. Reply to retry.";
		case "open":
			return name
				? `You wrote last. ${name} has not started on it yet.`
				: "No freelancer is assigned, so nothing will run until one is hired.";
		default:
			return row.thread.messageCount > 0
				? "Closed. Nothing is waiting on you or the freelancer."
				: "Nothing has been said on this job yet.";
	}
}

export interface JobTimelineEntry {
	/** RFC 3339 time, when the snapshot knows it. */
	at: string | null;
	/** A secondary line when there is no time to show. */
	detail: string | null;
	id: string;
	label: string;
	/** "done" for history, "current" for the step the job is on. */
	state: "current" | "done";
}

/** "Atlas", "Atlas and Brook", "Atlas, Brook and Cipher". */
export function nameList(names: readonly string[]): string {
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Who was hired, in words, for the posting step. */
function hiredDetail(row: JobRow): string {
	if (row.agents.length === 0) {
		return "No freelancer hired";
	}
	return `Hired ${nameList(row.agents.map((agent) => agent.name))}`;
}

/**
 * The job's milestones from what the snapshot actually records. It carries no
 * creation time, so the posting step carries no time at all (and no wording
 * that implies one); only the current step carries the last update's time.
 */
export function jobTimeline(row: JobRow): JobTimelineEntry[] {
	const current: Record<JobStatus, string> = {
		closed: row.thread.messageCount > 0 ? "Closed" : "No activity yet",
		"in-progress": "Work in progress",
		"on-hold": "Put on hold",
		open: "Waiting for the freelancer to start",
		review: "Delivered for review",
	};
	return [
		{
			at: null,
			detail: hiredDetail(row),
			id: "posted",
			label: "Posted by you",
			state: "done",
		},
		{
			at: row.thread.updatedAt,
			detail: null,
			id: "current",
			label: current[row.status],
			state: "current",
		},
	];
}
