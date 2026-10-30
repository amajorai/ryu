import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { JobDetail, JobFullView } from "./jobs-detail.tsx";
import { FreelancerList, FreelancerProfilePane } from "./jobs-freelancers.tsx";
import { jobsListHeading, useJobsDerived } from "./jobs-interface-derived.ts";
import {
	COMPACT_MAX_WIDTH,
	DetailSkeleton,
	FULL_SIDEBAR_MIN_WIDTH,
	RAIL_MIN_WIDTH,
	STACKED_MAX_WIDTH,
	useElementWidth,
	useJobsThreadSync,
	useMinuteClock,
	useRowRegistry,
	useSlashFocusSearch,
} from "./jobs-interface-hooks.tsx";
import {
	onKeyDownFreelancerHandler,
	onKeyDownJobHandler,
	onKeyDownRootHandler,
} from "./jobs-interface-keys.ts";
import {
	FreelancerDetailPlaceholder,
	JobsDetailBlank,
	JobsDetailPlaceholder,
	JobsSplitPanes,
	JobsStackedDetail,
} from "./jobs-interface-panes.tsx";
import { JobsList } from "./jobs-list.tsx";
import {
	applySavedSearch,
	EMPTY_JOB_FILTERS,
	FREELANCER_FACETS,
	type FreelancerFacet,
	freelancerJobs,
	type JobFilters,
	type JobSavedSearch,
	type JobSort,
	jobStartInput,
	PERSONAL_COMPANY_ID,
	relatedJobs,
} from "./jobs-model.ts";
import { type JobPostInput, PostJobDialog } from "./jobs-post.tsx";
import {
	JOBS_PANEL_ID,
	JobsInlineTabs,
	JobsRail,
	type JobsTab,
	jobsTabId,
	SavedSearchMenu,
} from "./jobs-rail.tsx";
import { JobsToolbar } from "./jobs-toolbar.tsx";

/**
 * Jobs: a hiring board over the same threads and agents. Conversations are
 * the jobs you posted, agents are the freelancers you hire, and teams or
 * projects are the companies a job is filed under. LinkedIn Jobs' three panes
 * (filters and saved searches, the job list, the job detail with the host's
 * real message thread) plus an Upwork-style Freelancers tab with profiles and
 * a Hire composer. "Open full view" gives the thread the whole surface.
 */
