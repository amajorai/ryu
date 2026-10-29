import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { InterfaceComposer } from "./interface-composer.tsx";
import {
	type FreelancerProfile,
	freelancerMeta,
	type JobRow,
	jobAge,
	pluralize,
} from "./jobs-model.ts";
import {
	availabilityLabel,
	CompanyLogo,
	FreelancerAvatar,
	JobStatusPill,
} from "./jobs-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export const freelancerRowDomId = (agentId: string) =>
	`jobs-freelancer-${agentId}`;

function FreelancerRow({
	cursor,
	onFocusRow,
	onKeyDownRow,
	onSelect,
	profile,
	registerRow,
	selected,
}: {
	cursor: boolean;
	onFocusRow: (agentId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, agentId: string) => void;
	onSelect: (agentId: string) => void;
	profile: FreelancerProfile;
	registerRow: (agentId: string, element: HTMLElement | null) => void;
	selected: boolean;
}) {
	const { agent } = profile;
	return (
		<div
			aria-selected={selected}
			className={cn(
				"group relative flex cursor-default items-start gap-3 border-border border-b px-4 py-3 outline-none transition-colors",
				"hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
				"data-[selected=true]:bg-accent/70 data-[selected=true]:focus-visible:bg-accent/70 data-[selected=true]:hover:bg-accent/70"
			)}
			data-selected={selected}
			data-testid="jobs-freelancer-row"
			id={freelancerRowDomId(agent.id)}
			onClick={() => onSelect(agent.id)}
			onFocus={() => onFocusRow(agent.id)}
			onKeyDown={(event) => onKeyDownRow(event, agent.id)}
			ref={(element) => registerRow(agent.id, element)}
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
			<FreelancerAvatar
				agent={agent}
				size={48}
				surface={selected ? "ring-accent" : "ring-background"}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<p className="truncate font-semibold text-[15px] text-foreground leading-5 group-hover:underline group-hover:underline-offset-2">
					{agent.name}
				</p>
				<p className="mt-0.5 line-clamp-2 text-foreground/80 text-sm leading-5">
					{agent.description || "Freelancer"}
				</p>
				<p className="mt-1 truncate text-muted-foreground text-xs leading-5">
					{freelancerMeta(profile)}
				</p>
			</div>
		</div>
	);
}

export interface FreelancerListProps {
	cursorId: string | null;
	heading: string;
	headingExtra?: ReactNode;
	onFocusRow: (agentId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, agentId: string) => void;
	onSelect: (agentId: string) => void;
	profiles: FreelancerProfile[];
	registerRow: (agentId: string, element: HTMLElement | null) => void;
	selectedId: string | null;
	total: number;
}

/** The middle pane on the Freelancers tab: talent rows with a Hire action. */
export function FreelancerList({
	cursorId,
	heading,
	headingExtra,
	onFocusRow,
	onKeyDownRow,
	onSelect,
	profiles,
	registerRow,
	selectedId,
	total,
}: FreelancerListProps) {
	const tl = useLiteralMessages();
	const working = profiles.filter(
		(profile) => profile.agent.status === "working"
	).length;
	return (
		<section
			aria-label="Freelancer list"
			className="flex min-h-0 w-full flex-col bg-background"
			data-testid="jobs-freelancers"
		>
			{headingExtra}
			<header className="flex shrink-0 flex-col gap-0.5 border-border border-b px-4 pt-4 pb-3">
				<h2 className="font-sans font-semibold! text-base text-foreground leading-6">
					{heading}
				</h2>
				<p
					aria-live="polite"
					className="text-muted-foreground text-xs leading-4"
				>
					{pluralize(profiles.length, "freelancer")}
					{working > 0
						? ` ${tl("· {working} working now", { working: String(working) })}`
						: ""}
				</p>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{profiles.length === 0 ? (
					<Empty className="h-full" inset="dense">
						<EmptyHeader>
							<EmptyTitle className="text-base">
								{total === 0 ? "No freelancers yet" : "No freelancers match"}
							</EmptyTitle>
							<EmptyDescription>
								{total === 0
									? "Create an agent to hire it for jobs."
									: "Try a different name or skill."}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div
						aria-label="Freelancers"
						className="flex flex-col"
						role="listbox"
					>
						{profiles.map((profile) => (
							<FreelancerRow
								cursor={profile.agent.id === cursorId}
								key={profile.agent.id}
								onFocusRow={onFocusRow}
								onKeyDownRow={onKeyDownRow}
								onSelect={onSelect}
								profile={profile}
								registerRow={registerRow}
								selected={profile.agent.id === selectedId}
							/>
						))}
					</div>
				)}
			</div>
		</section>
	);
}

function Stat({
	hint,
	label,
	value,
}: {
	hint?: string;
	label: string;
	/** Null renders as "New": no number to show yet. */
	value: string | null;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1 py-3">
			<dt className="text-muted-foreground text-xs leading-4">
				{hint ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									className="cursor-help rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
									type="button"
								/>
							}
						>
							{label}
						</TooltipTrigger>
						<TooltipContent className="max-w-60" side="top">
							{hint}
						</TooltipContent>
					</Tooltip>
				) : (
					label
				)}
			</dt>
			<dd className="font-semibold text-foreground text-xl tabular-nums leading-7 tracking-tight">
				{value ?? "New"}
			</dd>
		</div>
	);
}

