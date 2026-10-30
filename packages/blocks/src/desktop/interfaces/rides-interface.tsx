import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { useCallback, useMemo, useRef, useState } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import { GameShell } from "./game-shell.tsx";
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
import { IsoStage, useGameNight, useIsoView } from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAnnouncer,
	AskQueueList,
	askOwners,
	openQueue,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	actRouteShare,
	type RidesActView,
	ridesActTrips,
} from "./rides-acts.tsx";
import { RidesDioramaScene } from "./rides-diorama.tsx";
import { useRidesActEtas, useTripFocus } from "./rides-interface-effects.ts";
import { RidesInterfaceHud, ridesActRow } from "./rides-interface-hud.tsx";
import {
	CITY_RIM,
	EMPTY_SNAPSHOT,
	REDUCED_TICK_MS,
	RIDES_ACT_PLATE_FIT,
	TICK_MS,
	useNow,
	useWidth,
	WIDE_FROM,
} from "./rides-interface-parts.ts";
import { RidesInterfaceSheet } from "./rides-interface-sheet.tsx";
import { RidesList } from "./rides-list.tsx";
import {
	arrivedTrips,
	buildRides,
	driverOptions,
	finishedTrips,
	nowTrips,
	type SheetTab,
	tripHistory,
} from "./rides-model.ts";
import { ridesArt } from "./rides-palette.ts";
import { RidesActEtas, RidesActed, RidesActTrips } from "./rides-parts.tsx";
import { buildCityPlan, ridesFrame } from "./rides-scene.ts";
import type { SheetLists } from "./rides-sheet.tsx";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

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
	const tl = useLiteralMessages();
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
	const actEtas = useRidesActEtas(acts, source.threads);
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
	const actRow = ridesActRow({ acts, clock, nowMs, onAsk, onBlocker, source });
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
		setAnnouncement(
			name ? tl("{name} selected as your driver.", { name }) : ""
		);
		inputRef.current?.focus();
	};

	// Land keyboard users on the trip they opened, and back on its row after.
	useTripFocus({
		closeTrip,
		focusHeading,
		headingRef,
		returnFocusTo,
		rootRef,
		threadOpen,
	});

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
								<RidesInterfaceHud
									acts={acts}
									clock={clock}
									counts={counts}
									isoView={isoView}
									nowMs={nowMs}
									onAsk={onAsk}
									onBlocker={onBlocker}
									options={options}
									queueOpener={queueOpener}
									source={source}
									stageWidth={stageWidth}
									threadOpen={threadOpen}
									totals={totals}
									unowned={unowned}
									wide={wide}
									withActs={withActs}
								/>
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
									label={tl(
										"City map: {summary}. Tab or the arrow keys move between cars and pins; drag to pan, plus and minus to zoom.",
										{
											summary: withActs
												? actSummaryLine(totals)
												: tl("{enRoute} under way, {arrived} arrived", {
														arrived: counts.arrived,
														enRoute: counts.enRoute,
													}),
										}
									)}
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
							<RidesInterfaceSheet
								book={book}
								booking={booking}
								closeTrip={closeTrip}
								counts={counts}
								driverId={driverId}
								headingRef={headingRef}
								inputRef={inputRef}
								lists={lists}
								loading={loading}
								now={now}
								openTrip={openTrip}
								openTripById={openTripById}
								options={options}
								peek={peek}
								peekTrip={peekTrip}
								pickDriver={pickDriver}
								pickedDriverId={pickedDriverId}
								previewTrip={previewTrip}
								prompt={prompt}
								reduceMotion={reduceMotion}
								selectedTripId={selectedTripId}
								setExpanded={setExpanded}
								setPickedDriverId={setPickedDriverId}
								setPreviewTripId={setPreviewTripId}
								setPrompt={setPrompt}
								setTab={setTab}
								tab={tab}
								threadOpen={threadOpen}
								threadView={threadView}
								totals={totals}
								wide={wide}
								withActs={withActs}
							/>
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
