import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Briefcase, ChevronDown, Users } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import {
	FREELANCER_FACETS,
	type FreelancerFacet,
	JOB_SAVED_SEARCHES,
	type JobCompany,
	type JobFilters,
	type JobSavedSearch,
	matchesSavedSearch,
} from "./jobs-model.ts";
import { CompanyLogo, JobsSectionLabel } from "./jobs-parts.tsx";

export type JobsTab = "freelancers" | "jobs";

export const JOBS_TABS: readonly { id: JobsTab; label: string }[] = [
	{ id: "jobs", label: "My jobs" },
	{ id: "freelancers", label: "Freelancers" },
];

const TAB_ICON: Record<JobsTab, ReactNode> = {
	freelancers: <Users aria-hidden="true" className="size-4" />,
	jobs: <Briefcase aria-hidden="true" className="size-4" />,
};

export const jobsTabId = (tab: JobsTab) => `jobs-tab-${tab}`;
export const JOBS_PANEL_ID = "jobs-panel";

/** Moves between tabs with the arrow keys, per the ARIA tabs pattern. */
export function onTabsKeyDown(
	event: KeyboardEvent<HTMLElement>,
	tab: JobsTab,
	onSelect: (tab: JobsTab) => void
) {
	const keys = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"];
	if (!keys.includes(event.key)) {
		return;
	}
	event.preventDefault();
	const next: JobsTab = tab === "jobs" ? "freelancers" : "jobs";
	onSelect(next);
	const element = event.currentTarget.parentElement?.querySelector<HTMLElement>(
		`#${jobsTabId(next)}`
	);
	element?.focus();
}

const ITEM =
	"flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring";
const ITEM_ACTIVE =
	"bg-accent font-medium text-accent-foreground hover:bg-accent";
/**
 * Section tabs read as navigation, not as a selected filter: the active one
 * is bold text with no fill, so only the active saved search is filled.
 */
const TAB = cn(ITEM, "text-muted-foreground hover:text-foreground");
const TAB_ACTIVE = "font-semibold text-foreground hover:bg-muted";

function Count({ value }: { value: number }) {
	return (
		<span className="ml-auto text-muted-foreground text-xs tabular-nums">
			{value}
		</span>
	);
}

export interface JobsRailProps {
	companies: JobCompany[];
	companyCounts: Map<string, number>;
	filters: JobFilters;
	freelancerCount: number;
	freelancerFacet: FreelancerFacet;
	freelancerFacetCounts: Record<FreelancerFacet, number>;
	jobCount: number;
	onSelectCompany: (companyId: string) => void;
	onSelectFreelancerFacet: (facet: FreelancerFacet) => void;
	onSelectSaved: (saved: JobSavedSearch) => void;
	onSelectTab: (tab: JobsTab) => void;
	savedCounts: Map<string, number>;
	tab: JobsTab;
}

/**
 * The left pane: the My jobs / Freelancers tabs, then the active tab's
 * facets. On My jobs, saved searches with live counts and the companies
 * (Personal, projects, teams) jobs are filed under; on Freelancers, who is
 * working now and who is available.
 */
