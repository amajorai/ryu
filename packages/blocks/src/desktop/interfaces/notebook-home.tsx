import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { CalendarClock, Clock3, Inbox, Plus } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { agentById, compactAge } from "./interface-renderer.ts";
import {
	CARD_HEIGHT,
	Gallery,
	NewPageCard,
	PageCard,
	SLOT,
} from "./notebook-home-cards.tsx";
import {
	HOME_LIST_LIMIT,
	LIST_ROW_PAD,
	ListCard,
	needsYouLimit,
	RunTime,
	SectionHeading,
} from "./notebook-home-lists.tsx";
import {
	notebookGreeting,
	notebookNeedsYou,
	notebookPageTitle,
	recentNotebookPages,
	upcomingNotebookEvents,
} from "./notebook-model.ts";
import { notebookColumn } from "./notebook-page.tsx";
import { NotebookStatusMark } from "./notebook-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Notion's Home: a greeting, the latest pages as a card gallery, then what
 * needs the reader and the scheduled runs ahead.
 */
export function NotebookHome({
	fullWidth,
	loading,
	now,
	onNewPage,
	onOpen,
	snapshot,
}: {
	/** The top bar's Full width toggle: drop the column cap. */
	fullWidth: boolean;
	loading: boolean;
	now: number;
	onNewPage: () => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const reduceMotion = useReducedMotion();
	const tl = useLiteralMessages();
	const recent = recentNotebookPages(snapshot);
	const needsYouAll = notebookNeedsYou(snapshot, Number.POSITIVE_INFINITY);
	const [showAllNeedsYou, setShowAllNeedsYou] = useState(false);
	const upcoming = upcomingNotebookEvents(snapshot, now, HOME_LIST_LIMIT);
	const limit = needsYouLimit(upcoming.length);
	const needsYouHidden = Math.max(0, needsYouAll.length - limit);
	const needsYou = showAllNeedsYou ? needsYouAll : needsYouAll.slice(0, limit);
	const empty =
		!loading && snapshot.threads.length === 0 && snapshot.agents.length === 0;

	let body: ReactNode;
	if (loading) {
		body = (
			<div aria-hidden="true" className="flex flex-col gap-10">
				<div className="flex gap-3 overflow-hidden">
					{["a", "b", "c", "d", "e"].map((key) => (
						<Skeleton
							className={cn(SLOT, CARD_HEIGHT, "rounded-lg")}
							key={key}
						/>
					))}
				</div>
				<div className="grid @3xl/notebook:grid-cols-2 gap-6">
					<Skeleton className="h-56 rounded-lg" />
					<Skeleton className="h-56 rounded-lg" />
				</div>
			</div>
		);
	} else if (empty) {
		body = (
			<section
				aria-labelledby="notebook-empty"
				className="flex flex-col items-center gap-1 text-center"
			>
				<h2 className="font-medium text-sm" id="notebook-empty">
					Your notebook is empty
				</h2>
				<p className="text-pretty text-muted-foreground text-sm">
					Every conversation with an agent becomes a page here.
				</p>
				<Button
					className="mt-4"
					onClick={onNewPage}
					size="sm"
					variant="outline"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					New page
				</Button>
			</section>
		);
	} else {
		body = (
			<div className="flex flex-col gap-10">
				<section aria-labelledby="notebook-recent">
					<SectionHeading icon={<Clock3 />} id="notebook-recent">
						Recently edited
					</SectionHeading>
					<Gallery labelledBy="notebook-recent">
						{recent.map((thread) => (
							<PageCard
								key={thread.id}
								now={now}
								onOpen={onOpen}
								snapshot={snapshot}
								thread={thread}
							/>
						))}
						<NewPageCard onNewPage={onNewPage} />
					</Gallery>
				</section>
				<div
					className={cn(
						"grid @3xl/notebook:grid-cols-2 gap-x-6 gap-y-10",
						// Matched lists share a bottom edge; an expanded one sizes alone.
						showAllNeedsYou && "items-start"
					)}
				>
					<section
						aria-labelledby="notebook-needs-you"
						className="flex flex-col"
					>
						<SectionHeading
							action={
								needsYouHidden > 0 ? (
									<button
										aria-expanded={showAllNeedsYou}
										className="-me-1.5 flex h-6 items-center rounded-md px-1.5 text-muted-foreground text-xs outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
										onClick={() => setShowAllNeedsYou((open) => !open)}
										type="button"
									>
										{showAllNeedsYou
											? "Show fewer"
											: tl("Show all {count}", {
													count: String(needsYouAll.length),
												})}
									</button>
								) : null
							}
							icon={<Inbox />}
							id="notebook-needs-you"
						>
							Needs you
						</SectionHeading>
						<ListCard
							empty="You're all caught up."
							labelledBy="notebook-needs-you"
						>
							{needsYou.map((thread) => {
								const status = threadStatus(thread);
								const lead = agentById(snapshot, thread.agentIds[0]);
								return (
									<li key={thread.id}>
										<button
											className={cn(
												LIST_ROW_PAD,
												"outline-none transition-colors duration-100 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50"
											)}
											onClick={() => onOpen(thread.id)}
											type="button"
										>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="truncate font-medium text-sm">
													{notebookPageTitle(thread)}
												</span>
												<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
													<NotebookStatusMark status={status} />
													<span
														className={cn(
															"truncate",
															(status === "attention" ||
																status === "your-turn") &&
																"text-foreground/80"
														)}
													>
														{THREAD_STATUS_LABELS[status]}
														{lead ? ` · ${lead.name}` : ""}
													</span>
												</span>
											</span>
											<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
												{compactAge(thread.updatedAt, now)}
											</span>
										</button>
									</li>
								);
							})}
						</ListCard>
					</section>
					<section
						aria-labelledby="notebook-upcoming"
						className="flex flex-col"
					>
						<SectionHeading icon={<CalendarClock />} id="notebook-upcoming">
							Upcoming runs
						</SectionHeading>
						<ListCard
							empty="No scheduled runs ahead."
							labelledBy="notebook-upcoming"
						>
							{upcoming.map((event) => {
								const agent = agentById(snapshot, event.agentId);
								return (
									<li
										className={cn(LIST_ROW_PAD, "cursor-default")}
										key={event.id}
									>
										<RunTime iso={event.start} now={now} />
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate font-medium text-sm">
												{event.title}
											</span>
											<span className="truncate text-muted-foreground text-xs">
												{[
													event.label,
													event.count && event.count > 1
														? `${event.count} runs`
														: null,
													agent?.name,
												]
													.filter(Boolean)
													.join(" · ") || "Scheduled run"}
											</span>
										</span>
									</li>
								);
							})}
						</ListCard>
					</section>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
			<motion.div
				animate={{ opacity: 1, y: 0 }}
				className={cn(
					notebookColumn(fullWidth),
					!fullWidth && "@6xl/notebook:max-w-[64rem] max-w-[58rem]",
					"@xl/notebook:pt-12 pt-8 pb-16"
				)}
				initial={reduceMotion ? false : { opacity: 0, y: 6 }}
				key="home"
				transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
			>
				<header className={cn("text-center", empty ? "mb-6" : "mb-8")}>
					<h1 className="font-semibold @xl/notebook:text-3xl text-2xl tracking-tight">
						{notebookGreeting(new Date(now))}
					</h1>
				</header>
				{body}
			</motion.div>
		</div>
	);
}
