import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
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
import { ArenaAgentCard, ArenaCardSkeletons } from "./arena-card.tsx";
import { ArenaFilterBar, FILTER_EMPTY } from "./arena-interface-filter-bar.tsx";
import {
	CARD_SELECTOR,
	type FocusRequest,
	isEditable,
	moveFocus,
	navTarget,
	type Opener,
	revealCard,
	SCROLLER_ATTRIBUTE,
} from "./arena-interface-navigation.ts";
import {
	ARENA_FILTER_LABELS,
	ARENA_FILTERS,
	type ArenaFilter,
	arenaAgentTally,
	arenaNextUp,
	buildArenaCards,
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
	const tl = useLiteralMessages();
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
						<ArenaFilterBar
							busyNeedingYou={busyNeedingYou}
							filter={filter}
							filterCounts={filterCounts}
							loading={loading}
							nextUp={nextUp}
							nextUpAgent={nextUpAgent}
							openFrom={openFrom}
							panelOpen={panelOpen}
							scrolled={scrolled}
							setFilter={setFilter}
						/>
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
									aria-label={tl("{filter} agents", {
										filter: ARENA_FILTER_LABELS[filter],
									})}
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
