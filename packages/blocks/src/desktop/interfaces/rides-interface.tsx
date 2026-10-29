import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	type InterfaceSnapshot,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { CarFront } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import { GAME_PLATE } from "./game-hud.tsx";
import { GameHudSlot, GameShell } from "./game-shell.tsx";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	IsoStage,
	IsoZoomControls,
	useGameNight,
	useIsoView,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAnnouncer,
	ActStatus,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	actRouteShare,
	type RidesActView,
	ridesActTrips,
} from "./rides-acts.tsx";
import { RidesBooking } from "./rides-booking.tsx";
import { RidesDioramaScene } from "./rides-diorama.tsx";
import { SheetHandle } from "./rides-handle.tsx";
import { RidesActCounters, RidesCounters } from "./rides-hud.tsx";
import { RidesList } from "./rides-list.tsx";
import {
	arrivedTrips,
	buildRides,
	driverOptions,
	etaLabel,
	finishedTrips,
	nowTrips,
	type SheetTab,
	tripHistory,
} from "./rides-model.ts";
import { ridesArt } from "./rides-palette.ts";
import {
	type RidesActEta,
	RidesActEtas,
	RidesActed,
	RidesActTrips,
	TripRow,
} from "./rides-parts.tsx";
import { buildCityPlan, ridesFrame } from "./rides-scene.ts";
import { RidesSheetTabs, type SheetLists } from "./rides-sheet.tsx";
import { RidesTrip, TripPreview } from "./rides-trip.tsx";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

const EMPTY_SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

/** Seconds between position updates: smooth driving, or rare jumps. */
const TICK_MS = 1000;
const REDUCED_TICK_MS = 30_000;

/** Escape belongs to text fields; elsewhere it closes the open trip. */
function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	return (
		target.closest("input, textarea, select, [contenteditable='true']") === null
	);
}

/** At this width and up the trip panel floats over the map's left side. */
const WIDE_FROM = 1000;
/** Lawn round the city, for trees and the shore. */
const CITY_RIM = 1.8;

/** The element's width, kept current; 0 until it is measured. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			if (element.clientWidth > 0) {
				setWidth(element.clientWidth);
			}
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/** World units kept round the plates when the act layer frames the map. */
const RIDES_ACT_PLATE_FIT = { above: 1.2, below: 0.8, max: 2.2, side: 1 };

/** The panel's one-line summary under "Get a ride". */
function panelStatus(counts: { arrived: number; enRoute: number }): string {
	if (counts.enRoute === 0 && counts.arrived === 0) {
		return "No trips under way";
	}
	return `${counts.enRoute} under way · ${counts.arrived} arrived`;
}

/** A clock that ticks while the page is visible. */
function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer === null) {
				setNow(Date.now());
				timer = setInterval(() => setNow(Date.now()), intervalMs);
			}
		};
		const stop = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const onVisibility = () => {
			if (document.hidden) {
				stop();
			} else {
				start();
			}
		};
		start();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [intervalMs]);
	return now;
}

/**
 * Rides: a ride-hailing rider app over your agents. The city map fills the
 * screen; agents are drivers whose cars wait at home spots, drive a route
 * to the destination of the conversation they are working on (with an ETA
 * estimated from their typical reply time), and park at the pin with
 * "Arrived" once they reply. The sheet books a trip ("Where to?" plus a
 * driver), lists trips under way, arrived trips, and the trip history, and
 * shows the open trip over the host's own conversation surface.
 */
