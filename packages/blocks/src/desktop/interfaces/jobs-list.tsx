import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import {
	JOB_SORT_LABELS,
	type JobRow,
	type JobSort,
	jobAge,
	pluralize,
} from "./jobs-model.ts";
import { CompanyLogo, JobStatusPill } from "./jobs-parts.tsx";

const SORTS: readonly JobSort[] = ["recent", "status"];

function isJobSort(value: unknown): value is JobSort {
	return SORTS.some((sort) => sort === value);
}

export const jobRowDomId = (threadId: string) => `jobs-row-${threadId}`;

function JobCard({
	cursor,
	now,
	onFocusRow,
	onKeyDownRow,
	onSelect,
	registerRow,
	row,
	selected,
}: {
	/** The row that holds keyboard focus (roving tab stop). */
	cursor: boolean;
	now: number;
	onFocusRow: (threadId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, threadId: string) => void;
	onSelect: (threadId: string) => void;
	registerRow: (threadId: string, element: HTMLElement | null) => void;
	row: JobRow;
	/** The job shown in the detail pane. */
	selected: boolean;
}) {
	const { thread } = row;
	return (
		<div
			aria-selected={selected}
			className={cn(
				"group relative flex cursor-default gap-3 border-border border-b px-4 py-3 outline-none transition-colors",
				"hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
				"data-[selected=true]:bg-accent/70 data-[selected=true]:focus-visible:bg-accent/70 data-[selected=true]:hover:bg-accent/70"
			)}
			data-selected={selected}
			data-testid="jobs-row"
			id={jobRowDomId(thread.id)}
			onClick={() => onSelect(thread.id)}
			onFocus={() => onFocusRow(thread.id)}
			onKeyDown={(event) => onKeyDownRow(event, thread.id)}
			ref={(element) => registerRow(thread.id, element)}
			role="option"
			tabIndex={cursor ? 0 : -1}
		>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 left-0 z-10 w-0.5 bg-primary transition-opacity",
					selected ? "opacity-100" : "opacity-0"
				)}
			/>
			<CompanyLogo className="mt-0.5" company={row.company} size={40} />
			<div className="flex min-w-0 flex-1 flex-col">
				<p
					className={cn(
						"line-clamp-2 text-[15px] text-foreground leading-5 group-hover:underline group-hover:underline-offset-2",
						row.status === "review" ? "font-semibold" : "font-medium"
					)}
				>
					{row.title}
				</p>
				<p className="truncate text-foreground/80 text-sm leading-5">
					{row.company.name}
				</p>
				<div className="mt-1.5 flex h-5 min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] text-muted-foreground">
					<JobStatusPill status={row.status} />
					<Dot />
					{row.freelancer ? (
						<span className="flex min-w-0 items-center gap-1.5">
							<BoardAvatar
								agent={row.freelancer}
								name={row.freelancer.name}
								size={20}
							/>
							<span className="truncate text-foreground/80">
								{row.freelancer.name}
								{row.agents.length > 1 ? ` +${row.agents.length - 1}` : ""}
							</span>
						</span>
					) : (
						<span className="truncate">No freelancer</span>
					)}
					<Dot />
					<time className="shrink-0" dateTime={thread.updatedAt}>
						{jobAge(thread.updatedAt, now)}
					</time>
				</div>
			</div>
		</div>
	);
}

function Dot() {
	return (
		<span aria-hidden="true" className="shrink-0">
			·
		</span>
	);
}

function JobCardSkeleton() {
	return (
		<div className="flex gap-3 border-border border-b px-4 py-3">
			<Skeleton className="mt-0.5 size-10" radius="dense" />
			<div className="flex flex-1 flex-col gap-2 pt-0.5">
				<Skeleton className="h-4 w-4/5" radius="dense" />
				<Skeleton className="h-3.5 w-2/5" radius="dense" />
				<Skeleton className="mt-1 h-3.5 w-3/5" radius="dense" />
			</div>
		</div>
	);
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];

