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

// ---------------------------------------------------------------------------
// Search and filters
// ---------------------------------------------------------------------------

export type JobUpdatedWithin = "any" | "day" | "month" | "week";

/** Menu options, LinkedIn "Date posted" style. */
export const JOB_UPDATED_LABELS: Record<JobUpdatedWithin, string> = {
	any: "Any time",
	day: "Past 24 hours",
	month: "Past month",
	week: "Past week",
};

/** The phrase on an applied pill and its saved search: one wording for both. */
export function jobUpdatedPhrase(within: JobUpdatedWithin): string {
	return within === "any"
		? "Updated"
		: `Updated in the ${JOB_UPDATED_LABELS[within].toLowerCase()}`;
}

const DAY = 86_400_000;
const UPDATED_WINDOW: Record<JobUpdatedWithin, number> = {
	any: Number.POSITIVE_INFINITY,
	day: DAY,
	month: 30 * DAY,
	week: 7 * DAY,
};

export interface JobFilters {
	companyIds: string[];
	freelancerIds: string[];
	query: string;
	statuses: JobStatus[];
	updated: JobUpdatedWithin;
}

export const EMPTY_JOB_FILTERS: JobFilters = {
	companyIds: [],
	freelancerIds: [],
	query: "",
	statuses: [],
	updated: "any",
};

/** Pills in use (the search box is not a pill). */
export function activeFilterCount(filters: JobFilters): number {
	return (
		filters.companyIds.length +
		filters.freelancerIds.length +
		filters.statuses.length +
		(filters.updated === "any" ? 0 : 1)
	);
}

export function toggleValue<T>(values: readonly T[], value: T): T[] {
	return values.includes(value)
		? values.filter((item) => item !== value)
		: [...values, value];
}

function matchesQuery(row: JobRow, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	const haystack = [
		row.title,
		row.company.name,
		JOB_STATUS_LABELS[row.status],
		row.deliverable?.text ?? "",
		...row.agents.map((agent) => agent.name),
	]
		.join("\n")
		.toLowerCase();
	return haystack.includes(needle);
}

export function filterJobs(
	rows: readonly JobRow[],
	filters: JobFilters,
	now: number
): JobRow[] {
	return rows.filter((row) => {
		if (filters.statuses.length > 0 && !filters.statuses.includes(row.status)) {
			return false;
		}
		if (
			filters.companyIds.length > 0 &&
			!filters.companyIds.includes(row.company.id)
		) {
			return false;
		}
		if (
			filters.freelancerIds.length > 0 &&
			!row.thread.agentIds.some((id) => filters.freelancerIds.includes(id))
		) {
			return false;
		}
		if (!updatedWithin(row, filters.updated, now)) {
			return false;
		}
		return matchesQuery(row, filters.query);
	});
}

function updatedWithin(
	row: JobRow,
	within: JobUpdatedWithin,
	now: number
): boolean {
	const window = UPDATED_WINDOW[within];
	if (!Number.isFinite(window)) {
		return true;
	}
	const updated = Date.parse(row.thread.updatedAt);
	return !Number.isNaN(updated) && now - updated <= window;
}

/** Per-option counts for each filter menu, LinkedIn-style faceting. */
export interface JobFacetCounts {
	companies: Map<string, number>;
	freelancers: Map<string, number>;
	statuses: Record<JobStatus, number>;
	updated: Record<JobUpdatedWithin, number>;
}

