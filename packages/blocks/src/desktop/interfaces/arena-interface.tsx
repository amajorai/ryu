import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { LayoutGrid, Plus } from "lucide-react";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	ARENA_NAV_ATTRIBUTE,
	ArenaAgentCard,
	ArenaCardSkeletons,
} from "./arena-card.tsx";
import {
	ARENA_FILTER_LABELS,
	ARENA_FILTERS,
	type ArenaFilter,
	arenaAgentTally,
	arenaNextUp,
	buildArenaCards,
	isArenaFilter,
	matchesArenaFilter,
	matchesUnassignedFilter,
	unassignedThreads,
} from "./arena-model.ts";
import { ArenaThreadPanel } from "./arena-panel.tsx";
import { ArenaSchedule } from "./arena-schedule.tsx";
import { ArenaStatStrip } from "./arena-stats.tsx";
import { ArenaUnassigned } from "./arena-unassigned.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";

const NAV_HINT_ID = "arena-nav-hint";
/** How long a requested focus move may wait for the host to open or close. */
const FOCUS_REQUEST_TTL_MS = 2000;

const FILTER_EMPTY: Record<
	ArenaFilter,
	{ description: string; title: string }
> = {
	all: { description: "Agents you create show up here.", title: "No agents." },
	idle: {
		description: "Every agent is working or waiting on you.",
		title: "No idle agents.",
	},
	"needs-you": {
		description: "No failed runs or replies are waiting on you.",
		title: "No agents need you.",
	},
	working: {
		description: "No agent has a run in progress.",
		title: "Nothing running.",
	},
};

const CARD_SELECTOR = "article[data-agent-id]";
const SCROLLER_ATTRIBUTE = "data-arena-scroller";
const STICKY_ATTRIBUTE = "data-arena-sticky";
/** Breathing room kept around a revealed card (its selection ring sits outside it). */
const REVEAL_GAP_PX = 12;

/**
 * Scroll the wall just enough to show a card below the sticky filter row.
 * `scrollIntoView` ignores the sticky row, which would hide the card's top.
 */
function revealCard(card: Element, scroller: HTMLElement) {
	const sticky = scroller.querySelector<HTMLElement>(`[${STICKY_ATTRIBUTE}]`);
	const view = scroller.getBoundingClientRect();
	const rect = card.getBoundingClientRect();
	const top = view.top + (sticky?.offsetHeight ?? 0) + REVEAL_GAP_PX;
	const bottom = view.bottom - REVEAL_GAP_PX;
	if (rect.top < top) {
		scroller.scrollBy({ top: rect.top - top });
	} else if (rect.bottom > bottom) {
		scroller.scrollBy({ top: Math.min(rect.bottom - bottom, rect.top - top) });
	}
}

function agentsLabel(count: number): string {
	return `${count} ${count === 1 ? "agent" : "agents"}`;
}

/** How many grid columns the wall is showing right now. */
function columnCount(grid: HTMLElement): number {
	const template = getComputedStyle(grid).gridTemplateColumns;
	return Math.max(1, template.split(" ").filter(Boolean).length);
}

/** A card's primary action (Open/Close, or Message for a brand-new agent). */
function navTarget(card: Element | null): HTMLElement | null {
	return (
		card?.querySelector<HTMLElement>(`[${ARENA_NAV_ATTRIBUTE}]`) ??
		card?.querySelector<HTMLElement>("button:not(:disabled)") ??
		null
	);
}

/**
 * Move focus between cards from any control inside one: left/right to the
 * previous/next card, up/down a whole row, Home/End to the first/last card.
 * Focus lands on the target card's primary action.
 */
function moveFocus(grid: HTMLElement, from: HTMLElement, key: string): boolean {
	const cards = [...grid.querySelectorAll<HTMLElement>(CARD_SELECTOR)];
	const index = cards.indexOf(from.closest<HTMLElement>(CARD_SELECTOR) ?? from);
	if (index === -1) {
		return false;
	}
	const step: Record<string, number> = {
		ArrowDown: columnCount(grid),
		ArrowLeft: -1,
		ArrowRight: 1,
		ArrowUp: -columnCount(grid),
		End: cards.length - 1 - index,
		Home: -index,
	};
	const delta = step[key];
	if (delta === undefined) {
		return false;
	}
	const next = cards[Math.min(cards.length - 1, Math.max(0, index + delta))];
	navTarget(next ?? null)?.focus();
	return true;
}

