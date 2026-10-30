import type { LiteralMessage } from "@ryu/i18n/react";
import { useMemo } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	applySavedSearch,
	countByCompany,
	EMPTY_JOB_FILTERS,
	FREELANCER_FACETS,
	type FreelancerFacet,
	filterFreelancers,
	filterJobs,
	freelancerProfiles,
	JOB_SAVED_SEARCHES,
	type JobFilters,
	type JobSort,
	jobCompanies,
	jobFacetCounts,
	jobRows,
	matchesFreelancerFacet,
	matchesSavedSearch,
	sortJobs,
} from "./jobs-model.ts";

/** Every list, count, and facet the Jobs interface derives from the snapshot. */
export function useJobsDerived({
	filters,
	freelancerFacet,
	freelancerQuery,
	now,
	snapshot,
	sort,
}: {
	filters: JobFilters;
	freelancerFacet: FreelancerFacet;
	freelancerQuery: string;
	now: number;
	snapshot: InterfaceRendererProps<Record<string, never>>["snapshot"];
	sort: JobSort;
}) {
	const allRows = useMemo(() => jobRows(snapshot), [snapshot]);
	const rows = useMemo(
		() => sortJobs(filterJobs(allRows, filters, now), sort),
		[allRows, filters, now, sort]
	);
	const companies = useMemo(() => jobCompanies(snapshot), [snapshot]);
	const companyCounts = useMemo(() => countByCompany(allRows), [allRows]);
	const facets = useMemo(
		() => jobFacetCounts(allRows, filters, now),
		[allRows, filters, now]
	);
	const savedCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const saved of JOB_SAVED_SEARCHES) {
			const applied = applySavedSearch(EMPTY_JOB_FILTERS, saved);
			counts.set(saved.id, filterJobs(allRows, applied, now).length);
		}
		return counts;
	}, [allRows, now]);
	const allProfiles = useMemo(() => freelancerProfiles(snapshot), [snapshot]);
	const profiles = useMemo(
		() => filterFreelancers(allProfiles, freelancerQuery, freelancerFacet),
		[allProfiles, freelancerQuery, freelancerFacet]
	);
	const freelancerFacetCounts = useMemo(() => {
		const counts: Record<FreelancerFacet, number> = {
			all: 0,
			available: 0,
			working: 0,
		};
		for (const facet of FREELANCER_FACETS) {
			counts[facet.id] = allProfiles.filter((profile) =>
				matchesFreelancerFacet(profile, facet.id)
			).length;
		}
		return counts;
	}, [allProfiles]);
	const agentsByName = useMemo(
		() => [...snapshot.agents].sort((a, b) => a.name.localeCompare(b.name)),
		[snapshot.agents]
	);
	return {
		agentsByName,
		allProfiles,
		allRows,
		companies,
		companyCounts,
		facets,
		freelancerFacetCounts,
		profiles,
		rows,
		savedCounts,
	};
}

/** The job list's heading: the search, the saved search, the company, or all. */
export function jobsListHeading(
	filters: JobFilters,
	companies: ReturnType<typeof jobCompanies>,
	tl: LiteralMessage
): string {
	const savedMatch = JOB_SAVED_SEARCHES.find(
		(saved) => saved.id !== "all" && matchesSavedSearch(filters, saved)
	);
	const singleCompany =
		filters.companyIds.length === 1
			? companies.find((company) => company.id === filters.companyIds[0])
			: undefined;
	const query = filters.query.trim();
	return query
		? tl("Results for “{query}”", { query })
		: (savedMatch?.label ?? singleCompany?.name ?? "All jobs");
}