function increment(counts: Map<string, number>, key: string) {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * How many jobs each option would show: every other filter (and the search
 * text) stays applied, only the facet's own selection is ignored.
 */
export function jobFacetCounts(
	rows: readonly JobRow[],
	filters: JobFilters,
	now: number
): JobFacetCounts {
	const statuses = countByStatus(
		filterJobs(rows, { ...filters, statuses: [] }, now)
	);
	const freelancers = new Map<string, number>();
	for (const row of filterJobs(rows, { ...filters, freelancerIds: [] }, now)) {
		for (const id of new Set(row.thread.agentIds)) {
			increment(freelancers, id);
		}
	}
	const companies = new Map<string, number>();
	for (const row of filterJobs(rows, { ...filters, companyIds: [] }, now)) {
		increment(companies, row.company.id);
	}
	const anyTime = filterJobs(rows, { ...filters, updated: "any" }, now);
	const updated: Record<JobUpdatedWithin, number> = {
		any: anyTime.length,
		day: 0,
		month: 0,
		week: 0,
	};
	for (const row of anyTime) {
		for (const within of ["day", "week", "month"] as const) {
			if (updatedWithin(row, within, now)) {
				updated[within] += 1;
			}
		}
	}
	return { companies, freelancers, statuses, updated };
}

export type JobSort = "recent" | "status";

export const JOB_SORT_LABELS: Record<JobSort, string> = {
	recent: "Most recent",
	status: "Status",
};

const byRecency = (a: JobRow, b: JobRow) =>
	b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
	a.thread.id.localeCompare(b.thread.id);

export function sortJobs(rows: readonly JobRow[], sort: JobSort): JobRow[] {
	if (sort === "recent") {
		return [...rows].sort(byRecency);
	}
	return [...rows].sort(
		(a, b) =>
			JOB_STATUS_ORDER.indexOf(a.status) - JOB_STATUS_ORDER.indexOf(b.status) ||
			byRecency(a, b)
	);
}

export function countByStatus(
	rows: readonly JobRow[]
): Record<JobStatus, number> {
	const counts: Record<JobStatus, number> = {
		closed: 0,
		"in-progress": 0,
		"on-hold": 0,
		open: 0,
		review: 0,
	};
	for (const row of rows) {
		counts[row.status] += 1;
	}
	return counts;
}

// ---------------------------------------------------------------------------
// Freelancers
// ---------------------------------------------------------------------------

/** Settled jobs needed before a job-success score is shown. */
export const JOB_SUCCESS_MIN_SAMPLE = 2;

export interface FreelancerProfile {
	/** Working right now. */
	active: number;
	agent: InterfaceAgent;
	/**
	 * Closed jobs only. As on Upwork, a contract is not complete until the
	 * client closes it, so this matches the Status filter's "Closed" count,
	 * except that a closed job with no messages never started and does not
	 * count.
	 */
	completed: number;
	/** Delivered work waiting on your review ("Review" in the Status filter). */
	inReview: number;
	onHold: number;
	/** Jobs that reached an outcome: in review, closed or on hold. */
	settled: number;
	/**
	 * Delivered jobs (in review or closed) out of every settled job, 0–100;
	 * null until at least JOB_SUCCESS_MIN_SAMPLE jobs have settled, so one job
	 * never reads as a 0% or 100% record.
	 */
	successRate: number | null;
	total: number;
}

export function freelancerProfile(
	snapshot: InterfaceSnapshot,
	agent: InterfaceAgent
): FreelancerProfile {
	let active = 0;
	let completed = 0;
	let inReview = 0;
	let onHold = 0;
	let total = 0;
	for (const thread of snapshot.threads) {
		if (!thread.agentIds.includes(agent.id)) {
			continue;
		}
		total += 1;
		const status = jobStatus(thread);
		if (status === "in-progress") {
			active += 1;
		} else if (status === "closed") {
			// A thread nobody has written in was never started, not closed.
			if (thread.messageCount > 0) {
				completed += 1;
			}
		} else if (status === "review") {
			inReview += 1;
		} else if (status === "on-hold") {
			onHold += 1;
		}
	}
	const delivered = completed + inReview;
	const settled = delivered + onHold;
	return {
		active,
		agent,
		completed,
		inReview,
		onHold,
		settled,
		successRate:
			settled >= JOB_SUCCESS_MIN_SAMPLE
				? Math.round((delivered / settled) * 100)
				: null,
		total,
	};
}

/** Working freelancers first, then the most delivered work, then by name. */
export function freelancerProfiles(
	snapshot: InterfaceSnapshot
): FreelancerProfile[] {
	return snapshot.agents
		.map((agent) => freelancerProfile(snapshot, agent))
		.sort(
			(a, b) =>
				Number(b.agent.status === "working") -
					Number(a.agent.status === "working") ||
				b.completed + b.inReview - (a.completed + a.inReview) ||
				a.agent.name.localeCompare(b.agent.name)
		);
}

/** The Freelancers tab's rail facets. */
export type FreelancerFacet = "all" | "available" | "working";

export const FREELANCER_FACETS: readonly {
	id: FreelancerFacet;
	label: string;
}[] = [
	{ id: "all", label: "All freelancers" },
	{ id: "working", label: "Working now" },
	{ id: "available", label: "Available" },
];

export function matchesFreelancerFacet(
	profile: FreelancerProfile,
	facet: FreelancerFacet
): boolean {
	if (facet === "all") {
		return true;
	}
	const working = profile.agent.status === "working";
	return facet === "working" ? working : !working;
}

export function filterFreelancers(
	profiles: readonly FreelancerProfile[],
	query: string,
	facet: FreelancerFacet = "all"
): FreelancerProfile[] {
	const needle = query.trim().toLowerCase();
	return profiles.filter(
		(profile) =>
			matchesFreelancerFacet(profile, facet) &&
			`${profile.agent.name}\n${profile.agent.description}`
				.toLowerCase()
				.includes(needle)
	);
}

/**
 * One meta line per freelancer, the same shape on every row: "N jobs ·
 * N completed", with the job-success score appended only once the sample is
 * large enough to mean something.
 */
export function freelancerMeta(profile: FreelancerProfile): string {
	if (profile.total === 0) {
		return "No jobs yet";
	}
	const parts = [
		pluralize(profile.total, "job"),
		`${profile.completed} completed`,
	];
	if (profile.successRate !== null) {
		parts.push(`${profile.successRate}% job success`);
	}
	return parts.join(" · ");
}

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

// ---------------------------------------------------------------------------
// Time and identity helpers
// ---------------------------------------------------------------------------

const AGE_STEPS: [number, string][] = [
	[60, "minute"],
	[24, "hour"],
	[7, "day"],
	[4.345, "week"],
	[12, "month"],
	[Number.POSITIVE_INFINITY, "year"],
];

/** LinkedIn-style age: "Just now", "1 minute ago", "3 days ago". */
export function jobAge(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	let value = Math.max(0, (now - then) / 60_000);
	if (value < 1) {
		return "Just now";
	}
	for (const [size, unit] of AGE_STEPS) {
		if (value < size) {
			const whole = Math.floor(value);
			return `${whole} ${unit}${whole === 1 ? "" : "s"} ago`;
		}
		value /= size;
	}
	return "";
}

const FULL_TIME = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeStyle: "short",
});

