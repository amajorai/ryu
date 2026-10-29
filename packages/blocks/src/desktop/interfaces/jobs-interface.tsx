import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, Plus } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { JobDetail, JobDetailEmpty, JobFullView } from "./jobs-detail.tsx";
import { FreelancerList, FreelancerProfilePane } from "./jobs-freelancers.tsx";
import { JobsList } from "./jobs-list.tsx";
import {
	applySavedSearch,
	countByCompany,
	cursorStep,
	EMPTY_JOB_FILTERS,
	FREELANCER_FACETS,
	type FreelancerFacet,
	filterFreelancers,
	filterJobs,
	freelancerJobs,
	freelancerProfiles,
	JOB_SAVED_SEARCHES,
	type JobFilters,
	type JobSavedSearch,
	type JobSort,
	jobCompanies,
	jobFacetCounts,
	jobRows,
	jobStartInput,
	matchesFreelancerFacet,
	matchesSavedSearch,
	PERSONAL_COMPANY_ID,
	relatedJobs,
	sortJobs,
	stepIndex,
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

const MINUTE = 60_000;
/** At or above this width the left rail (tabs, saved searches) shows. */
const RAIL_MIN_WIDTH = 1180;
/** Below this width the filter pills wrap under the search box. */
const COMPACT_MAX_WIDTH = 860;
/** Below this width the list and the detail take turns. */
const STACKED_MAX_WIDTH = 720;
/** At or above this width full view keeps its details sidebar. */
const FULL_SIDEBAR_MIN_WIDTH = 960;
const UNMEASURED_WIDTH = 1440;

/** Wall clock that ticks once a minute so relative times stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's rendered width, kept current with a ResizeObserver. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width;
			if (next !== undefined) {
				setWidth(next);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width || UNMEASURED_WIDTH;
}

/** True for targets whose keys belong to typing, menus, or the host's chat. */
function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-testid='jobs-thread-view']") !== null
	);
}

function DetailSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="flex flex-1 flex-col gap-3 px-6 pt-5"
			data-testid="jobs-detail-skeleton"
		>
			<div className="flex items-center gap-2">
				<Skeleton className="size-8" radius="dense" />
				<Skeleton className="h-4 w-32" radius="dense" />
			</div>
			<Skeleton className="h-6 w-3/5" radius="dense" />
			<Skeleton className="h-4 w-2/5" radius="dense" />
			<Skeleton className="mt-4 h-24 w-full" radius="row" />
		</div>
	);
}