export interface JobsListProps {
	cursorId: string | null;
	/** Shown when nothing matches; null when there are no jobs at all. */
	emptyAction: ReactNode;
	hasJobs: boolean;
	heading: string;
	headingExtra?: ReactNode;
	loading: boolean;
	now: number;
	onFocusRow: (threadId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, threadId: string) => void;
	onSelect: (threadId: string) => void;
	onSortChange: (sort: JobSort) => void;
	registerRow: (threadId: string, element: HTMLElement | null) => void;
	rows: JobRow[];
	selectedId: string | null;
	sort: JobSort;
}

/** The middle pane: matching jobs as a keyboard listbox of job cards. */
export function JobsList({
	cursorId,
	emptyAction,
	hasJobs,
	heading,
	headingExtra,
	loading,
	now,
	onFocusRow,
	onKeyDownRow,
	onSelect,
	onSortChange,
	registerRow,
	rows,
	selectedId,
	sort,
}: JobsListProps) {
	const tl = useLiteralMessages();
	const showSkeleton = loading && rows.length === 0;
	const review = rows.filter((row) => row.status === "review").length;
	return (
		<section
			aria-label="Job list"
			className="flex min-h-0 w-full flex-col bg-background"
			data-testid="jobs-list"
		>
			{headingExtra}
			<header className="flex shrink-0 flex-col gap-0.5 border-border border-b px-4 pt-3 pb-3">
				<div className="flex h-7 items-center justify-between gap-3">
					<h2 className="min-w-0 truncate font-sans font-semibold! text-base text-foreground leading-6">
						{heading}
					</h2>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label={tl("Sort by {sortLabel}", {
										sortLabel: JOB_SORT_LABELS[sort],
									})}
									className="-mr-2 shrink-0 font-normal"
									size="xs"
									type="button"
									variant="ghost"
								/>
							}
						>
							<span className="text-muted-foreground">Sort by</span>
							<span className="font-medium text-foreground">
								{JOB_SORT_LABELS[sort]}
							</span>
							<ChevronDown aria-hidden="true" data-icon="inline-end" />
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className="w-44 rounded-lg border-border bg-popover p-1 shadow-lg backdrop-blur-none backdrop-saturate-100 before:hidden"
							drawerLabel="Sort by"
						>
							<DropdownMenuRadioGroup
								onValueChange={(value: unknown) => {
									if (isJobSort(value)) {
										onSortChange(value);
									}
								}}
								value={sort}
							>
								{SORTS.map((option) => (
									<DropdownMenuRadioItem key={option} value={option}>
										{JOB_SORT_LABELS[option]}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<p
					aria-live="polite"
					className="text-[13px] text-muted-foreground leading-[18px]"
				>
					{showSkeleton
						? "Loading jobs"
						: `${pluralize(rows.length, "result")}${review > 0 ? ` · ${review} ready for review` : ""}`}
				</p>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{showSkeleton ? (
					<div aria-hidden="true" data-testid="jobs-skeleton">
						{SKELETON_KEYS.map((key) => (
							<JobCardSkeleton key={key} />
						))}
					</div>
				) : null}
				{!showSkeleton && rows.length === 0 ? (
					<Empty className="h-full" inset="dense">
						<EmptyHeader>
							<EmptyTitle className="text-base">
								{hasJobs ? "No jobs match" : "No jobs posted yet"}
							</EmptyTitle>
							<EmptyDescription>
								{hasJobs
									? "Try a different search or clear the filters."
									: "Post a job to hire a freelancer. Each job keeps its own message thread."}
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>{emptyAction}</EmptyContent>
					</Empty>
				) : null}
				{rows.length > 0 ? (
					<div
						aria-busy={loading}
						aria-label="Jobs"
						className="flex flex-col"
						data-testid="jobs-rows"
						role="listbox"
					>
						{rows.map((row) => (
							<JobCard
								cursor={row.thread.id === cursorId}
								key={row.thread.id}
								now={now}
								onFocusRow={onFocusRow}
								onKeyDownRow={onKeyDownRow}
								onSelect={onSelect}
								registerRow={registerRow}
								row={row}
								selected={row.thread.id === selectedId}
							/>
						))}
					</div>
				) : null}
			</div>
		</section>
	);
}