export function jobFullTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : FULL_TIME.format(time);
}

export function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Number of logo tints (see `jobs-parts.tsx`). */
export const COMPANY_TONE_COUNT = 5;

/** Stable tint index for a company id, so a logo keeps its color. */
export function companyTone(id: string): number {
	let hash = 0;
	for (const char of id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
	}
	return hash % COMPANY_TONE_COUNT;
}

/** One letter for a company's logo tile. */
export function companyInitial(name: string): string {
	return name.trim().charAt(0).toUpperCase() || "?";
}

/** What "Post a job" sends for a freelancer and company pick. */
export function jobStartInput(input: {
	agentId: string | undefined;
	companyId: string;
	prompt: string;
	snapshot: InterfaceSnapshot;
}): { agentId?: string; projectId?: string; prompt: string; teamId?: string } {
	const group = input.snapshot.groups.find(
		(candidate) => candidate.id === input.companyId
	);
	return {
		prompt: input.prompt,
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(group?.kind === "project" ? { projectId: group.id } : {}),
		...(group?.kind === "team" ? { teamId: group.id } : {}),
	};
}

export type CursorStep = "first" | "last" | "next" | "previous";

export function cursorStep(key: string): CursorStep | null {
	switch (key) {
		case "ArrowDown":
		case "j":
			return "next";
		case "ArrowUp":
		case "k":
			return "previous";
		case "Home":
			return "first";
		case "End":
			return "last";
		default:
			return null;
	}
}

