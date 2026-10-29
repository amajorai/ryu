import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ArrowLeft, Maximize2, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import {
	JOB_STATUS_LABELS,
	type JobRow,
	jobAge,
	jobFullTime,
	jobStatusDetail,
	jobTimeline,
	pluralize,
} from "./jobs-model.ts";
import {
	availabilityLabel,
	CompanyLogo,
	FreelancerAvatar,
	FreelancerChip,
	JobStatusPill,
} from "./jobs-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const COMPANY_KIND: Record<JobRow["company"]["kind"], string> = {
	personal: "Your own job",
	project: "Project",
	team: "Team",
};

/** A short settle-in when the shown job changes; none with reduced motion. */
function useEnter() {
	const reduced = useReducedMotion();
	return reduced
		? {}
		: {
				animate: { opacity: 1, y: 0 },
				initial: { opacity: 0, y: 4 },
				transition: { duration: 0.16, ease: [0.2, 0, 0, 1] as const },
			};
}

/** Posted and hired, then where the job stands now, as a compact rail. */
export function JobTimeline({ now, row }: { now: number; row: JobRow }) {
	const entries = jobTimeline(row);
	return (
		<ol className="flex flex-col" data-testid="jobs-timeline">
			{entries.map((entry, index) => {
				const last = index === entries.length - 1;
				return (
					<li className="relative flex gap-3 pb-3 last:pb-0" key={entry.id}>
						{last ? null : (
							<span
								aria-hidden="true"
								className="absolute top-3.5 bottom-0 left-[3px] w-px bg-border"
							/>
						)}
						<span
							aria-hidden="true"
							className={cn(
								"relative mt-1.5 size-[7px] shrink-0 rounded-full",
								entry.state === "current"
									? "bg-primary ring-3 ring-primary/20"
									: "bg-muted-foreground/50"
							)}
						/>
						<div className="flex min-w-0 flex-col">
							<span
								className={cn(
									"text-sm leading-5",
									entry.state === "current"
										? "font-medium text-foreground"
										: "text-foreground"
								)}
							>
								{entry.label}
							</span>
							{entry.at ? (
								<time
									className="text-[13px] text-muted-foreground leading-[18px]"
									dateTime={entry.at}
									title={jobFullTime(entry.at)}
								>
									{jobAge(entry.at, now)}
								</time>
							) : null}
							{entry.detail ? (
								<span className="text-[13px] text-muted-foreground leading-[18px]">
									{entry.detail}
								</span>
							) : null}
						</div>
					</li>
				);
			})}
		</ol>
	);
}

/** "Deliverable" for the freelancer's hand-over; the user's own note is not one. */
export function deliverableHeading(row: JobRow): string {
	return row.deliverable?.from === "you" ? "Latest message" : "Deliverable";
}

/** The newest message, attributed: what the freelancer handed over. */
export function JobDeliverable({ row }: { row: JobRow }) {
	const { deliverable } = row;
	if (!deliverable) {
		return (
			<p className="text-muted-foreground text-sm leading-5">
				Nothing delivered yet.
			</p>
		);
	}
	const author =
		deliverable.from === "you" ? "You" : (row.freelancer?.name ?? "Freelancer");
	return (
		<figure className="flex flex-col gap-1" data-testid="jobs-deliverable">
			<blockquote className="whitespace-pre-line text-foreground text-sm leading-5">
				{deliverable.text}
			</blockquote>
			<figcaption className="text-[13px] text-muted-foreground leading-[18px]">
				{author} wrote this · {pluralize(row.thread.messageCount, "message")} in
				the thread
			</figcaption>
		</figure>
	);
}

function JobMeta({ now, row }: { now: number; row: JobRow }) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground text-sm">
			<JobStatusPill className="text-sm" status={row.status} />
			<FreelancerChip
				agent={row.freelancer}
				extra={row.agents.length - 1}
				size={20}
			/>
			<span aria-hidden="true">·</span>
			<time
				dateTime={row.thread.updatedAt}
				title={jobFullTime(row.thread.updatedAt)}
			>
				Updated {jobAge(row.thread.updatedAt, now).toLowerCase()}
			</time>
		</div>
	);
}

function CompanyLine({ row }: { row: JobRow }) {
	return (
		<div className="flex min-w-0 items-center gap-2">
			<CompanyLogo company={row.company} size={32} />
			<div className="flex min-w-0 flex-col">
				<span className="truncate font-medium text-foreground text-sm leading-5">
					{row.company.name}
				</span>
				<span className="text-[13px] text-muted-foreground leading-[18px]">
					{COMPANY_KIND[row.company.kind]}
				</span>
			</div>
		</div>
	);
}

