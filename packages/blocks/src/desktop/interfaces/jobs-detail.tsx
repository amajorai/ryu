import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { ArrowLeft, Maximize2, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import {
	CompanyLine,
	deliverableHeading,
	JobDeliverable,
	JobFacts,
	JobFreelancers,
	JobMeta,
	JobTimeline,
	PaneHeading,
	RelatedJobs,
} from "./jobs-detail-sections.tsx";
import { type JobRow, jobStatusDetail } from "./jobs-model.ts";
import { CompanyLogo, JobStatusPill } from "./jobs-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export {
	deliverableHeading,
	JobDeliverable,
	JobTimeline,
} from "./jobs-detail-sections.tsx";

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
	const tl = useLiteralMessages();
	const enter = useEnter();
	const open = threadView !== null;
	const { freelancer } = row;
	return (
		<section
			aria-label={tl("Job: {title}", { title: row.title })}
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
									{tl("More jobs with {name}", { name: freelancer.name })}
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
	const tl = useLiteralMessages();
	return (
		<section
			aria-label={row ? tl("Job: {title}", { title: row.title }) : "New job"}
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