export function stepIndex(
	step: CursorStep,
	index: number,
	length: number
): number {
	switch (step) {
		case "first":
			return 0;
		case "last":
			return length - 1;
		case "next":
			return Math.min(index + 1, length - 1);
		default:
			return Math.max(index - 1, 0);
	}
}

// ---------------------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------------------

export interface JobSavedSearch {
	filters: Omit<JobFilters, "query">;
	id: string;
	label: string;
}

const NO_PILLS: Omit<JobFilters, "query"> = {
	companyIds: [],
	freelancerIds: [],
	statuses: [],
	updated: "any",
};

/** The rail's saved searches: the questions a hiring manager asks daily. */
export const JOB_SAVED_SEARCHES: readonly JobSavedSearch[] = [
	{ filters: NO_PILLS, id: "all", label: "All jobs" },
	{
		filters: { ...NO_PILLS, statuses: ["review"] },
		id: "review",
		label: "Ready for review",
	},
	{
		filters: { ...NO_PILLS, statuses: ["in-progress"] },
		id: "in-progress",
		label: "In progress",
	},
	{
		filters: { ...NO_PILLS, statuses: ["open"] },
		id: "open",
		label: "Waiting to start",
	},
	{
		filters: { ...NO_PILLS, statuses: ["on-hold"] },
		id: "on-hold",
		label: "On hold",
	},
	{
		filters: { ...NO_PILLS, updated: "week" },
		id: "week",
		label: jobUpdatedPhrase("week"),
	},
];

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value) => b.includes(value));
}

/** True when the pills (not the search text) match a saved search exactly. */
export function matchesSavedSearch(
	filters: JobFilters,
	saved: JobSavedSearch
): boolean {
	return (
		sameSet(filters.statuses, saved.filters.statuses) &&
		sameSet(filters.companyIds, saved.filters.companyIds) &&
		sameSet(filters.freelancerIds, saved.filters.freelancerIds) &&
		filters.updated === saved.filters.updated
	);
}

/** Apply a saved search, keeping whatever is typed in the search box. */
export function applySavedSearch(
	filters: JobFilters,
	saved: JobSavedSearch
): JobFilters {
	return { ...saved.filters, query: filters.query };
}

/** Other jobs with the same freelancer, newest first, for the detail pane. */
export function relatedJobs(
	rows: readonly JobRow[],
	row: JobRow,
	limit = 3
): JobRow[] {
	const agentId = row.freelancer?.id;
	if (!agentId) {
		return [];
	}
	return freelancerJobs(rows, agentId)
		.filter((candidate) => candidate.thread.id !== row.thread.id)
		.slice(0, limit);
}

/** Jobs a freelancer is on, newest first. */
export function freelancerJobs(
	rows: readonly JobRow[],
	agentId: string
): JobRow[] {
	return sortJobs(
		rows.filter((row) => row.thread.agentIds.includes(agentId)),
		"recent"
	);
}

/** How many jobs sit under each company id. */
export function countByCompany(rows: readonly JobRow[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		counts.set(row.company.id, (counts.get(row.company.id) ?? 0) + 1);
	}
	return counts;
}

/** "Status", "Review", or "Status · 2" for a filter pill's face. */
export function pillLabel(field: string, selected: readonly string[]): string {
	if (selected.length === 0) {
		return field;
	}
	if (selected.length === 1) {
		return selected[0] ?? field;
	}
	return `${field} · ${selected.length}`;
}