/** A hired freelancer as a profile link, like "Meet the hiring team". */
function FreelancerLink({
	agent,
	onView,
}: {
	agent: InterfaceAgent;
	onView: (agentId: string) => void;
}) {
	const headline = agent.description || "Freelancer";
	return (
		<button
			aria-label={`View ${agent.name}'s profile`}
			className="-mx-2 flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			onClick={() => onView(agent.id)}
			type="button"
		>
			<FreelancerAvatar agent={agent} size={40} />
			<span className="flex min-w-0 flex-col">
				<span className="truncate font-medium text-foreground text-sm leading-5">
					{agent.name}
				</span>
				<span
					className="truncate text-[13px] text-muted-foreground leading-[18px]"
					title={headline}
				>
					{headline}
				</span>
				<span className="text-[13px] text-muted-foreground leading-[18px]">
					{availabilityLabel(agent)}
				</span>
			</span>
		</button>
	);
}

/** Freelancers shown by name before the rest fold into "and N more". */
const FREELANCERS_SHOWN = 3;

/** Every hired freelancer, up to three rows, each linking to their profile. */
function JobFreelancers({
	onView,
	row,
}: {
	onView: (agentId: string) => void;
	row: JobRow;
}) {
	if (row.agents.length === 0) {
		return (
			<p className="text-muted-foreground text-sm leading-5">
				No freelancer hired
			</p>
		);
	}
	const hidden = row.agents.length - FREELANCERS_SHOWN;
	return (
		<div className="flex flex-col gap-1">
			{row.agents.slice(0, FREELANCERS_SHOWN).map((agent) => (
				<FreelancerLink agent={agent} key={agent.id} onView={onView} />
			))}
			{hidden > 0 ? (
				<p className="text-[13px] text-muted-foreground leading-[18px]">
					and {hidden} more
				</p>
			) : null}
		</div>
	);
}

export interface JobDetailProps {
	now: number;
	onClose: () => void;
	onOpen: (threadId: string) => void;
	onOpenFullView: () => void;
	/** Shows another job in this pane without opening its thread. */
	onPreview: (threadId: string) => void;
	onViewFreelancer: (agentId: string) => void;
	/** Other jobs with the same freelancer. */
	related: JobRow[];
	row: JobRow;
	/** The host's chat for this job, or null when only previewing it. */
	threadView: ReactNode | null;
}

/**
 * The one section heading style in the detail pane: semibold body-size text,
 * so the job title stays the only large element.
 */
function PaneHeading({ children, id }: { children: string; id?: string }) {
	return (
		<h3
			className="font-sans font-semibold! text-foreground text-sm leading-5"
			id={id}
		>
			{children}
		</h3>
	);
}