export function JobsInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const composerRef = useRef<HTMLDivElement>(null);
	/** The freelancer whose Hire composer is unfolded, if any. */
	const [hireAgentId, setHireAgentId] = useState<string | null>(null);
	const width = useElementWidth(rootRef);
	const now = useMinuteClock();
	const jobRegistry = useRowRegistry();
	const freelancerRegistry = useRowRegistry();

	const [tab, setTab] = useState<JobsTab>("jobs");
	const [filters, setFilters] = useState<JobFilters>(EMPTY_JOB_FILTERS);
	const [freelancerQuery, setFreelancerQuery] = useState("");
	const [freelancerFacet, setFreelancerFacet] =
		useState<FreelancerFacet>("all");
	const [sort, setSort] = useState<JobSort>("recent");
	const [cursorId, setCursorId] = useState<string | null>(null);
	const [freelancerCursorId, setFreelancerCursorId] = useState<string | null>(
		null
	);
	const [fullView, setFullView] = useState(false);
	const [postOpen, setPostOpen] = useState(false);
	const [stackedDetail, setStackedDetail] = useState(false);

	const railMode = width >= RAIL_MIN_WIDTH;
	const compact = width < COMPACT_MAX_WIDTH;
	const stacked = width < STACKED_MAX_WIDTH;

	const {
		agentsByName,
		allRows,
		companies,
		companyCounts,
		facets,
		freelancerFacetCounts,
		profiles,
		rows,
		savedCounts,
	} = useJobsDerived({
		filters,
		freelancerFacet,
		freelancerQuery,
		now,
		snapshot,
		sort,
	});

	const conversationOpen = threadView !== null && threadView !== undefined;
	const activeRow =
		allRows.find((row) => row.thread.id === activeThreadId) ?? null;
	const order = rows.map((row) => row.thread.id);
	let cursor: string | null = order[0] ?? null;
	if (cursorId && order.includes(cursorId)) {
		cursor = cursorId;
	} else if (activeThreadId && order.includes(activeThreadId)) {
		cursor = activeThreadId;
	}
	const previewRow = rows.find((row) => row.thread.id === cursor) ?? null;
	const detailRow = conversationOpen ? activeRow : previewRow;
	const selectedJobId = conversationOpen ? activeThreadId : cursor;

	const freelancerOrder = profiles.map((profile) => profile.agent.id);
	const freelancerCursor =
		freelancerCursorId && freelancerOrder.includes(freelancerCursorId)
			? freelancerCursorId
			: (freelancerOrder[0] ?? null);
	const selectedProfile =
		profiles.find((profile) => profile.agent.id === freelancerCursor) ?? null;

	useJobsThreadSync({
		activeThreadId,
		conversationOpen,
		setCursorId,
		setFullView,
		setTab,
	});

	const openJob = (threadId: string) => {
		setCursorId(threadId);
		setTab("jobs");
		port.openThread(threadId);
	};

	const closeJob = () => {
		setFullView(false);
		port.closeThread();
		const restore = cursor;
		window.requestAnimationFrame(() => jobRegistry.focus(restore ?? undefined));
	};

	const selectTab = (next: JobsTab) => {
		if (next === tab) {
			return;
		}
		// The open job's thread lives on My jobs; leaving the tab closes it.
		if (next === "freelancers" && conversationOpen) {
			port.closeThread();
		}
		setStackedDetail(false);
		setTab(next);
	};

	const viewFreelancer = (agentId: string) => {
		setFreelancerQuery("");
		setFreelancerFacet("all");
		setFreelancerCursorId(agentId);
		selectTab("freelancers");
		setStackedDetail(true);
	};

	const hire = (agentId: string) => {
		setFreelancerCursorId(agentId);
		setHireAgentId(agentId);
		setStackedDetail(true);
		window.requestAnimationFrame(() => {
			composerRef.current?.scrollIntoView?.({ block: "nearest" });
			composerRef.current?.querySelector("textarea")?.focus();
		});
	};

	const afterStart = () => {
		setHireAgentId(null);
		setTab("jobs");
		setFilters(EMPTY_JOB_FILTERS);
		setSort("recent");
		setStackedDetail(false);
	};

	const submitHire = (input: { agentId?: string; prompt: string }) => {
		port.startThread({ agentId: input.agentId, prompt: input.prompt });
		afterStart();
	};

	const submitPost = (input: JobPostInput) => {
		port.startThread(jobStartInput({ ...input, snapshot }));
		setPostOpen(false);
		afterStart();
	};

	const selectSaved = (saved: JobSavedSearch) => {
		selectTab("jobs");
		setFilters(applySavedSearch(filters, saved));
		setCursorId(null);
	};

	const selectCompany = (companyId: string) => {
		selectTab("jobs");
		setFilters({
			...EMPTY_JOB_FILTERS,
			companyIds: [companyId],
			query: filters.query,
		});
		setCursorId(null);
	};

	const onKeyDownJob = onKeyDownJobHandler({
		closeJob,
		conversationOpen,
		jobRegistry,
		openJob,
		order,
		setCursorId,
	});

	const onKeyDownFreelancer = onKeyDownFreelancerHandler({
		freelancerOrder,
		freelancerRegistry,
		hire,
		setFreelancerCursorId,
	});

	const onKeyDownRoot = onKeyDownRootHandler({ fullView, setFullView });

	useSlashFocusSearch(rootRef, searchRef);

	const postButton = (
		<Button onClick={() => setPostOpen(true)} size="sm" type="button">
			<Plus aria-hidden="true" data-icon="inline-start" />
			Post a job
		</Button>
	);

	const heading = jobsListHeading(filters, companies, tl);

	const inlineTabs = railMode ? null : (
		<JobsInlineTabs
			onSelectTab={selectTab}
			tab={tab}
			trailing={
				tab === "jobs" ? (
					<SavedSearchMenu
						filters={filters}
						onSelectSaved={selectSaved}
						savedCounts={savedCounts}
					/>
				) : null
			}
		/>
	);

	let middle: ReactNode;
	let detail: ReactNode;
	if (tab === "jobs") {
		middle = (
			<JobsList
				cursorId={cursor}
				emptyAction={
					allRows.length > 0 ? (
						<Button
							onClick={() => setFilters(EMPTY_JOB_FILTERS)}
							size="sm"
							type="button"
							variant="outline"
						>
							Clear filters
						</Button>
					) : (
						postButton
					)
				}
				hasJobs={allRows.length > 0}
				heading={heading}
				headingExtra={inlineTabs}
				loading={loading}
				now={now}
				onFocusRow={setCursorId}
				onKeyDownRow={onKeyDownJob}
				onSelect={openJob}
				onSortChange={setSort}
				registerRow={jobRegistry.register}
				rows={rows}
				selectedId={selectedJobId}
				sort={sort}
			/>
		);
		if (conversationOpen && !detailRow) {
			detail = (
				<JobFullView
					now={now}
					onBack={closeJob}
					onClose={closeJob}
					onViewFreelancer={viewFreelancer}
					row={null}
					showSidebar={false}
					threadView={threadView}
				/>
			);
		} else if (detailRow) {
			detail = (
				<JobDetail
					now={now}
					onClose={closeJob}
					onOpen={openJob}
					onOpenFullView={() => setFullView(true)}
					onPreview={(threadId) => {
						setCursorId(threadId);
						if (!rows.some((row) => row.thread.id === threadId)) {
							setFilters(EMPTY_JOB_FILTERS);
						}
						window.requestAnimationFrame(() =>
							jobRegistry.elements.current
								.get(threadId)
								?.scrollIntoView?.({ block: "nearest" })
						);
					}}
					onViewFreelancer={viewFreelancer}
					related={relatedJobs(allRows, detailRow)}
					row={detailRow}
					threadView={conversationOpen ? threadView : null}
				/>
			);
		} else if (loading && allRows.length === 0) {
			detail = <DetailSkeleton />;
		} else if (allRows.length > 0 && rows.length === 0) {
			// The list explains the empty search; this pane just says so quietly.
			detail = <JobsDetailBlank />;
		} else {
			detail = <JobsDetailPlaceholder jobCount={allRows.length} />;
		}
	} else {
		middle = (
			<FreelancerList
				cursorId={freelancerCursor}
				heading={
					FREELANCER_FACETS.find((facet) => facet.id === freelancerFacet)
						?.label ?? "Freelancers"
				}
				headingExtra={inlineTabs}
				onFocusRow={setFreelancerCursorId}
				onKeyDownRow={onKeyDownFreelancer}
				onSelect={(agentId) => {
					setFreelancerCursorId(agentId);
					setStackedDetail(true);
				}}
				profiles={profiles}
				registerRow={freelancerRegistry.register}
				selectedId={freelancerCursor}
				total={snapshot.agents.length}
			/>
		);
		detail = selectedProfile ? (
			<FreelancerProfilePane
				composerRef={composerRef}
				hireOpen={hireAgentId === selectedProfile.agent.id}
				jobs={freelancerJobs(allRows, selectedProfile.agent.id)}
				now={now}
				onCancelHire={() => setHireAgentId(null)}
				onFocusHire={() => hire(selectedProfile.agent.id)}
				onHire={submitHire}
				onOpenJob={openJob}
				profile={selectedProfile}
			/>
		) : (
			<FreelancerDetailPlaceholder />
		);
	}

	const showFullView = conversationOpen && (fullView || stacked);
	// Stacked widths show one pane: the list, or what was picked from it.
	const stackedShowsDetail =
		stacked && tab === "freelancers" && stackedDetail && selectedProfile;

	let body: ReactNode;
	if (showFullView) {
		body = (
			<JobFullView
				now={now}
				onBack={stacked ? closeJob : () => setFullView(false)}
				onClose={closeJob}
				onViewFreelancer={viewFreelancer}
				row={activeRow}
				showSidebar={width >= FULL_SIDEBAR_MIN_WIDTH}
				threadView={threadView}
			/>
		);
	} else if (stacked) {
		body = stackedShowsDetail ? (
			<JobsStackedDetail detail={detail} setStackedDetail={setStackedDetail} />
		) : (
			<div className="flex min-h-0 flex-1">{middle}</div>
		);
	} else {
		body = (
			<JobsSplitPanes detail={detail} middle={middle} railMode={railMode} />
		);
	}

	return (
		<div
			aria-busy={loading}
			className="flex size-full min-h-0 flex-col bg-background text-foreground"
			data-layout={stacked ? "stacked" : railMode ? "rail" : "compact"}
			data-testid="interface-jobs"
			onKeyDown={onKeyDownRoot}
			ref={rootRef}
		>
			{showFullView ? null : (
				<JobsToolbar
					agents={agentsByName}
					alignToRail={railMode}
					compact={compact}
					companies={companies}
					facets={facets}
					filters={
						tab === "jobs" ? filters : { ...filters, query: freelancerQuery }
					}
					onFiltersChange={(next) => {
						if (tab === "jobs") {
							setFilters(next);
							setCursorId(null);
						} else {
							setFreelancerQuery(next.query);
						}
					}}
					onPostJob={() => setPostOpen(true)}
					searchRef={searchRef}
					tab={tab}
				/>
			)}
			<div className="flex min-h-0 flex-1">
				{railMode && !showFullView ? (
					<JobsRail
						companies={companies}
						companyCounts={companyCounts}
						filters={filters}
						freelancerCount={snapshot.agents.length}
						freelancerFacet={freelancerFacet}
						freelancerFacetCounts={freelancerFacetCounts}
						jobCount={allRows.length}
						onSelectCompany={selectCompany}
						onSelectFreelancerFacet={(facet) => {
							setFreelancerFacet(facet);
							setFreelancerCursorId(null);
						}}
						onSelectSaved={selectSaved}
						onSelectTab={selectTab}
						savedCounts={savedCounts}
						tab={tab}
					/>
				) : null}
				<div
					aria-labelledby={jobsTabId(tab)}
					className="flex min-h-0 min-w-0 flex-1"
					id={JOBS_PANEL_ID}
					role={showFullView ? undefined : "tabpanel"}
				>
					{body}
				</div>
			</div>
			<PostJobDialog
				agents={agentsByName}
				companies={companies}
				defaultAgentId={
					tab === "freelancers" ? (freelancerCursor ?? undefined) : undefined
				}
				defaultCompanyId={filters.companyIds[0] ?? PERSONAL_COMPANY_ID}
				onOpenChange={setPostOpen}
				onSubmit={submitPost}
				open={postOpen}
			/>
		</div>
	);
}