export interface FreelancerProfilePaneProps {
	composerRef: RefObject<HTMLDivElement | null>;
	/** The Hire composer is showing (it stays folded behind "Hire" until asked). */
	hireOpen: boolean;
	jobs: JobRow[];
	now: number;
	onCancelHire: () => void;
	/** Opens the Hire composer and moves focus into it. */
	onFocusHire: () => void;
	onHire: (input: { agentId?: string; prompt: string }) => void;
	onOpenJob: (threadId: string) => void;
	profile: FreelancerProfile;
}

/**
 * The right pane on the Freelancers tab: an Upwork-style profile with honest
 * stats from job statuses, a "Hire" button that unfolds a composer posting a
 * new job to this freelancer (Upwork's invite flow), and their work history.
 */
export function FreelancerProfilePane({
	composerRef,
	hireOpen,
	jobs,
	now,
	onCancelHire,
	onFocusHire,
	onHire,
	onOpenJob,
	profile,
}: FreelancerProfilePaneProps) {
	const tl = useLiteralMessages();
	const { agent } = profile;
	const reduced = useReducedMotion();
	const enter = reduced
		? {}
		: {
				animate: { opacity: 1, y: 0 },
				initial: { opacity: 0, y: 4 },
				transition: { duration: 0.16, ease: [0.2, 0, 0, 1] as const },
			};
	return (
		<section
			aria-label={tl("{name}'s profile", { name: agent.name })}
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background"
			data-testid="jobs-profile"
		>
			<motion.div
				{...enter}
				className="flex w-full max-w-3xl flex-col gap-6 px-6 py-6"
				key={agent.id}
			>
				<header className="flex items-center gap-4">
					<FreelancerAvatar agent={agent} size={64} />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<h2 className="truncate font-sans font-semibold! text-foreground text-xl leading-7 tracking-tight">
							{agent.name}
						</h2>
						<p className="text-foreground/80 text-sm leading-5">
							{agent.description || "Freelancer"}
						</p>
						<p
							className={cn(
								"text-xs leading-4",
								agent.status === "working"
									? "font-medium text-success"
									: "text-muted-foreground"
							)}
						>
							{availabilityLabel(agent)}
						</p>
					</div>
					{hireOpen ? null : (
						<Button
							aria-label={tl("Hire {name}", { name: agent.name })}
							className="h-8 shrink-0 rounded-full px-3"
							data-testid="jobs-hire"
							onClick={onFocusHire}
							size="sm"
							type="button"
						>
							Hire
						</Button>
					)}
				</header>

				<dl className="grid grid-cols-2 gap-x-4 border-border border-y sm:grid-cols-4">
					<Stat
						hint="Delivered jobs (in review or closed) out of every job that was delivered or went on hold. Reads New until two jobs have settled."
						label="Job success"
						value={
							profile.successRate === null ? null : `${profile.successRate}%`
						}
					/>
					<Stat
						hint="Jobs you closed. Delivered work counts once you close it."
						label="Jobs completed"
						value={String(profile.completed)}
					/>
					<Stat label="In review" value={String(profile.inReview)} />
					<Stat label="Active" value={String(profile.active)} />
				</dl>

				{hireOpen ? (
					<section
						aria-labelledby="jobs-hire-label"
						className="flex flex-col gap-3"
						ref={composerRef}
					>
						<div className="flex items-start justify-between gap-4">
							<div className="flex flex-col gap-0.5">
								<h3
									className="font-sans font-semibold! text-foreground text-sm leading-5"
									id="jobs-hire-label"
								>
									{tl("Hire {name}", { name: agent.name })}
								</h3>
								<p className="text-muted-foreground text-sm leading-5">
									{tl(
										"Describe the job. It is posted to {name} and work starts when you post it.",
										{ name: agent.name }
									)}
								</p>
							</div>
							<Button
								className="-mt-1.5 -mr-2 shrink-0"
								onClick={onCancelHire}
								size="sm"
								type="button"
								variant="ghost-muted"
							>
								Cancel
							</Button>
						</div>
						<InterfaceComposer
							defaultAgentId={agent.id}
							label={tl("Job description for {name}", { name: agent.name })}
							onSubmit={onHire}
							placeholder={tl("What do you need {name} to do?", {
								name: agent.name,
							})}
							submitLabel="Post job"
						/>
					</section>
				) : null}

				<section
					aria-labelledby="jobs-history-label"
					className="flex flex-col gap-1"
				>
					<h3
						className="flex items-baseline gap-2 pb-1 font-sans font-semibold! text-foreground text-sm leading-5"
						id="jobs-history-label"
					>
						Work history
						<span className="font-normal text-muted-foreground text-xs">
							{pluralize(jobs.length, "job")}
						</span>
					</h3>
					{jobs.length === 0 ? (
						<p className="text-muted-foreground text-sm leading-5">
							{tl("No jobs with {name} yet.", { name: agent.name })}
						</p>
					) : (
						<ul className="-mx-2 flex flex-col">
							{jobs.map((row) => (
								<li key={row.thread.id}>
									<button
										className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
										onClick={() => onOpenJob(row.thread.id)}
										type="button"
									>
										<CompanyLogo company={row.company} size={32} />
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate font-medium text-foreground text-sm leading-5">
												{row.title}
											</span>
											<span className="truncate text-muted-foreground text-xs leading-4">
												{row.company.name} · {jobAge(row.thread.updatedAt, now)}
											</span>
										</span>
										<JobStatusPill status={row.status} />
									</button>
								</li>
							))}
						</ul>
					)}
				</section>
			</motion.div>
		</section>
	);
}