/** Facts the snapshot records about the job, as a two-column list. */
function JobFacts({
	compact = false,
	now,
	row,
}: {
	/** The narrow column beside the thread: the header already shows status. */
	compact?: boolean;
	now: number;
	row: JobRow;
}) {
	const facts: { label: string; value: ReactNode }[] = [
		{ label: "Company", value: row.company.name },
		...(compact
			? []
			: [{ label: "Status", value: JOB_STATUS_LABELS[row.status] }]),
		{ label: "Messages", value: String(row.thread.messageCount) },
		{
			label: "Last update",
			value: (
				<time
					dateTime={row.thread.updatedAt}
					title={jobFullTime(row.thread.updatedAt)}
				>
					{compact
						? jobAge(row.thread.updatedAt, now)
						: jobFullTime(row.thread.updatedAt) ||
							jobAge(row.thread.updatedAt, now)}
				</time>
			),
		},
	];
	return (
		<dl
			className={cn(
				"grid gap-x-4 gap-y-2 text-sm leading-5",
				compact
					? "grid-cols-[5.5rem_minmax(0,1fr)]"
					: "grid-cols-[8rem_minmax(0,1fr)]"
			)}
			data-testid="jobs-facts"
		>
			{facts.map((fact) => (
				<div className="contents" key={fact.label}>
					<dt className="text-muted-foreground">{fact.label}</dt>
					<dd className="min-w-0 truncate text-foreground">{fact.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** "More jobs with Forge": compact rows that preview in this pane. */
function RelatedJobs({
	now,
	onPreview,
	rows,
}: {
	now: number;
	onPreview: (threadId: string) => void;
	rows: JobRow[];
}) {
	return (
		<ul className="-mx-2 flex flex-col">
			{rows.map((related) => (
				<li key={related.thread.id}>
					<button
						className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => onPreview(related.thread.id)}
						type="button"
					>
						<CompanyLogo company={related.company} size={32} />
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate font-medium text-foreground text-sm leading-5">
								{related.title}
							</span>
							<span className="truncate text-[13px] text-muted-foreground leading-[18px]">
								{related.company.name} · {jobAge(related.thread.updatedAt, now)}
							</span>
						</span>
						<JobStatusPill status={related.status} />
					</button>
				</li>
			))}
		</ul>
	);
}

/**
 * The right pane, LinkedIn-style: company, title, status and freelancer up
 * top. Previewing, the body reads top-down like "About the job": the
 * deliverable, who is on it and when, the facts, and more work with the same
 * freelancer. Open, the host's real message thread fills the pane (it already
 * shows the deliverable) with the freelancers, timeline and job facts in a
 * narrow column beside it (folded away when the pane is too narrow for both).
 */
export function JobDetail({
	now,
	onClose,
	onOpen,
	onOpenFullView,
	onPreview,
	onViewFreelancer,
	related,
	row,
	threadView,
}: JobDetailProps) {
	const enter = useEnter();
	const open = threadView !== null;
	const { freelancer } = row;
	return (
		<section
			aria-label={`Job: ${row.title}`}
			className="@container/jobs-detail flex min-h-0 min-w-0 flex-1 flex-col bg-background"
			data-testid="jobs-detail"
		>
			<motion.header
				{...enter}
				className="flex shrink-0 flex-col gap-3 px-6 pt-5 pb-4"
				key={`header-${row.thread.id}`}
			>
				<div className="flex min-h-8 items-center justify-between gap-3">
					<CompanyLine row={row} />
					<div className="flex shrink-0 items-center gap-1">
						{open ? (
							<>
								<Button
									onClick={onOpenFullView}
									size="sm"
									type="button"
									variant="outline"
								>
									<Maximize2 aria-hidden="true" data-icon="inline-start" />
									Open full view
								</Button>
								<Tooltip>
									<TooltipTrigger
										render={
											<Button
												aria-label="Close job"
												className="-mr-2"
												onClick={onClose}
												size="icon-sm"
												type="button"
												variant="ghost-muted"
											/>
										}
									>
										<X aria-hidden="true" />
									</TooltipTrigger>
									<TooltipContent side="bottom">Close</TooltipContent>
								</Tooltip>
							</>
						) : (
							<Button
								data-testid="jobs-open"
								onClick={() => onOpen(row.thread.id)}
								size="sm"
								type="button"
								variant="outline"
							>
								Open job
							</Button>
						)}
					</div>
				</div>
				<div className="flex flex-col gap-2">
					<h2 className="text-balance font-sans font-semibold! text-foreground text-xl leading-7 tracking-tight">
						{row.title}
					</h2>
					<JobMeta now={now} row={row} />
				</div>
				<p
					className="text-foreground/80 text-sm leading-5"
					data-testid="jobs-status-detail"
				>
					{jobStatusDetail(row)}
				</p>
			</motion.header>

			{open ? (
				<div className="flex min-h-0 flex-1 border-border border-t">
					<section
						aria-label="Job messages"
						className="flex min-h-0 min-w-0 flex-1 flex-col"
						data-testid="jobs-thread-view"
					>
						{threadView}
					</section>
					<aside
						aria-label="Job details"
						className="@[46rem]/jobs-detail:flex hidden w-68 shrink-0 flex-col gap-6 overflow-y-auto border-border border-l px-5 py-5"
						data-testid="jobs-detail-meta"
					>
						<section className="flex flex-col gap-2">
							<PaneHeading>
								{row.agents.length > 1 ? "Freelancers" : "Freelancer"}
							</PaneHeading>
							<JobFreelancers onView={onViewFreelancer} row={row} />
						</section>
						<section className="flex flex-col gap-3">
							<PaneHeading>Timeline</PaneHeading>
							<JobTimeline now={now} row={row} />
						</section>
						<section className="flex flex-col gap-3">
							<PaneHeading>About the job</PaneHeading>
							<JobFacts compact now={now} row={row} />
						</section>
					</aside>
				</div>
			) : (
				<motion.div
					{...enter}
					className="min-h-0 flex-1 overflow-y-auto border-border border-t"
					key={`body-${row.thread.id}`}
				>
					<div className="flex max-w-3xl flex-col gap-8 px-6 py-6">
						<section
							aria-labelledby="jobs-preview-deliverable-label"
							className="flex flex-col gap-2"
						>
							<PaneHeading id="jobs-preview-deliverable-label">
								{deliverableHeading(row)}
							</PaneHeading>
							<JobDeliverable row={row} />
						</section>

						<div className="grid @xl/jobs-detail:grid-cols-2 grid-cols-1 gap-8">
							<section
								aria-labelledby="jobs-preview-freelancer-label"
								className="flex flex-col gap-2"
							>
								<PaneHeading id="jobs-preview-freelancer-label">
									{row.agents.length > 1 ? "Freelancers" : "Freelancer"}
								</PaneHeading>
								<JobFreelancers onView={onViewFreelancer} row={row} />
							</section>
							<section
								aria-labelledby="jobs-preview-timeline-label"
								className="flex flex-col gap-3"
							>
								<PaneHeading id="jobs-preview-timeline-label">
									Timeline
								</PaneHeading>
								<JobTimeline now={now} row={row} />
							</section>
						</div>

						<section
							aria-labelledby="jobs-preview-facts-label"
							className="flex flex-col gap-3 border-border border-t pt-6"
						>
							<PaneHeading id="jobs-preview-facts-label">
								About the job
							</PaneHeading>
							<JobFacts now={now} row={row} />
						</section>

						{freelancer && related.length > 0 ? (
							<section
								aria-labelledby="jobs-preview-related-label"
								className="flex flex-col gap-2 border-border border-t pt-6"
							>
								<PaneHeading id="jobs-preview-related-label">
									{`More jobs with ${freelancer.name}`}
								</PaneHeading>
								<RelatedJobs now={now} onPreview={onPreview} rows={related} />
							</section>
						) : null}
					</div>
				</motion.div>
			)}
		</section>
	);
}

export interface JobFullViewProps {
	now: number;
	onBack: () => void;
	onClose: () => void;
	onViewFreelancer: (agentId: string) => void;
	/** Null while the host opens a job the snapshot does not list yet. */
	row: JobRow | null;
	showSidebar: boolean;
	threadView: ReactNode;
}

/**
 * "Open full view": the job's message thread across the whole surface, with
 * the contract details in a sidebar, like a freelance marketplace's job room.
 */
export function JobFullView({
	now,
	onBack,
	onClose,
	onViewFreelancer,
	row,
	showSidebar,
	threadView,
}: JobFullViewProps) {
	return (
		<section
			aria-label={row ? `Job: ${row.title}` : "New job"}
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
			data-testid="jobs-full-view"
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b pr-3 pl-2">
				<Button onClick={onBack} size="sm" type="button" variant="ghost">
					<ArrowLeft aria-hidden="true" data-icon="inline-start" />
					Jobs
				</Button>
				<span aria-hidden="true" className="h-5 w-px bg-border" />
				{row ? (
					<div className="flex min-w-0 flex-1 items-center gap-2.5">
						<CompanyLogo company={row.company} size={20} />
						<h2 className="truncate font-sans font-semibold! text-foreground text-sm">
							{row.title}
						</h2>
						<JobStatusPill status={row.status} />
					</div>
				) : (
					<h2 className="flex-1 font-sans font-semibold! text-foreground text-sm">
						New job
					</h2>
				)}
				<Button
					aria-label="Close job"
					onClick={onClose}
					size="icon-sm"
					type="button"
					variant="ghost-muted"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="flex min-h-0 flex-1">
				<section
					aria-label="Job messages"
					className="flex min-h-0 min-w-0 flex-1 flex-col"
					data-testid="jobs-thread-view"
				>
					{threadView}
				</section>
				{row && showSidebar ? (
					<aside
						aria-label="Job details"
						className="flex w-80 shrink-0 flex-col gap-6 overflow-y-auto border-border border-l px-5 py-5"
					>
						<section className="flex flex-col gap-2">
							<PaneHeading>Status</PaneHeading>
							<div>
								<JobStatusPill status={row.status} />
							</div>
							<p className="text-foreground/80 text-sm leading-5">
								{jobStatusDetail(row)}
							</p>
						</section>
						<section className="flex flex-col gap-2">
							<PaneHeading>
								{row.agents.length > 1 ? "Freelancers" : "Freelancer"}
							</PaneHeading>
							<JobFreelancers onView={onViewFreelancer} row={row} />
						</section>
						<section className="flex flex-col gap-3">
							<PaneHeading>Timeline</PaneHeading>
							<JobTimeline now={now} row={row} />
						</section>
						<section className="flex flex-col gap-3">
							<PaneHeading>About the job</PaneHeading>
							<JobFacts compact now={now} row={row} />
						</section>
					</aside>
				) : null}
			</div>
		</section>
	);
}

/** The right pane before anything is selected (or when no job exists). */
export function JobDetailEmpty({ children }: { children: ReactNode }) {
	return (
		<div
			className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center"
			data-testid="jobs-detail-empty"
		>
			{children}
		</div>
	);
}