export function JobsRail({
	companies,
	companyCounts,
	filters,
	freelancerCount,
	freelancerFacet,
	freelancerFacetCounts,
	jobCount,
	onSelectCompany,
	onSelectFreelancerFacet,
	onSelectSaved,
	onSelectTab,
	savedCounts,
	tab,
}: JobsRailProps) {
	const counts: Record<JobsTab, number> = {
		freelancers: freelancerCount,
		jobs: jobCount,
	};
	const companyFiltered =
		filters.companyIds.length === 1 ? filters.companyIds[0] : null;
	return (
		<nav
			aria-label="Jobs navigation"
			className="flex w-64 shrink-0 flex-col gap-6 overflow-y-auto border-border border-r bg-background px-3 py-4"
			data-testid="jobs-rail"
		>
			<div
				aria-label="Jobs sections"
				aria-orientation="vertical"
				className="flex flex-col gap-0.5"
				role="tablist"
			>
				{JOBS_TABS.map((item) => {
					const selected = item.id === tab;
					return (
						<button
							aria-controls={JOBS_PANEL_ID}
							aria-selected={selected}
							className={cn(TAB, selected && TAB_ACTIVE)}
							id={jobsTabId(item.id)}
							key={item.id}
							onClick={() => onSelectTab(item.id)}
							onKeyDown={(event) => onTabsKeyDown(event, item.id, onSelectTab)}
							role="tab"
							tabIndex={selected ? 0 : -1}
							type="button"
						>
							<span
								className={
									selected ? "text-foreground" : "text-muted-foreground"
								}
							>
								{TAB_ICON[item.id]}
							</span>
							{item.label}
							<Count value={counts[item.id]} />
						</button>
					);
				})}
			</div>

			{tab === "freelancers" ? (
				<section
					aria-labelledby="jobs-availability-label"
					className="flex flex-col gap-1"
				>
					<JobsSectionLabel className="px-2" id="jobs-availability-label">
						Availability
					</JobsSectionLabel>
					<ul className="flex flex-col gap-0.5">
						{FREELANCER_FACETS.map((facet) => {
							const active = facet.id === freelancerFacet;
							return (
								<li key={facet.id}>
									<button
										aria-current={active ? "true" : undefined}
										className={cn(ITEM, active && ITEM_ACTIVE)}
										onClick={() => onSelectFreelancerFacet(facet.id)}
										type="button"
									>
										<span className="truncate">{facet.label}</span>
										<Count value={freelancerFacetCounts[facet.id]} />
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			) : (
				<>
					<section
						aria-labelledby="jobs-saved-label"
						className="flex flex-col gap-1"
					>
						<JobsSectionLabel className="px-2" id="jobs-saved-label">
							Saved searches
						</JobsSectionLabel>
						<ul className="flex flex-col gap-0.5">
							{JOB_SAVED_SEARCHES.map((saved) => {
								const active =
									tab === "jobs" && matchesSavedSearch(filters, saved);
								return (
									<li key={saved.id}>
										<button
											aria-current={active ? "true" : undefined}
											className={cn(ITEM, active && ITEM_ACTIVE)}
											onClick={() => onSelectSaved(saved)}
											type="button"
										>
											<span className="truncate">{saved.label}</span>
											<Count value={savedCounts.get(saved.id) ?? 0} />
										</button>
									</li>
								);
							})}
						</ul>
					</section>

					<section
						aria-labelledby="jobs-companies-label"
						className="flex flex-col gap-1"
					>
						<JobsSectionLabel className="px-2" id="jobs-companies-label">
							Companies
						</JobsSectionLabel>
						<ul className="flex flex-col gap-0.5">
							{companies.map((company) => {
								const active = tab === "jobs" && companyFiltered === company.id;
								return (
									<li key={company.id}>
										<button
											aria-current={active ? "true" : undefined}
											className={cn(ITEM, active && ITEM_ACTIVE)}
											onClick={() => onSelectCompany(company.id)}
											type="button"
										>
											<CompanyLogo company={company} size={20} />
											<span className="truncate">{company.name}</span>
											<Count value={companyCounts.get(company.id) ?? 0} />
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				</>
			)}
		</nav>
	);
}

/** The tabs as an underline strip, for widths where the rail is hidden. */
export function JobsInlineTabs({
	onSelectTab,
	tab,
	trailing,
}: {
	onSelectTab: (tab: JobsTab) => void;
	tab: JobsTab;
	/** Shown at the row's end, e.g. the saved searches menu. */
	trailing?: ReactNode;
}) {
	return (
		<div className="flex h-11 shrink-0 items-stretch border-border border-b px-4">
			<div
				aria-label="Jobs sections"
				className="flex items-stretch gap-5"
				data-testid="jobs-inline-tabs"
				role="tablist"
			>
				{JOBS_TABS.map((item) => {
					const selected = item.id === tab;
					return (
						<button
							aria-controls={JOBS_PANEL_ID}
							aria-selected={selected}
							className={cn(
								"relative flex items-center text-sm outline-none transition-colors focus-visible:text-foreground focus-visible:underline",
								selected
									? "font-medium text-foreground"
									: "text-muted-foreground hover:text-foreground"
							)}
							id={jobsTabId(item.id)}
							key={item.id}
							onClick={() => onSelectTab(item.id)}
							onKeyDown={(event) => onTabsKeyDown(event, item.id, onSelectTab)}
							role="tab"
							tabIndex={selected ? 0 : -1}
							type="button"
						>
							{item.label}
							<span
								aria-hidden="true"
								className={cn(
									"absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground transition-opacity",
									selected ? "opacity-100" : "opacity-0"
								)}
							/>
						</button>
					);
				})}
			</div>
			{trailing ? (
				<div className="ml-auto flex items-center">{trailing}</div>
			) : null}
		</div>
	);
}

/**
 * The rail's saved searches as one compact menu, for widths where the rail
 * is hidden.
 */
export function SavedSearchMenu({
	filters,
	onSelectSaved,
	savedCounts,
}: {
	filters: JobFilters;
	onSelectSaved: (saved: JobSavedSearch) => void;
	savedCounts: Map<string, number>;
}) {
	const tl = useLiteralMessages();
	const active = JOB_SAVED_SEARCHES.find((saved) =>
		matchesSavedSearch(filters, saved)
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={
							active
								? tl("Saved searches: {label}", { label: active.label })
								: tl("Saved searches")
						}
						className="-mr-2 font-normal"
						size="xs"
						type="button"
						variant="ghost"
					/>
				}
			>
				<span className="text-muted-foreground">Saved</span>
				<span className="max-w-36 truncate font-medium text-foreground">
					{active?.label ?? "Custom"}
				</span>
				<ChevronDown aria-hidden="true" data-icon="inline-end" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-64 rounded-lg border-border bg-popover p-1 shadow-lg backdrop-blur-none backdrop-saturate-100 before:hidden"
				drawerLabel="Saved searches"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Saved searches</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						onValueChange={(value: unknown) => {
							const saved = JOB_SAVED_SEARCHES.find(
								(candidate) => candidate.id === value
							);
							if (saved) {
								onSelectSaved(saved);
							}
						}}
						value={active?.id ?? ""}
					>
						{JOB_SAVED_SEARCHES.map((saved) => (
							<DropdownMenuRadioItem key={saved.id} value={saved.id}>
								<span className="truncate">{saved.label}</span>
								<span className="ms-auto ps-3 text-muted-foreground text-xs tabular-nums">
									{savedCounts.get(saved.id) ?? 0}
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
