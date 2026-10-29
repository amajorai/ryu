import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	CalendarClock,
	ChevronLeft,
	ChevronRight,
	Clock3,
	Inbox,
	Plus,
} from "lucide-react";
import { motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { agentById, compactAge } from "./interface-renderer.ts";
import {
	notebookEditedLabel,
	notebookGreeting,
	notebookNeedsYou,
	notebookPageTitle,
	notebookRunTime,
	recentNotebookPages,
	upcomingNotebookEvents,
} from "./notebook-model.ts";
import { notebookColumn } from "./notebook-page.tsx";
import { NotebookPageGlyph, NotebookStatusMark } from "./notebook-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

function SectionHeading({
	action,
	children,
	icon,
	id,
}: {
	/** A quiet text action at the right end, e.g. "Show all". */
	action?: ReactNode;
	children: string;
	icon: ReactNode;
	id: string;
}) {
	return (
		<div className="mb-2 flex h-6 items-center gap-2">
			<h2
				className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-muted-foreground text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
				id={id}
			>
				{icon}
				{children}
			</h2>
			{action}
		</div>
	);
}

/**
 * Gallery slots: a whole number of cards fills the column at every width, so
 * the row ends on a card edge and the fade reads as "more", never a crop.
 */
const SLOT =
	"shrink-0 snap-start basis-[calc((100%-0.75rem)/2)] @lg/notebook:basis-[calc((100%-1.5rem)/3)] @3xl/notebook:basis-[calc((100%-2.25rem)/4)] @5xl/notebook:basis-[calc((100%-3rem)/5)]";

const CARD_HEIGHT = "h-36";

const CARD = cn(
	"group/card relative flex w-full flex-col overflow-hidden rounded-lg bg-card text-left outline-none ring-1 ring-border/70 transition-colors duration-100 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60 active:bg-muted/60 dark:ring-border/50",
	CARD_HEIGHT
);

/** A Notion "Recently visited" card: cover, page icon, title, edited time. */
function PageCard({
	now,
	onOpen,
	snapshot,
	thread,
}: {
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const lead = agentById(snapshot, thread.agentIds[0]);
	const status = threadStatus(thread);
	const title = notebookPageTitle(thread);
	return (
		<li className={SLOT}>
			<button
				aria-label={`${title}, ${THREAD_STATUS_LABELS[status]}, edited ${notebookEditedLabel(thread.updatedAt, now).toLowerCase()}`}
				className={CARD}
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				{/* Notion's card for a page without a cover: a flat neutral cover. */}
				<span aria-hidden="true" className="block h-11 shrink-0 bg-muted" />
				<span className="-mt-4 flex px-4">
					<span className="flex size-8 items-center justify-center rounded-md bg-card">
						<NotebookPageGlyph className="size-5" />
					</span>
				</span>
				<span className="line-clamp-2 px-4 pt-2 font-medium text-sm leading-5">
					{title}
				</span>
				<span className="mt-auto flex items-center gap-1.5 px-4 pb-3 text-muted-foreground text-xs">
					<NotebookStatusMark status={status} />
					<span className="truncate">
						{lead ? `${lead.name} · ` : ""}
						{compactAge(thread.updatedAt, now)}
					</span>
				</span>
			</button>
		</li>
	);
}

function NewPageCard({ onNewPage }: { onNewPage: () => void }) {
	return (
		<li className={SLOT}>
			<button
				className={cn(
					CARD,
					"items-center justify-center gap-2 bg-transparent text-muted-foreground hover:text-foreground"
				)}
				onClick={onNewPage}
				type="button"
			>
				<Plus aria-hidden="true" className="size-4" />
				<span className="font-medium text-sm">New page</span>
			</button>
		</li>
	);
}

/** The most rows either Home list shows before "Show all". */
const HOME_LIST_LIMIT = 5;

/**
 * Needs you shows as many rows as Upcoming runs (3 to 5), so the two cards
 * share a bottom edge with no blank rows; with no runs ahead it shows five.
 */
function needsYouLimit(upcomingCount: number): number {
	if (upcomingCount === 0) {
		return HOME_LIST_LIMIT;
	}
	return Math.min(HOME_LIST_LIMIT, Math.max(3, upcomingCount));
}

/** One height for every Home list row, so both cards rule up line by line. */
const LIST_ROW = "h-13";

function RunTime({ iso, now }: { iso: string; now: number }) {
	const { day, time } = notebookRunTime(iso, now);
	return (
		<time
			className="flex w-24 shrink-0 flex-col text-xs leading-4"
			dateTime={iso}
		>
			<span className="truncate font-medium text-foreground">{day}</span>
			<span className="truncate text-muted-foreground tabular-nums">
				{time ?? "\u00a0"}
			</span>
		</time>
	);
}

/**
 * Notion's horizontally scrolling card row: edges fade where more cards hide,
 * and arrow buttons page through it on hover.
 */
function Gallery({
	children,
	labelledBy,
}: {
	children: ReactNode;
	labelledBy: string;
}) {
	const listRef = useRef<HTMLUListElement>(null);
	const [edges, setEdges] = useState({ end: false, start: false });
	const measure = useCallback(() => {
		const list = listRef.current;
		if (!list) {
			return;
		}
		const start = list.scrollLeft > 6;
		const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 6;
		setEdges((previous) =>
			previous.start === start && previous.end === end
				? previous
				: { end, start }
		);
	}, []);
	useEffect(() => {
		const list = listRef.current;
		measure();
		if (!list || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => observer.disconnect();
	}, [measure]);
	const page = (direction: 1 | -1) => {
		const list = listRef.current;
		list?.scrollBy({
			behavior: "smooth",
			left: direction * list.clientWidth * 0.8,
		});
	};
	// Whole cards fill the column and the row ends flush on a card edge; the
	// arrow on that edge, faint until hover, says there is more. The list
	// bleeds 4px only so focus rings are not clipped.
	const arrow =
		"absolute top-1/2 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-background text-foreground opacity-70 shadow-xs ring-1 ring-border outline-none transition-opacity duration-100 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/gallery:opacity-100";
	return (
		<div className="group/gallery relative">
			<ul
				aria-labelledby={labelledBy}
				className="-m-1 flex snap-x scroll-px-1 gap-3 overflow-x-auto p-1 [scrollbar-width:none]"
				onScroll={measure}
				ref={listRef}
			>
				{children}
			</ul>
			{edges.start ? (
				<button
					aria-label="Scroll recent pages back"
					className={cn(arrow, "-left-2")}
					onClick={() => page(-1)}
					type="button"
				>
					<ChevronLeft aria-hidden="true" className="size-4" />
				</button>
			) : null}
			{edges.end ? (
				<button
					aria-label="Scroll recent pages forward"
					className={cn(arrow, "-right-2")}
					onClick={() => page(1)}
					type="button"
				>
					<ChevronRight aria-hidden="true" className="size-4" />
				</button>
			) : null}
		</div>
	);
}

/**
 * One row treatment for both Home lists: a padded row that highlights on
 * hover when it opens a page, and stays still when it is information only.
 */
const LIST_ROW_PAD = cn(
	"flex w-full items-center gap-3 rounded-md px-2 text-left",
	LIST_ROW
);

function ListCard({
	children,
	empty,
	labelledBy,
}: {
	children: ReactNode[];
	empty: string;
	labelledBy: string;
}) {
	return (
		<div className="flex-1 overflow-hidden rounded-lg bg-card p-1 ring-1 ring-border/70 dark:ring-border/50">
			{children.length > 0 ? (
				<ul aria-labelledby={labelledBy} className="flex flex-col gap-px">
					{children}
				</ul>
			) : (
				<p className="px-3 py-4 text-muted-foreground text-sm">{empty}</p>
			)}
		</div>
	);
}

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
											: `Show all ${needsYouAll.length}`}
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
