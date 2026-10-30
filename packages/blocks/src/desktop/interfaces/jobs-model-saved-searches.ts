import type { JobRow } from "./jobs-model-core.ts";
import {
	type JobFilters,
	jobUpdatedPhrase,
	sortJobs,
} from "./jobs-model-filters.ts";

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