export function RidesInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["rides"]>) {
	// The live settings (a bare `{}` resolves to the defaults).
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	const { timeOfDay } = resolveInterfaceParams("rides", params) as Required<
		InterfaceParamsByRenderer["rides"]
	>;
	const reduceMotion = useReducedMotion();
	const now = useNow(reduceMotion ? REDUCED_TICK_MS : TICK_MS);
	const source = loading ? EMPTY_SNAPSHOT : snapshot;
	const actsView = useActs(source);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	// With acts, every trip's stage and row word come from the acts.
	const actTrips = useMemo(
		() => (withActs ? ridesActTrips(source, acts) : null),
		[acts, source, withActs]
	);
	const rides = useMemo(
		() =>
			buildRides(
				source,
				now,
				actTrips
					? {
							progressOf: (thread) => actRouteShare(acts, thread.id),
							stageOf: (thread) =>
								actTrips.get(thread.id)?.stage ?? "completed",
						}
					: undefined
			),
		[actTrips, acts, source, now]
	);
	const options = useMemo(
		() => driverOptions(source, rides.trips),
		[source, rides.trips]
	);
	const lists = useMemo<SheetLists>(
		() => ({
			arrived: arrivedTrips(rides.trips),
			history: tripHistory(
				finishedTrips(rides.trips),
				new Date(now),
				actTrips !== null
			),
			now: nowTrips(rides.trips),
		}),
		[actTrips, now, rides.trips]
	);

	const [tab, setTab] = useState<SheetTab>("now");
	/** Phone layout only: the sheet opens at peek height over the map. */
	const [expanded, setExpanded] = useState(false);
	/** Undefined until the rider picks: the first trip under way is shown. */
	const [pickedTripId, setPreviewTripId] = useState<string | null>();
	const [prompt, setPrompt] = useState("");
	const [pickedDriverId, setPickedDriverId] = useState<string>();
	const [announcement, setAnnouncement] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const stageWidth = useWidth(rootRef);
	const wide = stageWidth >= WIDE_FROM;
	const ridesHeadingRef = useRef<HTMLHeadingElement>(null);
	const sentence = useActAnnouncement(source, actsView);
	const clock = useActClockOptions();
	const actCards = useActCards({
		acts,
		clock,
		fallbackFocus: ridesHeadingRef,
		nowMs,
		port,
		snapshot: source,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	// Every agent has a car on the map: all are on stage.
	const { offStage, onStage } = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const totals = actTotals(source, acts);
	// A routine's run is the only trip with an ETA: what is left of its
	// estimate. A chat's typical length is not one.
	const actEtas = useMemo(() => {
		const out = new Map<string, RidesActEta>();
		for (const act of acts.values()) {
			const progress = act.progress;
			const thread = source.threads.find((item) => item.id === act.threadId);
			if (
				progress?.kind === "estimate" &&
				thread?.routineRun &&
				progress.total > 0
			) {
				const left = Math.max(0, progress.total - progress.done) / 60_000;
				out.set(thread.id, {
					label: etaLabel(Math.round(left)),
					share: Math.min(1, progress.done / progress.total),
				});
			}
		}
		return out;
	}, [acts, source.threads]);
	const owners = useMemo(() => askOwners(acts), [acts]);
	// The kit settings (overlay density, work bubbles) for its own pieces too.
	const kitSettings = useGameKitSettings();
	const budget = overlayBudget(stageWidth > 0 ? stageWidth : 1280, {
		domTargets: true,
	});
	// A phone's open trip leaves the city a half screen: its station boards
	// ("3/7", "12m", "Next: …") stand down (the cars' plates and the queue
	// say what each is doing; the trip has its own words).
	const boardsDown = threadView !== null && !wide;
	const shownKey = withActs
		? [
				...budget.fill(
					actOverlays(
						onStage,
						slots,
						offStage,
						onStage.find((act) => act.act === "working")?.agentId ?? null,
						{ reduced: reduceMotion }
					)
						.filter((item) => keepsActOverlay(item, kitSettings))
						.filter((item) => !(boardsDown && item.kind === "text"))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		actCards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => actCards.openBlocker(threadId, agentName, opener);
	const actView: RidesActView | null = withActs
		? {
				acts,
				clock,
				iconOnly: budget.iconOnly,
				nowMs,
				offStage,
				onAsk: (askId) => actCards.openAsk(askId),
				onBlocker: (threadId, agentName) =>
					actCards.openBlocker(threadId, agentName),
				onQueue: () => openQueue(queueOpener),
				owners,
				privacy,
				shown,
				slots,
				snapshot: source,
				trips: actTrips ?? undefined,
			}
		: null;
	const actRow = (agentId: string) => {
		const act = acts.get(agentId);
		return act
			? {
					label: act.ariaLabel,
					status: (
						<ActStatus
							act={act}
							clock={clock}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							snapshot={source}
						/>
					),
				}
			: null;
	};
	const focusHeading = useRef(false);
	const returnFocusTo = useRef<string | null>(null);

	// "Time of day": the color theme's (dark is night), or always day or night.
	const themeNight = useGameNight(rootRef);
	const night = timeOfDay === "theme" ? themeNight : timeOfDay === "night";
	const isoView = useIsoView();
	const art = ridesArt(night);
	const frame = useMemo(() => ridesFrame(rides), [rides]);
	const frameKey = `${frame.cols.join()}|${frame.rows.join()}|${frame.park?.col}:${frame.park?.row}`;
	// The city only rebuilds when the streets it spans change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the frame's extent, not the object.
	const plan = useMemo(() => buildCityPlan(frame), [frameKey]);
	const shape = useMemo(
		() =>
			islandFor(
				plan.rect.maxX - plan.rect.minX,
				plan.rect.maxZ - plan.rect.minZ,
				CITY_RIM
			),
		[plan]
	);
	const agentIds = useMemo(
		() => source.agents.map((agent) => agent.id),
		[source.agents]
	);
	const { swatches } = useVillagerLooks(agentIds, night);

	const threadOpen = threadView !== null;
	const openTrip = activeThreadId
		? rides.trips.find((trip) => trip.id === activeThreadId)
		: undefined;
	// With the act layer no trip is picked by itself: its pin and title
	// would sit on its driver's car and station words.
	const defaultTrip = withActs
		? undefined
		: lists.now.find((trip) => trip.stage === "enroute");
	const previewTripId =
		pickedTripId === undefined ? (defaultTrip?.id ?? null) : pickedTripId;
	const selectedTripId = threadOpen ? (activeThreadId ?? null) : previewTripId;
	const previewTrip = previewTripId
		? rides.trips.find((trip) => trip.id === previewTripId)
		: undefined;
	// What the picker shows is always what gets booked.
	const driverId =
		pickedDriverId &&
		options.some((option) => option.agent.id === pickedDriverId)
			? pickedDriverId
			: options[0]?.agent.id;
	const booking = prompt.trim() !== "" && options.length > 0;
	// On a phone the sheet peeks (Where to? and the next trip) until it is
	// pulled up, a trip is opened, or a destination is being typed.
	const peek = !(threadOpen || booking || expanded);
	const peekTrip = lists.now[0] ?? lists.arrived[0];

	const openTripById = useCallback(
		(tripId: string) => {
			focusHeading.current = true;
			returnFocusTo.current = tripId;
			setPreviewTripId(tripId);
			port.openThread(tripId);
		},
		[port]
	);

	const closeTrip = useCallback(() => {
		port.closeThread();
	}, [port]);

	const book = () => {
		const text = prompt.trim();
		const driver = options.find((option) => option.agent.id === driverId);
		if (!(text && driver)) {
			return;
		}
		focusHeading.current = true;
		port.startThread({ agentId: driver.agent.id, prompt: text });
		setPrompt("");
		setTab("now");
		setAnnouncement(`Booked ${driver.agent.name}.`);
	};

	const pickDriver = (agentId: string) => {
		setPickedDriverId(agentId);
		const name = options.find((option) => option.agent.id === agentId)?.agent
			.name;
		setAnnouncement(name ? `${name} selected as your driver.` : "");
		inputRef.current?.focus();
	};

	// Land keyboard users on the trip they opened, and back on its row after.
	useLayoutEffect(() => {
		if (threadOpen && focusHeading.current) {
			focusHeading.current = false;
			headingRef.current?.focus();
			return;
		}
		if (!threadOpen && returnFocusTo.current) {
			const tripId = returnFocusTo.current;
			returnFocusTo.current = null;
			// The same trip can be listed twice (the phone's peek row and the
			// full list); return to the copy that is on screen.
			const rows = rootRef.current?.querySelectorAll<HTMLButtonElement>(
				`[data-trip-id="${CSS.escape(tripId)}"]`
			);
			const row = [...(rows ?? [])].find(
				(candidate) => candidate.getClientRects().length > 0
			);
			(row ?? rows?.[0])?.focus({ preventScroll: false });
		}
	}, [threadOpen]);

	useEffect(() => {
		const root = rootRef.current;
		if (!(root && threadOpen)) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && escapeIsFree(event.target)) {
				event.preventDefault();
				closeTrip();
			}
		};
		root.addEventListener("keydown", onKeyDown);
		return () => root.removeEventListener("keydown", onKeyDown);
	}, [closeTrip, threadOpen]);

	const counts = {
		arrived: lists.arrived.length,
		enRoute: lists.now.length,
	};
	const panelCover = wide ? (threadOpen ? 440 : 400) + 24 : 0;
	// The act HUD stack: the caption and buttons on wide stages (the summary
	// is in the panel), the summary too on narrow ones and over an open trip.
	const actTop = wide && !threadOpen ? 120 : 150;

	return (
		<RidesActed.Provider value={withActs}>
			<RidesActTrips.Provider value={actTrips}>
				<RidesActEtas.Provider value={actEtas}>
					<GameShell
						accent="tomato"
						busy={loading}
						hud={
							loading ? null : (
								<>
									{withActs ? (
										<GameHudSlot
											at={wide ? "top-right" : "top-left"}
											className={cn(
												"flex-col",
												wide
													? "right-20 items-end"
													: "max-w-[calc(100%-4.5rem)] items-start"
											)}
										>
											{/* Wide stages carry the summary in the panel's header, which
										    an open trip hides. */}
											{wide && !threadOpen ? null : (
												<p
													className={cn(
														GAME_PLATE,
														"pointer-events-auto w-fit max-w-full truncate rounded-xl px-3 py-1.5 font-semibold text-[13px]"
													)}
													data-act-summary=""
												>
													{actSummaryLine(totals)}
												</p>
											)}
											<BlindSpotCaption snapshot={source} />
											<div className="flex gap-2">
												<NeedYouButton
													onAsk={onAsk}
													snapshot={source}
													totals={totals}
												/>
												<QueueButton
													acts={acts}
													clock={clock}
													narrow={!wide && stageWidth < 640}
													nowMs={nowMs}
													onAsk={onAsk}
													onBlocker={onBlocker}
													openRef={queueOpener}
													snapshot={source}
													totals={totals}
													unowned={unowned}
												/>
											</div>
										</GameHudSlot>
									) : null}
									<GameHudSlot at="top-right">
										<IsoZoomControls view={isoView} />
									</GameHudSlot>
									{wide ? (
										<GameHudSlot at="bottom-right">
											{withActs ? (
												<RidesActCounters
													acts={acts}
													answers={
														(source.asks ?? []).filter(
															(ask) => ask.kind === "reply"
														).length
													}
													totals={totals}
												/>
											) : (
												<RidesCounters
													arrived={counts.arrived}
													enRoute={counts.enRoute}
													free={
														options.filter((option) => option.available).length
													}
												/>
											)}
										</GameHudSlot>
									) : null}
								</>
							)
						}
						label="Rides"
						rootRef={rootRef}
						testId="interface-rides"
					>
						{withActs ? (
							<>
								{/* The page's h1 stays mounted while the panel's header comes and goes. */}
								<h1 className="sr-only" ref={ridesHeadingRef} tabIndex={-1}>
									Rides
								</h1>
								<AskQueueList
									acts={acts}
									clock={clock}
									fallbackFocus={ridesHeadingRef}
									nowMs={nowMs}
									onAsk={onAsk}
									onBlocker={onBlocker}
									snapshot={source}
									unowned={unowned}
								/>
							</>
						) : null}
						<div className="@container absolute inset-0 @min-[1000px]:block flex min-h-0 flex-col">
							<main
								aria-label="Map"
								className="@min-[1000px]:absolute relative @min-[1000px]:inset-0 order-1 min-h-0 flex-1"
								data-rides-time={night ? "night" : "day"}
							>
								<IsoStage
									bounds={{ ...plan.rect, top: 1.8 }}
									fallback={
										<RidesList
											acts={withActs ? actRow : undefined}
											onOpenTrip={openTripById}
											onPickDriver={pickDriver}
											onSelectTrip={setPreviewTripId}
											rides={rides}
											selectedTripId={selectedTripId}
										/>
									}
									fill={1.12}
									// With acts, zoom on to the cars and the kerb, not the whole city.
									fitPlates={withActs ? RIDES_ACT_PLATE_FIT : undefined}
									insets={{
										bottom: wide ? 96 : 16,
										left: 16 + panelCover,
										right: wide ? 88 : 16,
										top: withActs ? actTop : 16,
									}}
									label={`City map: ${withActs ? actSummaryLine(totals) : `${counts.enRoute} under way, ${counts.arrived} arrived`}. Tab or the arrow keys move between cars and pins; drag to pan, plus and minus to zoom.`}
									night={night}
									reducedMotion={reduceMotion}
									view={isoView}
								>
									{({ quality, theme }) => (
										<RidesDioramaScene
											acts={actView ? { onStage, view: actView } : null}
											art={art}
											night={night}
											onOpenTrip={openTripById}
											onPickDriver={pickDriver}
											onSelectTrip={setPreviewTripId}
											plan={plan}
											quality={quality}
											reducedMotion={reduceMotion}
											rides={rides}
											selectedTripId={selectedTripId}
											shape={shape}
											swatches={swatches}
											theme={theme}
										/>
									)}
								</IsoStage>
							</main>
							<aside
								aria-label="Rides"
								className={cn(
									"relative z-30 order-2 @min-[1000px]:m-0 m-2 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-(--gk-plate) text-(--gk-ink) shadow-(--gk-lip)",
									"@min-[1000px]:absolute @min-[1000px]:inset-y-3 @min-[1000px]:left-3 @min-[1000px]:h-auto",
									// On a phone the open trip is a half sheet, as the
									// peeking one: the city above keeps room for its words.
									threadOpen
										? "h-[46%] @min-[1000px]:w-[440px]"
										: "@min-[1000px]:w-[400px]",
									!threadOpen &&
										(peek ? "@min-[1000px]:max-h-none max-h-[46%]" : "h-[64%]")
								)}
							>
								{threadOpen ? null : (
									<SheetHandle
										expanded={!peek}
										onExpandedChange={(next) => {
											setExpanded(next);
											if (!next) {
												setPrompt("");
											}
										}}
									/>
								)}
								{threadOpen ? null : (
									<header className="@min-[1000px]:flex hidden shrink-0 items-center gap-3 px-3 pt-3 pb-2.5">
										<span
											aria-hidden="true"
											className="grid size-11 shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)"
										>
											<CarFront className="size-6" strokeWidth={2.25} />
										</span>
										<div className="flex min-w-0 flex-col">
											{withActs ? (
												<h2 className="gk-display text-[24px] leading-7">
													Get a ride
												</h2>
											) : (
												<h1 className="gk-display text-[24px] leading-7">
													Get a ride
												</h1>
											)}
											<p
												className="truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5"
												data-act-summary={withActs && !loading ? "" : undefined}
											>
												{loading && "Finding drivers…"}
												{!loading && withActs ? actSummaryLine(totals) : null}
												{loading || withActs ? null : panelStatus(counts)}
											</p>
										</div>
									</header>
								)}
								<div className="flex min-h-0 flex-1 flex-col overflow-hidden border-(--gk-plate-sunk) border-t-2">
									{threadOpen ? (
										<RidesTrip
											headingRef={headingRef}
											onBack={closeTrip}
											threadView={threadView}
											trip={openTrip}
										/>
									) : (
										<>
											<div className="flex shrink-0 flex-col gap-3 p-3">
												<RidesBooking
													driverId={driverId}
													inputRef={inputRef}
													onBook={book}
													onDriverChange={setPickedDriverId}
													onPromptChange={setPrompt}
													options={loading ? [] : options}
													prompt={prompt}
													reduceMotion={reduceMotion}
												/>
											</div>
											{/* The lists fade out as the driver picker opens in their
								    place, so the sheet never jumps on the first keystroke. */}
											<AnimatePresence initial={false}>
												{booking ? null : (
													<motion.div
														animate={{ opacity: 1 }}
														className={cn(
															"min-h-0 flex-1 flex-col",
															peek ? "@min-[1000px]:flex hidden" : "flex"
														)}
														exit={{ opacity: 0 }}
														initial={{ opacity: 0 }}
														key="lists"
														transition={{
															duration: reduceMotion ? 0 : 0.15,
															ease: "easeOut",
														}}
													>
														<RidesSheetTabs
															drivers={options}
															lists={lists}
															loading={loading}
															now={now}
															onFocusTrip={setPreviewTripId}
															onOpenTrip={openTripById}
															onPickDriver={pickDriver}
															onTabChange={setTab}
															pickedDriverId={pickedDriverId}
															reduceMotion={reduceMotion}
															selectedTripId={selectedTripId}
															tab={tab}
														/>
													</motion.div>
												)}
											</AnimatePresence>
											{wide && !booking && previewTrip ? (
												<TripPreview
													now={now}
													onOpen={() => openTripById(previewTrip.id)}
													trip={previewTrip}
												/>
											) : null}
											{peek && peekTrip ? (
												<ul
													aria-label="Next trip"
													className="@min-[1000px]:hidden border-border border-t"
												>
													<TripRow
														now={now}
														onFocusTrip={setPreviewTripId}
														onOpen={openTripById}
														selected={peekTrip.id === selectedTripId}
														trip={peekTrip}
														variant="live"
													/>
												</ul>
											) : null}
										</>
									)}
								</div>
							</aside>
						</div>
						<p aria-live="polite" className="sr-only">
							{announcement}
						</p>
						{withActs ? <ActAnnouncer sentence={sentence} /> : null}
						{actCards.element}
					</GameShell>
				</RidesActEtas.Provider>
			</RidesActTrips.Provider>
		</RidesActed.Provider>
	);
}
