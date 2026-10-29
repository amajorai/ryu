import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceEvent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import type { Ref } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	HubCardEmpty,
	HubCardFrame,
	HubOpenPill,
	HubThreadRow,
	useHubRows,
} from "./hub-card.tsx";
import {
	HUB_CARD_LABELS,
	HUB_CARD_ROWS,
	hubAgentNames,
	hubAgo,
	hubNameList,
	hubNextRunHeadline,
	hubRunWhen,
	hubThreadAgents,
	hubThreadTitle,
} from "./hub-model.ts";
import { HubAvatar, HubWorkflowDisc } from "./hub-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface HubThreadCardProps {
	cardRef?: Ref<HTMLElement>;
	index: number;
	now: number;
	onOpenThread: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	threads: InterfaceThread[];
}

/** Live rows carry a bar and a message, so the card shows fewer of them. */
const WORKING_ROWS = 2;

/**
 * Joins meta segments that sit in separate flex items: the leading space is
 * non-breaking so flex layout does not strip it.
 */
const SEPARATOR = "\u00a0· ";

/** One meta line, joined the way the reference separates facts. */
function metaLine(...parts: string[]): string {
	return parts.filter(Boolean).join(" · ");
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function HubWaitingCard({
	cardRef,
	index,
	now,
	onOpenThread,
	snapshot,
	threads,
}: HubThreadCardProps) {
	const tl = useLiteralMessages();
	const { footer, shown } = useHubRows(threads, HUB_CARD_ROWS);
	return (
		<HubCardFrame
			cardRef={cardRef}
			footer={footer}
			headline={
				threads.length > 0
					? plural(threads.length, "conversation", "conversations")
					: "You're all caught up"
			}
			id="waiting"
			index={index}
			label={HUB_CARD_LABELS.waiting}
		>
			{shown.length === 0 ? (
				<HubCardEmpty detail="Replies from your agents land here." />
			) : (
				<ul className="flex flex-col">
					{shown.map((thread) => {
						const agents = hubThreadAgents(snapshot, thread);
						const title = hubThreadTitle(thread);
						return (
							<HubThreadRow
								agents={agents}
								key={thread.id}
								label={tl("Open {title}", { title })}
								meta={
									<span className="truncate">
										{metaLine(
											hubAgentNames(agents),
											hubAgo(thread.updatedAt, now)
										)}
									</span>
								}
								onOpen={() => onOpenThread(thread.id)}
								title={title}
								trailing={<HubOpenPill />}
							>
								{thread.lastMessage ? (
									// The preview needs room: short screens keep the rows.
									<span className="mt-1.5 hidden text-foreground text-sm leading-5 [@container_hub-cards_(min-height:46rem)]:line-clamp-1">
										{thread.lastMessage}
									</span>
								) : null}
							</HubThreadRow>
						);
					})}
				</ul>
			)}
		</HubCardFrame>
	);
}

function workingHeadline(agents: InterfaceAgent[]): string {
	if (agents.length === 0) {
		return "Nothing running";
	}
	return `${hubNameList(agents)} ${agents.length === 1 ? "is" : "are"} working`;
}

export function HubWorkingCard({
	cardRef,
	index,
	now,
	onOpenThread,
	snapshot,
	threads,
}: HubThreadCardProps) {
	const tl = useLiteralMessages();
	const { footer, shown } = useHubRows(threads, WORKING_ROWS);
	const working: InterfaceAgent[] = [];
	for (const thread of threads) {
		for (const agent of hubThreadAgents(snapshot, thread)) {
			if (!working.includes(agent)) {
				working.push(agent);
			}
		}
	}
	return (
		<HubCardFrame
			cardRef={cardRef}
			footer={footer}
			headline={workingHeadline(working)}
			id="working"
			index={index}
			label={HUB_CARD_LABELS.working}
		>
			{shown.length === 0 ? (
				<HubCardEmpty detail="Live runs show their progress here." />
			) : (
				<ul className="flex flex-col">
					{shown.map((thread) => {
						const agents = hubThreadAgents(snapshot, thread);
						const title = hubThreadTitle(thread);
						return (
							<HubThreadRow
								agents={agents}
								key={thread.id}
								label={tl("Open {title}, running", { title })}
								meta={
									<>
										<BoardStatusDot status="working" />
										<span className="truncate">
											{metaLine(
												hubAgentNames(agents),
												`Updated ${hubAgo(thread.updatedAt, now)}`
											)}
										</span>
									</>
								}
								onOpen={() => onOpenThread(thread.id)}
								title={title}
							>
								<HubLiveTrack />
								{thread.lastMessage ? (
									<span className="mt-3 line-clamp-1 text-foreground text-sm leading-5 [@container_hub-cards_(min-height:46rem)]:line-clamp-2">
										{thread.lastMessage}
									</span>
								) : null}
							</HubThreadRow>
						);
					})}
				</ul>
			)}
		</HubCardFrame>
	);
}

/**
 * A run in progress: a thin track with a sweep moving through it, since runs
 * report no percentage. Under reduced motion the track holds still, filled
 * in the live tone, so it still reads as active.
 */
function HubLiveTrack() {
	const reduceMotion = useReducedMotion();
	return (
		<span
			aria-hidden="true"
			className="relative mt-3 block h-1 w-full overflow-hidden rounded-full bg-muted"
			data-testid="hub-live-track"
		>
			{reduceMotion ? (
				<span className="absolute inset-0 rounded-full bg-success/40" />
			) : (
				<motion.span
					animate={{ x: ["-100%", "300%"] }}
					className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-success"
					initial={{ x: "-100%" }}
					transition={{
						duration: 1.8,
						ease: [0.4, 0, 0.2, 1],
						repeat: Number.POSITIVE_INFINITY,
						repeatDelay: 0.2,
					}}
				/>
			)}
		</span>
	);
}

function attentionHeadline(threads: number, runs: number): string {
	const total = threads + runs;
	if (total === 0) {
		return "Everything finished";
	}
	return `${plural(total, "run", "runs")} did not finish`;
}

type AttentionItem =
	| { kind: "run"; run: InterfaceEvent }
	| { kind: "thread"; thread: InterfaceThread };

export function HubAttentionCard({
	cardRef,
	failedRuns,
	index,
	now,
	onAskAgent,
	onOpenThread,
	snapshot,
	threads,
}: HubThreadCardProps & {
	failedRuns: InterfaceEvent[];
	/** Takes the user to the composer, addressed to the run's agent. */
	onAskAgent: (run: InterfaceEvent) => void;
}) {
	const tl = useLiteralMessages();
	const items: AttentionItem[] = [
		...threads.map((thread) => ({ kind: "thread" as const, thread })),
		...failedRuns.map((run) => ({ kind: "run" as const, run })),
	];
	const { footer, shown } = useHubRows(items, HUB_CARD_ROWS);
	const shownThreads: InterfaceThread[] = [];
	const shownRuns: InterfaceEvent[] = [];
	for (const item of shown) {
		if (item.kind === "thread") {
			shownThreads.push(item.thread);
		} else {
			shownRuns.push(item.run);
		}
	}
	return (
		<HubCardFrame
			cardRef={cardRef}
			footer={footer}
			headline={attentionHeadline(threads.length, failedRuns.length)}
			id="attention"
			index={index}
			label={HUB_CARD_LABELS.attention}
		>
			{items.length === 0 ? (
				<HubCardEmpty detail="Failed and stopped runs show up here." />
			) : (
				<>
					{shownThreads.length > 0 ? (
						<ul className="flex flex-col">
							{shownThreads.map((thread) => {
								const agents = hubThreadAgents(snapshot, thread);
								const title = hubThreadTitle(thread);
								const outcome =
									thread.runState === "interrupted" ? "Stopped" : "Failed";
								return (
									<HubThreadRow
										agents={agents}
										key={thread.id}
										label={
											thread.runState === "interrupted"
												? tl("Open {title}, stopped", { title })
												: tl("Open {title}, failed", { title })
										}
										meta={
											<>
												<BoardStatusDot status="attention" />
												<span className="min-w-0 truncate">
													<span className="font-medium text-foreground">
														{outcome}
													</span>
													{` · ${metaLine(hubAgentNames(agents), hubAgo(thread.updatedAt, now))}`}
												</span>
											</>
										}
										onOpen={() => onOpenThread(thread.id)}
										title={title}
										trailing={<HubOpenPill />}
									/>
								);
							})}
						</ul>
					) : null}
					{shownRuns.length > 0 ? (
						<section
							aria-label="Scheduled runs"
							className={cn(
								shownThreads.length > 0 && "mt-2 border-border border-t pt-4"
							)}
						>
							<h3 className="font-medium text-muted-foreground text-sm leading-5">
								Scheduled runs
							</h3>
							<ul className="flex flex-col">
								{shownRuns.map((run) => (
									<FailedRunRow
										key={run.id}
										now={now}
										onAsk={() => onAskAgent(run)}
										run={run}
										snapshot={snapshot}
									/>
								))}
							</ul>
						</section>
					) : null}
				</>
			)}
		</HubCardFrame>
	);
}

/**
 * A failed scheduled run has no thread to open, so its action is to ask the
 * agent behind it: the row takes the user to the composer, addressed to that
 * agent. Nothing is sent until the user writes and submits.
 */
function FailedRunRow({
	now,
	onAsk,
	run,
	snapshot,
}: {
	now: number;
	onAsk: () => void;
	run: InterfaceEvent;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const agent = snapshot.agents.find(
		(candidate) => candidate.id === run.agentId
	);
	return (
		<HubThreadRow
			agents={agent ? [agent] : []}
			label={
				agent
					? tl("Ask {name} about {title}, failed", {
							name: agent.name,
							title: run.title,
						})
					: tl("Ask an agent about {title}, failed", { title: run.title })
			}
			meta={
				<>
					<BoardStatusDot status="attention" />
					<span className="min-w-0 truncate">
						<span className="font-medium text-foreground">Failed</span>
						{` · ${metaLine(agent?.name ?? "Workflow", hubAgo(run.start, now))}`}
					</span>
				</>
			}
			onOpen={onAsk}
			title={run.title}
			trailing={<HubOpenPill label="Ask" />}
		/>
	);
}

export function HubUpcomingCard({
	cardRef,
	events,
	index,
	now,
	snapshot,
}: {
	cardRef?: Ref<HTMLElement>;
	events: InterfaceEvent[];
	index: number;
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const { footer, shown } = useHubRows(events, HUB_CARD_ROWS);
	const next = events[0];
	return (
		<HubCardFrame
			cardRef={cardRef}
			footer={footer}
			headline={
				next
					? hubNextRunHeadline(hubRunWhen(next.start, now))
					: "Nothing scheduled"
			}
			id="upcoming"
			index={index}
			label={HUB_CARD_LABELS.upcoming}
		>
			{shown.length === 0 ? (
				<HubCardEmpty detail="Routines you schedule appear here before they run." />
			) : (
				<ol className="flex flex-col">
					{shown.map((event) => {
						const agent = snapshot.agents.find(
							(candidate) => candidate.id === event.agentId
						);
						const count =
							event.count && event.count > 1 ? `${event.count} today` : "";
						return (
							<li className="flex items-start gap-4 py-3" key={event.id}>
								{agent ? <HubAvatar agent={agent} /> : <HubWorkflowDisc />}
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="truncate font-medium text-[17px] text-foreground leading-6">
										{event.title}
									</span>
									<span className="flex min-w-0 whitespace-nowrap text-muted-foreground text-sm leading-5">
										<span className="shrink-0 font-medium text-foreground tabular-nums">
											{hubRunWhen(event.start, now)}
										</span>
										<span className="min-w-0 truncate">
											{`${SEPARATOR}${agent?.name ?? "Workflow"}`}
										</span>
										{/* Cadence and count drop out whole on a narrow card. */}
										{event.label ? (
											<span className="@[21rem]/hub-card:inline hidden shrink-0">
												{`${SEPARATOR}${event.label}`}
											</span>
										) : null}
										{count ? (
											<span className="@[24rem]/hub-card:inline hidden shrink-0">
												{`${SEPARATOR}${count}`}
											</span>
										) : null}
									</span>
								</span>
							</li>
						);
					})}
				</ol>
			)}
		</HubCardFrame>
	);
}
