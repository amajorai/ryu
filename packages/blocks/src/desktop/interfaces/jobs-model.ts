/**
 * Jobs view-model entry point. The model is split by responsibility into
 * sibling `jobs-model-*.ts` files; this module re-exports all of it so
 * importers keep one stable path.
 */

export {
	JOB_STATUS_LABELS,
	JOB_STATUS_ORDER,
	type JobCompany,
	type JobDeliverable,
	type JobRow,
	type JobStatus,
	jobCompanies,
	jobCompany,
	jobRow,
	jobRows,
	jobStatus,
	jobTitle,
	PERSONAL_COMPANY_ID,
} from "./jobs-model-core.ts";
export {
	type JobTimelineEntry,
	jobStatusDetail,
	jobTimeline,
	nameList,
} from "./jobs-model-detail.ts";
export {
	activeFilterCount,
	countByStatus,
	EMPTY_JOB_FILTERS,
	filterJobs,
	JOB_SORT_LABELS,
	JOB_UPDATED_LABELS,
	type JobFacetCounts,
	type JobFilters,
	type JobSort,
	type JobUpdatedWithin,
	jobFacetCounts,
	jobUpdatedPhrase,
	sortJobs,
	toggleValue,
} from "./jobs-model-filters.ts";
export {
	FREELANCER_FACETS,
	type FreelancerFacet,
	type FreelancerProfile,
	filterFreelancers,
	freelancerMeta,
	freelancerProfile,
	freelancerProfiles,
	JOB_SUCCESS_MIN_SAMPLE,
	matchesFreelancerFacet,
} from "./jobs-model-freelancers.ts";
export {
	applySavedSearch,
	countByCompany,
	freelancerJobs,
	JOB_SAVED_SEARCHES,
	type JobSavedSearch,
	matchesSavedSearch,
	pillLabel,
	relatedJobs,
} from "./jobs-model-saved-searches.ts";
export {
	COMPANY_TONE_COUNT,
	type CursorStep,
	companyInitial,
	companyTone,
	cursorStep,
	jobAge,
	jobFullTime,
	jobStartInput,
	pluralize,
	stepIndex,
} from "./jobs-model-time.ts";