/** Escape inside a text field belongs to the field (or the host's composer). */
function isEditable(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

/** Where the user opened the open thread from, so focus can go back there. */
interface Opener {
	agentId: string | null;
	threadId: string | null;
}

interface FocusRequest {
	at: number;
	to: "opener" | "panel";
}

/**
 * Arena: mission control for every agent. A header of live aggregate numbers
 * and filter chips sits over a wall of agent cards from `projectArena` —
 * working agents first, then those waiting on you. Opening a card keeps the
 * wall in view (narrower) and shows the host's real conversation beside it.
 */
export function ArenaInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["arena"]>) {
	const [filter, setFilter] = useState<ArenaFilter>("all");
	const [openedFromAgentId, setOpenedFromAgentId] = useState<string | null>(
		null
	);
	const [rovingId, setRovingId] = useState<string | null>(null);
	const cards = useMemo(() => buildArenaCards(snapshot), [snapshot]);
	const tally = useMemo(() => arenaAgentTally(cards), [cards]);
	const [scrolled, setScrolled] = useState(false);
	const nextUp = useMemo(() => arenaNextUp(snapshot), [snapshot]);
	const filterCounts = useMemo(() => {
		const counts: Record<ArenaFilter, number> = {
			all: 0,
			idle: 0,
			"needs-you": 0,
			working: 0,
		};
		for (const card of cards) {
			for (const option of ARENA_FILTERS) {
				counts[option] += Number(matchesArenaFilter(card, option));
			}
		}
		return counts;
	}, [cards]);
	const visible = cards.filter((card) => matchesArenaFilter(card, filter));
	// Four across only when it fills rows evenly or the wall is crowded;
	// six agents read better as two rows of three than four and an orphan pair.
	const fourAcross = visible.length > 8 || visible.length % 4 === 0;
	// Working agents with a reply waiting stay under Working; say so here.
	const busyNeedingYou =
		filter === "needs-you"
			? cards.filter((card) => card.state === "working" && card.needsYou > 0)
			: [];
	const unassigned = useMemo(
		() =>
			unassignedThreads(snapshot.threads).filter((thread) =>
				matchesUnassignedFilter(thread, filter)
			),
		[snapshot.threads, filter]
	);

	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const panelOpen = threadView !== null;
	// The card the user acted on leads a shared thread; otherwise its first agent.
	let leadAgentId: string | undefined;
	if (activeThread) {
		leadAgentId =
			openedFromAgentId && activeThread.agentIds.includes(openedFromAgentId)
				? openedFromAgentId
				: activeThread.agentIds[0];
	} else if (panelOpen) {
		leadAgentId = openedFromAgentId ?? undefined;
	}
	const tabStopId = visible.some((card) => card.agentId === rovingId)
		? rovingId
		: (visible[0]?.agentId ?? null);
	const now = Date.now();

	const rootRef = useRef<HTMLDivElement>(null);
	const gridRef = useRef<HTMLUListElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const openerRef = useRef<Opener>({ agentId: null, threadId: null });
	const focusRequestRef = useRef<FocusRequest | null>(null);
	const wasOpenRef = useRef(panelOpen);

	const requestFocus = (to: FocusRequest["to"]) => {
		focusRequestRef.current = { at: Date.now(), to };
	};
	const openFrom = (agentId: string | null, threadId: string) => {
		openerRef.current = { agentId, threadId };
		setOpenedFromAgentId(agentId);
		if (agentId) {
			setRovingId(agentId);
		}
		requestFocus("panel");
		port.openThread(threadId);
	};
	const messageFrom = (agentId: string) => {
		openerRef.current = { agentId, threadId: null };
		setOpenedFromAgentId(agentId);
		setRovingId(agentId);
		requestFocus("panel");
		port.startThread({ agentId });
	};
	const closePanel = () => {
		requestFocus("opener");
		port.closeThread();
	};

	/*
	 * Move focus with the panel: into its heading when a thread opens from the
	 * wall, and back to the control that opened it when it closes. Without
	 * this, the opener's subtree changes and focus falls to <body>.
	 */
	useLayoutEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = panelOpen;
		const request = focusRequestRef.current;
		const fresh =
			request !== null && Date.now() - request.at < FOCUS_REQUEST_TTL_MS;
		if (panelOpen && fresh && request.to === "panel") {
			focusRequestRef.current = null;
			headingRef.current?.focus();
			return;
		}
		if (!(wasOpen && !panelOpen)) {
			return;
		}
		focusRequestRef.current = null;
		const active = document.activeElement;
		const lost =
			active === null ||
			active === document.body ||
			!rootRef.current?.contains(active);
		if (!((fresh && request.to === "opener") || lost)) {
			return;
		}
		const { agentId, threadId } = openerRef.current;
		const root = rootRef.current;
		const fromCard = agentId
			? navTarget(
					root?.querySelector(`[data-agent-id="${CSS.escape(agentId)}"]`) ??
						null
				)
			: null;
		const fromRow = threadId
			? root?.querySelector<HTMLElement>(
					`[data-thread-id="${CSS.escape(threadId)}"]`
				)
			: null;
		const fallback = navTarget(
			gridRef.current?.querySelector(CARD_SELECTOR) ?? null
		);
		(fromCard ?? fromRow ?? fallback)?.focus();
	}, [panelOpen]);

	// Bring the card that leads the open thread into view (including on load),
	// clear of the sticky filter row.
	useEffect(() => {
		const grid = gridRef.current;
		const agentId = leadAgentId;
		if (!(grid && agentId)) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			const card = grid.querySelector(
				`[data-agent-id="${CSS.escape(agentId)}"]`
			);
			const scroller = grid.closest<HTMLElement>(`[${SCROLLER_ATTRIBUTE}]`);
			if (card && scroller) {
				revealCard(card, scroller);
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [leadAgentId]);

	// Escape with focus nowhere (after clicking plain text) still closes.
	useEffect(() => {
		if (!panelOpen) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body
			) {
				event.preventDefault();
				focusRequestRef.current = { at: Date.now(), to: "opener" };
				port.closeThread();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [panelOpen, port]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			panelOpen &&
			!event.defaultPrevented &&
			!isEditable(event.target)
		) {
			event.preventDefault();
			closePanel();
		}
	};

	const onGridKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		const grid = gridRef.current;
		const target = event.target;
		if (
			grid &&
			target instanceof HTMLElement &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			moveFocus(grid, target, event.key)
		) {
			event.preventDefault();
		}
	};

	const isEmpty = !loading && snapshot.agents.length === 0;
	const nextUpAgent = nextUp ? agentById(snapshot, nextUp.agentId) : undefined;
	const nextUpTitle = nextUp?.thread.title.trim() || "Untitled thread";
	const nextUpState =
		nextUp?.status === "attention" ? "failed" : "is your turn";

	return (
		<div
			className="relative flex size-full min-h-0 bg-background text-foreground"
			data-testid="interface-arena"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
		>
			<section
				aria-label="Arena"
				className="@container flex min-h-0 min-w-0 flex-1 flex-col"
			>
				<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
					<div className="flex min-w-0 flex-1 items-baseline gap-4">
						<h1 className="shrink-0 text-base leading-6">
							<span className="font-semibold">Arena</span>
						</h1>
						{loading ? null : <ArenaStatStrip tally={tally} />}
					</div>
					<Button onClick={() => port.startThread({})} size="sm" type="button">
						<Plus aria-hidden="true" data-icon="inline-start" />
						New thread
					</Button>
				</header>
				{isEmpty ? (
					<Empty className="flex-1">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<LayoutGrid aria-hidden="true" />
							</EmptyMedia>
							<EmptyTitle>No agents on the wall yet</EmptyTitle>
							<EmptyDescription>
								Each agent gets a card here with the thread it is on and what is
								waiting on you. Start a thread to put one to work.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button onClick={() => port.startThread({})} type="button">
								<Plus aria-hidden="true" data-icon="inline-start" />
								New thread
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<div
						className="flex min-h-0 flex-1 flex-col overflow-y-auto"
						onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
						{...{ [SCROLLER_ATTRIBUTE]: "" }}
					>
						<div
							className={cn(
								"sticky top-0 z-20 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-4 py-3 transition-colors",
								scrolled ? "border-border" : "border-transparent"
							)}
							{...{ [STICKY_ATTRIBUTE]: "" }}
						>
							<ToggleGroup
								appearance="segmented"
								aria-label="Filter agents"
								disabled={loading}
								multiple={false}
								onValueChange={(values: string[]) => {
									const value = values[0];
									if (isArenaFilter(value)) {
										setFilter(value);
									}
								}}
								spacing={0}
								value={[filter]}
							>
								{ARENA_FILTERS.map((option) => {
									const label = `${ARENA_FILTER_LABELS[option]} (${agentsLabel(filterCounts[option])})`;
									return (
										<ToggleGroupItem
											aria-label={label}
											className="gap-1.5 rounded-md px-3 font-medium text-[13px] text-muted-foreground aria-pressed:text-foreground"
											density="segmented"
											key={option}
											title={label}
											value={option}
										>
											{ARENA_FILTER_LABELS[option]}
											<span
												className={cn(
													"font-normal tabular-nums",
													!loading && filterCounts[option] === 0
														? "text-muted-foreground/60"
														: "text-muted-foreground"
												)}
											>
												{loading ? "–" : filterCounts[option]}
											</span>
										</ToggleGroupItem>
									);
								})}
							</ToggleGroup>
							{nextUp &&
							!loading &&
							!panelOpen &&
							busyNeedingYou.length === 0 ? (
								<Button
									aria-label={`Next up: ${nextUpTitle}${nextUpAgent ? ` with ${nextUpAgent.name}` : ""} ${nextUpState}. Open it.`}
									className="ms-auto -me-2 @3xl:inline-flex hidden min-w-0 max-w-[30rem] gap-2 px-2 font-normal"
									onClick={() => openFrom(nextUp.agentId, nextUp.thread.id)}
									size="sm"
									title={`Open ${nextUpTitle}`}
									type="button"
									variant="ghost"
								>
									<span className="shrink-0 text-muted-foreground">
										Next up
									</span>
									<span className="min-w-0 truncate text-foreground">
										{nextUpAgent ? (
											<>
												<span className="font-medium">{nextUpAgent.name}</span>
												<span
													aria-hidden="true"
													className="text-muted-foreground"
												>
													{" · "}
												</span>
											</>
										) : null}
										{nextUpTitle}
									</span>
								</Button>
							) : null}
							{busyNeedingYou.length > 0 && !loading ? (
								<p className="ms-auto min-w-0 truncate text-muted-foreground text-sm max-sm:hidden">
									Also waiting on you while working:{" "}
									{busyNeedingYou.map((card) => card.name).join(", ")}
								</p>
							) : null}
						</div>
						<div className="flex flex-col gap-8 px-4 pb-6">
							{!loading && visible.length === 0 ? (
								<p className="flex flex-wrap items-baseline gap-x-1 text-sm leading-6">
									<span className="font-medium text-foreground">
										{FILTER_EMPTY[filter].title}
									</span>
									<span className="text-muted-foreground">
										{FILTER_EMPTY[filter].description}
									</span>
									<Button
										className="ms-1 h-auto px-0 leading-6"
										onClick={() => setFilter("all")}
										type="button"
										variant="link"
									>
										Show all agents
									</Button>
								</p>
							) : (
								<ul
									aria-busy={loading}
									aria-describedby={loading ? undefined : NAV_HINT_ID}
									aria-label={`${ARENA_FILTER_LABELS[filter]} agents`}
									className={cn(
										"grid grid-cols-1 gap-3",
										panelOpen
											? "@2xl:grid-cols-2 @5xl:grid-cols-3"
											: cn(
													"@6xl:grid-cols-3 @xl:grid-cols-2",
													fourAcross && "@7xl:grid-cols-4"
												)
									)}
									onKeyDown={onGridKeyDown}
									ref={gridRef}
								>
									{loading ? (
										<ArenaCardSkeletons />
									) : (
										visible.map((card) => (
											<li
												key={card.agentId}
												onFocus={() => setRovingId(card.agentId)}
											>
												<ArenaAgentCard
													card={card}
													compact={panelOpen}
													inPanel={
														leadAgentId === card.agentId
															? activeThread
															: undefined
													}
													now={now}
													onMessage={messageFrom}
													onOpen={(threadId) =>
														openFrom(card.agentId, threadId)
													}
													tabbable={tabStopId === card.agentId}
												/>
											</li>
										))
									)}
								</ul>
							)}
							{loading ? null : (
								<div
									className={cn(
										"grid grid-cols-1 gap-8",
										!panelOpen && "@5xl:grid-cols-2"
									)}
								>
									<ArenaUnassigned
										activeThreadId={activeThreadId}
										now={now}
										onOpen={(threadId) => openFrom(null, threadId)}
										threads={unassigned}
									/>
									{filter === "all" ? (
										<ArenaSchedule now={now} snapshot={snapshot} />
									) : null}
								</div>
							)}
							<p className="sr-only" id={NAV_HINT_ID}>
								Tab enters one agent card; use the arrow keys, Home and End to
								move between agents. Escape closes the open thread.
							</p>
						</div>
					</div>
				)}
			</section>
			{panelOpen ? (
				<ArenaThreadPanel
					headingRef={headingRef}
					leadAgentId={leadAgentId}
					onClose={closePanel}
					snapshot={snapshot}
					thread={activeThread}
					threadView={threadView}
				/>
			) : null}
		</div>
	);
}
