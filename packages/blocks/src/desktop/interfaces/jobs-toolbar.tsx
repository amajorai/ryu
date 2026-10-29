import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import {
	activeFilterCount,
	JOB_STATUS_LABELS,
	JOB_STATUS_ORDER,
	JOB_UPDATED_LABELS,
	type JobCompany,
	type JobFacetCounts,
	type JobFilters,
	type JobStatus,
	type JobUpdatedWithin,
	jobUpdatedPhrase,
	pillLabel,
	toggleValue,
} from "./jobs-model.ts";
import { CompanyLogo } from "./jobs-parts.tsx";

const UPDATED_OPTIONS: readonly JobUpdatedWithin[] = [
	"any",
	"day",
	"week",
	"month",
];

function isUpdatedWithin(value: unknown): value is JobUpdatedWithin {
	return UPDATED_OPTIONS.some((option) => option === value);
}

/** A LinkedIn-style filter pill: outline when idle, filled when applied. */
function FilterPill({
	active,
	children,
	label,
	menuLabel,
}: {
	active: boolean;
	children: ReactNode;
	label: string;
	menuLabel: string;
}) {
	const tl = useLiteralMessages();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={
							active
								? tl("{menuLabel} filter: {label}", { label, menuLabel })
								: tl("{menuLabel} filter", { menuLabel })
						}
						className={cn(
							"h-8 shrink-0 rounded-full px-3",
							!active && "text-foreground"
						)}
						size="sm"
						type="button"
						variant={active ? "default" : "outline"}
					/>
				}
			>
				<span className="max-w-40 truncate">{label}</span>
				<ChevronDown
					aria-hidden="true"
					className="size-3.5 opacity-70"
					data-icon="inline-end"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className={MENU_SURFACE}
				drawerLabel={menuLabel}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel className="px-2 pt-1.5 pb-1 font-medium">
						{menuLabel}
					</DropdownMenuLabel>
					{children}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * A solid popover surface: the shared menu is frosted glass, which lets the
 * job list bleed through the options.
 */
const MENU_SURFACE =
	"w-64 rounded-lg border-border bg-popover p-1 shadow-lg backdrop-blur-none backdrop-saturate-100 before:hidden";

/** Options lay out as [control] [label] [count]; the built-in tick is hidden. */
const OPTION =
	"h-8 gap-2.5 rounded-md py-0 ps-2 pe-2 font-normal [&>[data-slot$=-indicator]]:hidden";

function OptionCount({ value }: { value: number }) {
	return (
		<span className="ms-auto ps-3 text-muted-foreground text-xs tabular-nums">
			{value}
		</span>
	);
}

/** A visible checkbox, so unchecked options still read as selectable. */
function OptionCheck({ checked }: { checked: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
				checked
					? "border-primary bg-primary text-primary-foreground"
					: "border-input bg-background"
			)}
		>
			{checked ? <Check className="size-3" strokeWidth={3} /> : null}
		</span>
	);
}

/** The single-choice counterpart for the Updated menu. */
function OptionRadio({ checked }: { checked: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
				checked ? "border-primary" : "border-input bg-background"
			)}
		>
			{checked ? <span className="size-2 rounded-full bg-primary" /> : null}
		</span>
	);
}

export interface JobsToolbarProps {
	agents: InterfaceAgent[];
	/** The rail is showing, so the search box spans exactly its width. */
	alignToRail: boolean;
	compact: boolean;
	companies: JobCompany[];
	/** Jobs each filter option would show, given the other filters. */
	facets: JobFacetCounts;
	filters: JobFilters;
	onFiltersChange: (filters: JobFilters) => void;
	onPostJob: () => void;
	searchRef: RefObject<HTMLInputElement | null>;
	/** Which list the search box narrows. */
	tab: "freelancers" | "jobs";
}

/**
 * The top bar: one search box, the four filter pills (Status, Freelancer,
 * Company, Updated), "Clear all" while anything is applied, and the primary
 * "Post a job" action. Pills only apply to jobs, so they hide on Freelancers.
 */