function useRowRegistry() {
	const elements = useRef(new Map<string, HTMLElement>());
	const register = useCallback((id: string, element: HTMLElement | null) => {
		if (element) {
			elements.current.set(id, element);
		} else {
			elements.current.delete(id);
		}
	}, []);
	const focus = useCallback((id: string | undefined) => {
		if (!id) {
			return;
		}
		const element = elements.current.get(id);
		element?.focus({ preventScroll: true });
		element?.scrollIntoView?.({ block: "nearest" });
	}, []);
	return { elements, focus, register };
}

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

	// A thread opened from anywhere (host, history, a new post) is a job.
	useEffect(() => {
		if (activeThreadId) {
			setTab("jobs");
			setCursorId(activeThreadId);
		}
	}, [activeThreadId]);

	useEffect(() => {
		if (!conversationOpen) {
			setFullView(false);
		}
	}, [conversationOpen]);

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

	const onKeyDownJob = (
		event: KeyboardEvent<HTMLElement>,
		threadId: string
	) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const step = cursorStep(event.key);
		if (step) {
			event.preventDefault();
			event.stopPropagation();
			const next =
				order[stepIndex(step, order.indexOf(threadId), order.length)];
			if (next) {
				setCursorId(next);
				jobRegistry.focus(next);
			}
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			openJob(threadId);
			return;
		}
		if (event.key === "Escape" && conversationOpen) {
			event.preventDefault();
			event.stopPropagation();
			closeJob();
		}
	};

	const onKeyDownFreelancer = (
		event: KeyboardEvent<HTMLElement>,
		agentId: string
	) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		if (event.target !== event.currentTarget) {
			return;
		}
		const step = cursorStep(event.key);
		if (step) {
			event.preventDefault();
			event.stopPropagation();
			const next =
				freelancerOrder[
					stepIndex(
						step,
						freelancerOrder.indexOf(agentId),
						freelancerOrder.length
					)
				];
			if (next) {
				setFreelancerCursorId(next);
				freelancerRegistry.focus(next);
			}
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			hire(agentId);
		}
	};

	const onKeyDownRoot = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			ownsKeys(event.target)
		) {
			return;
		}
		if (event.key === "Escape" && fullView) {
			event.preventDefault();
			setFullView(false);
		}
	};

	// "/" focuses search from anywhere on the page, not only from inside the
	// interface: on a fresh load, or after clicking plain text, focus sits on
	// the body. Typing targets and the host's chat keep their keys.
	useEffect(() => {
		const onKeyDownDocument = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "/" ||
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				ownsKeys(event.target)
			) {
				return;
			}
			const root = rootRef.current;
			const search = searchRef.current;
			if (
				!(root?.isConnected && search) ||
				root.getClientRects().length === 0
			) {
				return;
			}
			const target = event.target;
			// Inside another surface (a dialog, another pane) the key is theirs.
			if (
				target instanceof Node &&
				target !== document.body &&
				!root.contains(target)
			) {
				return;
			}
			event.preventDefault();
			search.focus();
		};
		document.addEventListener("keydown", onKeyDownDocument);
		return () => document.removeEventListener("keydown", onKeyDownDocument);
	}, []);

	const postButton = (
		<Button onClick={() => setPostOpen(true)} size="sm" type="button">
			<Plus aria-hidden="true" data-icon="inline-start" />
			Post a job
		</Button>
	);

	const savedMatch = JOB_SAVED_SEARCHES.find(
		(saved) => saved.id !== "all" && matchesSavedSearch(filters, saved)
	);
	const singleCompany =
		filters.companyIds.length === 1
			? companies.find((company) => company.id === filters.companyIds[0])
			: undefined;
	const query = filters.query.trim();
	const heading = query
		? `Results for “${query}”`
		: (savedMatch?.label ?? singleCompany?.name ?? "All jobs");

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
			detail = (
				<JobDetailEmpty>
					<p
						className="text-muted-foreground text-sm"
						data-testid="jobs-detail-blank"
					>
						No job to preview
					</p>
				</JobDetailEmpty>
			);
		} else {
			detail = (
				<JobDetailEmpty>
					<h2 className="font-sans font-semibold! text-base text-foreground">
						{allRows.length === 0
							? "Your jobs show up here"
							: "No job selected"}
					</h2>
					<p className="max-w-xs text-muted-foreground text-sm">
						{allRows.length === 0
							? "Post a job and its details, deliverable, and message thread appear in this pane."
							: "Pick a job from the list to see its details and messages."}
					</p>
				</JobDetailEmpty>
			);
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
			<JobDetailEmpty>
				<h2 className="font-sans font-semibold! text-base text-foreground">
					No freelancer selected
				</h2>
				<p className="max-w-xs text-muted-foreground text-sm">
					Freelancers are your agents. Pick one to see their record and hire
					them for a job.
				</p>
			</JobDetailEmpty>
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
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex h-11 shrink-0 items-center border-border border-b px-2">
					<Button
						onClick={() => setStackedDetail(false)}
						size="sm"
						type="button"
						variant="ghost"
					>
						<ArrowLeft aria-hidden="true" data-icon="inline-start" />
						Freelancers
					</Button>
				</div>
				{detail}
			</div>
		) : (
			<div className="flex min-h-0 flex-1">{middle}</div>
		);
	} else {
		body = (
			<>
				<div
					className={cn(
						"flex min-h-0 shrink-0 border-border border-r",
						railMode ? "w-[400px]" : "w-[360px]"
					)}
				>
					{middle}
				</div>
				<div className="flex min-h-0 min-w-0 flex-1">{detail}</div>
			</>
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
