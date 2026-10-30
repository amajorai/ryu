import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Jobs view-model. Conversations are job postings the user made, agents are
 * the freelancers hired for them, and teams/projects are the companies a job
 * is filed under. Everything here is pure so the hiring vocabulary can be
 * tested without rendering.
 */

/** A thread's status in hiring vocabulary. */
export type JobStatus =
	| "closed"
	| "in-progress"
	| "on-hold"
	| "open"
	| "review";

const FROM_THREAD_STATUS: Record<ThreadStatus, JobStatus> = {
	attention: "on-hold",
	quiet: "closed",
	waiting: "open",
	working: "in-progress",
	"your-turn": "review",
};

export function jobStatus(thread: InterfaceThread): JobStatus {
	return FROM_THREAD_STATUS[threadStatus(thread)];
}

/** Review first (it is the user's move), then live work, then the rest. */
export const JOB_STATUS_ORDER: readonly JobStatus[] = [
	"review",
	"in-progress",
	"open",
	"on-hold",
	"closed",
];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
	closed: "Closed",
	"in-progress": "In progress",
	"on-hold": "On hold",
	open: "Open",
	review: "Review",
};

export const PERSONAL_COMPANY_ID = "personal";

export interface JobCompany {
	id: string;
	kind: "personal" | InterfaceGroup["kind"];
	name: string;
}

const PERSONAL: JobCompany = {
	id: PERSONAL_COMPANY_ID,
	kind: "personal",
	name: "Personal",
};

/** The newest message, attributed, for the "Deliverable" excerpt. */
export interface JobDeliverable {
	/** "agent" when the freelancer wrote it, "you" when the user did. */
	from: "agent" | "you";
	text: string;
}

export interface JobRow {
	agents: InterfaceAgent[];
	company: JobCompany;
	deliverable: JobDeliverable | null;
	/** The first assigned agent; undefined when nobody is hired yet. */
	freelancer: InterfaceAgent | undefined;
	status: JobStatus;
	thread: InterfaceThread;
	title: string;
}

export function jobTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled job";
}

export function jobCompany(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): JobCompany {
	const groupId = thread.projectId ?? thread.teamId;
	const group = groupId
		? snapshot.groups.find((candidate) => candidate.id === groupId)
		: undefined;
	return group
		? { id: group.id, kind: group.kind, name: group.name }
		: PERSONAL;
}

/** Personal first, then projects and teams by name. */
export function jobCompanies(snapshot: InterfaceSnapshot): JobCompany[] {
	const groups = [...snapshot.groups]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((group) => ({ id: group.id, kind: group.kind, name: group.name }));
	return [PERSONAL, ...groups];
}

export function jobRow(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): JobRow {
	const agents: InterfaceAgent[] = [];
	for (const id of thread.agentIds) {
		const agent = snapshot.agents.find((candidate) => candidate.id === id);
		if (agent) {
			agents.push(agent);
		}
	}
	const text = thread.lastMessage?.trim();
	return {
		agents,
		company: jobCompany(snapshot, thread),
		deliverable:
			text && thread.lastMessageRole
				? { from: thread.lastMessageRole === "user" ? "you" : "agent", text }
				: null,
		freelancer: agents[0],
		status: jobStatus(thread),
		thread,
		title: jobTitle(thread),
	};
}

export function jobRows(snapshot: InterfaceSnapshot): JobRow[] {
	return snapshot.threads.map((thread) => jobRow(snapshot, thread));
}