export function JobsToolbar({
	agents,
	alignToRail,
	companies,
	compact,
	facets,
	filters,
	onFiltersChange,
	onPostJob,
	searchRef,
	tab,
}: JobsToolbarProps) {
	const set = (patch: Partial<JobFilters>) =>
		onFiltersChange({ ...filters, ...patch });
	const statusNames = filters.statuses.map(
		(status) => JOB_STATUS_LABELS[status]
	);
	const freelancerNames = agents
		.filter((agent) => filters.freelancerIds.includes(agent.id))
		.map((agent) => agent.name);
	const companyNames = companies
		.filter((company) => filters.companyIds.includes(company.id))
		.map((company) => company.name);
	const pills = activeFilterCount(filters);
	const placeholder = tab === "jobs" ? "Search jobs" : "Search freelancers";

	return (
		<header
			className={cn(
				"flex shrink-0 items-center gap-2 border-border border-b bg-background px-4",
				compact ? "flex-wrap py-2" : "h-14"
			)}
			data-testid="jobs-toolbar"
		>
			<div
				className={cn(
					"shrink-0",
					compact ? "min-w-0 flex-1" : alignToRail ? "w-60" : "w-72"
				)}
				role="search"
			>
				<InputGroup className="h-8 rounded-full bg-muted/70">
					<InputGroupAddon>
						<Search aria-hidden="true" className="size-4" />
					</InputGroupAddon>
					<InputGroupInput
						aria-label={placeholder}
						enterKeyHint="search"
						onChange={(event) => set({ query: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === "Escape" && filters.query) {
								event.preventDefault();
								event.stopPropagation();
								set({ query: "" });
							}
						}}
						placeholder={placeholder}
						ref={searchRef}
						type="text"
						value={filters.query}
					/>
					<InputGroupAddon align="inline-end">
						{filters.query ? (
							<InputGroupButton
								aria-label="Clear search"
								onClick={() => {
									set({ query: "" });
									searchRef.current?.focus();
								}}
								size="icon-xs"
							>
								<X aria-hidden="true" />
							</InputGroupButton>
						) : (
							<Kbd aria-hidden="true">/</Kbd>
						)}
					</InputGroupAddon>
				</InputGroup>
			</div>

			{tab === "jobs" ? (
				<fieldset
					aria-label="Job filters"
					className={cn(
						"flex min-w-0 items-center gap-2 py-1",
						compact
							? "order-last -mx-4 basis-full overflow-x-auto pr-8 pl-4"
							: "flex-1 overflow-x-auto pr-8 pl-1",
						// A trailing fade says more pills scroll in from the right.
						"[mask-image:linear-gradient(to_right,black_calc(100%_-_2rem),transparent)] [scrollbar-width:none]"
					)}
				>
					<FilterPill
						active={filters.statuses.length > 0}
						label={pillLabel("Status", statusNames)}
						menuLabel="Status"
					>
						{JOB_STATUS_ORDER.map((status: JobStatus) => (
							<DropdownMenuCheckboxItem
								checked={filters.statuses.includes(status)}
								className={OPTION}
								key={status}
								onCheckedChange={() =>
									set({ statuses: toggleValue(filters.statuses, status) })
								}
							>
								<OptionCheck checked={filters.statuses.includes(status)} />
								<span className="truncate">{JOB_STATUS_LABELS[status]}</span>
								<OptionCount value={facets.statuses[status]} />
							</DropdownMenuCheckboxItem>
						))}
					</FilterPill>
					<FilterPill
						active={filters.freelancerIds.length > 0}
						label={pillLabel("Freelancer", freelancerNames)}
						menuLabel="Freelancer"
					>
						{agents.map((agent) => (
							<DropdownMenuCheckboxItem
								checked={filters.freelancerIds.includes(agent.id)}
								className={OPTION}
								key={agent.id}
								onCheckedChange={() =>
									set({
										freelancerIds: toggleValue(filters.freelancerIds, agent.id),
									})
								}
							>
								<OptionCheck
									checked={filters.freelancerIds.includes(agent.id)}
								/>
								<BoardAvatar agent={agent} name={agent.name} size={20} />
								<span className="truncate">{agent.name}</span>
								<OptionCount value={facets.freelancers.get(agent.id) ?? 0} />
							</DropdownMenuCheckboxItem>
						))}
					</FilterPill>
					<FilterPill
						active={filters.companyIds.length > 0}
						label={pillLabel("Company", companyNames)}
						menuLabel="Company"
					>
						{companies.map((company) => (
							<DropdownMenuCheckboxItem
								checked={filters.companyIds.includes(company.id)}
								className={OPTION}
								key={company.id}
								onCheckedChange={() =>
									set({
										companyIds: toggleValue(filters.companyIds, company.id),
									})
								}
							>
								<OptionCheck
									checked={filters.companyIds.includes(company.id)}
								/>
								<CompanyLogo company={company} size={20} />
								<span className="truncate">{company.name}</span>
								<OptionCount value={facets.companies.get(company.id) ?? 0} />
							</DropdownMenuCheckboxItem>
						))}
					</FilterPill>
					<FilterPill
						active={filters.updated !== "any"}
						label={jobUpdatedPhrase(filters.updated)}
						menuLabel="Last updated"
					>
						<DropdownMenuRadioGroup
							onValueChange={(value: unknown) => {
								if (isUpdatedWithin(value)) {
									set({ updated: value });
								}
							}}
							value={filters.updated}
						>
							{UPDATED_OPTIONS.map((option) => (
								<DropdownMenuRadioItem
									className={OPTION}
									key={option}
									value={option}
								>
									<OptionRadio checked={filters.updated === option} />
									<span className="truncate">{JOB_UPDATED_LABELS[option]}</span>
									<OptionCount value={facets.updated[option]} />
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</FilterPill>
					{pills > 0 ? (
						<Button
							className="h-8 shrink-0 rounded-full px-3"
							onClick={() =>
								onFiltersChange({
									companyIds: [],
									freelancerIds: [],
									query: filters.query,
									statuses: [],
									updated: "any",
								})
							}
							size="sm"
							type="button"
							variant="ghost-muted"
						>
							Clear all
						</Button>
					) : null}
				</fieldset>
			) : null}
			{compact || tab === "jobs" ? null : <div className="flex-1" />}

			<Button
				aria-label={compact ? "Post a job" : undefined}
				className={cn("h-8 shrink-0 rounded-full", compact ? "w-8" : "px-3")}
				data-testid="jobs-post"
				onClick={onPostJob}
				size={compact ? "icon-sm" : "sm"}
				type="button"
			>
				<Plus
					aria-hidden="true"
					data-icon={compact ? undefined : "inline-start"}
				/>
				{compact ? null : "Post a job"}
			</Button>
		</header>
	);
}
