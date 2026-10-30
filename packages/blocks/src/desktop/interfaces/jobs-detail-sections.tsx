import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import {
	JOB_STATUS_LABELS,
	type JobRow,
	jobAge,
	jobFullTime,
	jobTimeline,
} from "./jobs-model.ts";
import {
	availabilityLabel,
	CompanyLogo,
	FreelancerAvatar,
	FreelancerChip,
	JobStatusPill,
} from "./jobs-parts.tsx";

const COMPANY_KIND: Record<JobRow["company"]["kind"], string> = {
	personal: "Your own job",
	project: "Project",
	team: "Team",
};

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
	const tl = useLiteralMessages();
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
				{tl(
					"{author} wrote this · {count, plural, one {{countLabel} message} other {{countLabel} messages}} in the thread",
					{
						author,
						count: row.thread.messageCount,
						countLabel: String(row.thread.messageCount),
					}
				)}
			</figcaption>
		</figure>
	);
}

export function JobMeta({ now, row }: { now: number; row: JobRow }) {
	const tl = useLiteralMessages();
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
				{tl("Updated {age}", {
					age: jobAge(row.thread.updatedAt, now).toLowerCase(),
				})}
			</time>
		</div>
	);
}

export function CompanyLine({ row }: { row: JobRow }) {
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
export function FreelancerLink({
	agent,
	onView,
}: {
	agent: InterfaceAgent;
	onView: (agentId: string) => void;
}) {
	const tl = useLiteralMessages();
	const headline = agent.description || "Freelancer";
	return (
		<button
			aria-label={tl("View {name}'s profile", { name: agent.name })}
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
export function JobFreelancers({
	onView,
	row,
}: {
	onView: (agentId: string) => void;
	row: JobRow;
}) {
	const tl = useLiteralMessages();
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
					{tl("and {hidden} more", { hidden: String(hidden) })}
				</p>
			) : null}
		</div>
	);
}

/**
 * The one section heading style in the detail pane: semibold body-size text,
 * so the job title stays the only large element.
 */
export function PaneHeading({
	children,
	id,
}: {
	children: string;
	id?: string;
}) {
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
export function JobFacts({
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
export function RelatedJobs({
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
