import {
	JOB_STATUS_LABELS,
	JOB_STATUS_ORDER,
	type JobRow,
	type JobStatus,
} from "./jobs-model-core.ts";

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
