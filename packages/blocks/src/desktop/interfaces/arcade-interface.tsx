import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import type { ArcadeActView } from "./arcade-acts.tsx";
import { SlotCabinet } from "./arcade-cabinet.tsx";
import { ArcadeComposer } from "./arcade-composer.tsx";
import {
	ARCADE_RIM,
	ArcadeDioramaScene,
	layoutHall,
} from "./arcade-diorama.tsx";
import { ArcadeEmpty } from "./arcade-empty.tsx";
import {
	useArcadeMode,
	useElementSize,
	usePageVisible,
	useSpinFeedback,
} from "./arcade-hooks.ts";
import {
	ArcadeActions,
	ArcadeFilters,
	ArcadeMeters,
	ArcadePaytable,
	ArcadeTitle,
} from "./arcade-hud.tsx";
import {
	bankWidth,
	buildFloor,
	composeInput,
	floorFit,
	type Machine,
	machineForThread,
	nextJackpot,
	SLOT_AISLE,
	SLOT_FOOTPRINT,
} from "./arcade-model.ts";
import {
	type ArcadeMode,
	arcadePalette,
	cabinetSkin,
	carpetTile,
} from "./arcade-palette.ts";
import { ArcadePanel, MachineSheet } from "./arcade-panel.tsx";
import { ARCADE_KEYFRAMES, ReelDefs } from "./arcade-reels.tsx";
import { ArcadeWall, wallHeight } from "./arcade-wall.tsx";
import { GAME_PLATE, GameIconButton } from "./game-hud.tsx";
import { GameHudSlot, GameShell, gameSheetCover } from "./game-shell.tsx";
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
	useFocusOnOpen,
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
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/** How long the reels spin after a message goes in, before the snapshot catches up. */
const FEEDBACK_SPIN_MS = 1600;
/** The composer key for a new game (no machine picked). */
const NEW_GAME = "new-game";
const LOADING_CABINETS = ["one", "two", "three", "four"];
/** The floor's padding beside the aisle: room for the walk buttons. */
const FLOOR_PADDING = 56;
/** The carpet between the marquee and the toppers, with the filter chips. */
const FLOOR_TOP = 24;
const FILTERS_HEIGHT = 40 + 20;
/** Room the HUD's bottom row (meters, paytable) keeps under the machines. */
const HUD_BOTTOM = 92;

/**
 * Escape inside a text field belongs to the field, except in the play slip
 * while it is empty: there it closes the slip.
 */
function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	const editable =
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !==
			null;
	if (!editable) {
		return true;
	}
	return (
		target instanceof HTMLTextAreaElement &&
		target.closest("[data-arcade-composer]") !== null &&
		target.value.trim() === ""
	);
}

/**
 * Arcade: a casino floor. Every agent is a slot machine whose three reels
 * are its latest conversations (bell: your turn, seven: working, bar:
 * waiting, cherry: done, flame: a failed run). Working machines spin, a
 * reply waiting on you lights the jackpot topper and drops a ticket in the
 * payout tray, and a failed run tilts the machine. Pulling a lever opens a
 * play slip for that agent; cashing a ticket opens the host's own
 * conversation at the redemption counter. Projects and teams are the
 * video cabinets on the back wall: pressing one narrows the floor to its
 * machines.
 */
/** Fit the hall's players and cabinets: marquees above, cabinets below. */
const ARCADE_PLATE_FIT = { above: 1.5, below: 1.9, max: 2.6, side: 1.7 };
/**
 * With the act layer: room over the heads for the station boards, and
 * beside the outer players for their bubbles.
 */
const ARCADE_ACT_PLATE_FIT = { above: 1, below: 0.9, max: 2.6, side: 1.2 };

/** The hall's lights: the color theme's (dark is night), or the setting's. */
export function arcadeLights(
	lights: Required<InterfaceParamsByRenderer["arcade"]>["lights"],
	themeMode: ArcadeMode
): ArcadeMode {
	if (lights === "day") {
		return "light";
	}
	return lights === "night" ? "dark" : themeMode;
}

export function ArcadeInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["arcade"]>) {
	const reduced = useReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const panelHeadingRef = useRef<HTMLHeadingElement>(null);
	const focusPanel = useRef(false);
	// The live settings (a bare `{}` resolves to the defaults).
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	const settings = resolveInterfaceParams("arcade", params) as Required<
		InterfaceParamsByRenderer["arcade"]
	>;
	const themeMode = useArcadeMode(rootRef);
	const mode = arcadeLights(settings.lights, themeMode);
	const visible = usePageVisible();
	const palette = arcadePalette(mode);
	const baseId = useId().replace(/:/g, "");
	const blurId = `arcade-blur-${baseId}`;
	const hintId = `arcade-hint-${baseId}`;
	const { spin, spinning } = useSpinFeedback(FEEDBACK_SPIN_MS);
	const floorRef = useRef<HTMLDivElement>(null);
	const floorSize = useElementSize(floorRef);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);

	const [filterId, setFilterId] = useState<string | null>(null);
	/** The machine opened from its player in the hall (its cabinet sheet). */
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const isoView = useIsoView();
	const [composerFor, setComposerFor] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	/** The machine whose tray or reel the open ticket was cashed from. */
	const [cashedFrom, setCashedFrom] = useState<string | null>(null);

	const floor = useMemo(
		() => buildFloor(snapshot, filterId),
		[snapshot, filterId]
	);
	const wholeFloor = useMemo(() => buildFloor(snapshot, null), [snapshot]);
	const next = nextJackpot(floor);
	const threadOpen = threadView !== null;
	const openThread = activeThreadId
		? snapshot.threads.find((item) => item.id === activeThreadId)
		: undefined;
	const openMachine = threadOpen
		? machineForThread(wholeFloor, openThread, cashedFrom)
		: undefined;
	const composerMachine =
		composerFor && composerFor !== NEW_GAME
			? wholeFloor.machines.find((machine) => machine.id === composerFor)
			: undefined;
	const composerAgents: InterfaceAgent[] = floor.machines.map(
		(machine) => machine.agent
	);
	const selectedMachine = selectedId
		? floor.machines.find((machine) => machine.id === selectedId)
		: undefined;
	// Portrait stages (a phone) stack the rows taller: fewer cabinets each.
	const portraitFloor =
		floorSize.width > 0 && floorSize.width < floorSize.height;
	const hall = useMemo(
		() => layoutHall(floor.machines, portraitFloor, withActs),
		[floor.machines, portraitFloor, withActs]
	);
	// The act layer: the floor's players are on stage (every station), the
	// agents a filter hides are off stage.
	const { offStage, onStage } = useMemo(() => {
		const onFloor = new Set(floor.machines.map((machine) => machine.agent.id));
		const shown = new Map([...acts].filter(([id]) => onFloor.has(id)));
		const hidden = new Map([...acts].filter(([id]) => !onFloor.has(id)));
		return {
			offStage: stageAgents(hidden, 0).offStage,
			onStage: stageAgents(shown, Number.POSITIVE_INFINITY).onStage,
		};
	}, [acts, floor.machines]);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const totals = actTotals(snapshot, acts);
	// Answers ready: the unread replies the act layer delivers.
	const answersReady = (snapshot.asks ?? []).filter(
		(ask) => ask.kind === "reply"
	).length;
	const owners = useMemo(() => askOwners(acts), [acts]);
	const shape = useMemo(
		() => islandFor(hall.halfWidth * 2, hall.halfDepth * 2, ARCADE_RIM),
		[hall]
	);
	const agentIds = useMemo(
		() => floor.machines.map((machine) => machine.agent.id),
		[floor.machines]
	);
	const night = mode === "dark";
	const { looks } = useVillagerLooks(agentIds, night);

	let viewKey = "";
	if (threadOpen) {
		viewKey = activeThreadId ?? "new";
	} else if (selectedMachine) {
		viewKey = `machine:${selectedMachine.id}`;
	}
	useLayoutEffect(() => {
		if (viewKey && focusPanel.current) {
			focusPanel.current = false;
			panelHeadingRef.current?.focus();
		}
	}, [viewKey]);

	const open = (threadId: string, machineId: string | null = null) => {
		focusPanel.current = true;
		setCashedFrom(machineId);
		setComposerFor(null);
		port.openThread(threadId);
	};
	const close = () => port.closeThread();
	const toggleFilter = (groupId: string) => {
		const nextId = filterId === groupId ? null : groupId;
		setFilterId(nextId);
		const group = snapshot.groups.find((item) => item.id === nextId);
		setAnnouncement(
			group ? `Showing ${group.name} machines` : "Showing every machine"
		);
	};
	const clearFilter = () => {
		setFilterId(null);
		setAnnouncement("Showing every machine");
	};
	const newGame = () => setComposerFor(NEW_GAME);
	const selectMachine = (machineId: string) => {
		if (threadOpen) {
			close();
		}
		focusPanel.current = true;
		setSelectedId(machineId);
		const machine = floor.machines.find((item) => item.id === machineId);
		setAnnouncement(machine ? `${machine.name}'s machine` : "");
	};
	const pull = (machine: Machine) => {
		setComposerFor(machine.id);
		setAnnouncement(`Lever pulled: message ${machine.name}`);
	};
	const submit = (input: { agentId?: string; prompt: string }) => {
		const machine =
			composerMachine ??
			floor.machines.find((item) => item.agent.id === input.agentId);
		setComposerFor(null);
		focusPanel.current = true;
		setCashedFrom(machine?.id ?? null);
		if (machine) {
			spin(machine.id);
			port.startThread(composeInput(machine, floor.filter, input.prompt));
			return;
		}
		port.startThread({
			agentId: input.agentId,
			projectId: floor.filter?.kind === "project" ? floor.filter.id : undefined,
			prompt: input.prompt,
			teamId: floor.filter?.kind === "team" ? floor.filter.id : undefined,
		});
	};

	/** Escape closes the play slip, then the open ticket, then the filter. */
	const stepBack = (): boolean => {
		if (composerFor !== null) {
			setComposerFor(null);
			return true;
		}
		if (threadOpen) {
			close();
			return true;
		}
		if (selectedId !== null) {
			setSelectedId(null);
			return true;
		}
		if (filterId !== null) {
			clearFilter();
			return true;
		}
		return false;
	};
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;
	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!escapeIsFree(event.target)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};
	useEffect(() => {
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.target !== document.body
			) {
				return;
			}
			if (stepBackRef.current()) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, []);

	const empty = !loading && floor.machines.length === 0;
	// The kit settings (overlay density, work bubbles) for its own pieces too.
	const kitSettings = useGameKitSettings();
	const budget = overlayBudget(floorSize.width > 0 ? floorSize.width : 1280, {
		domTargets: true,
	});
	const shownKey = withActs
		? [
				...budget.fill(
					actOverlays(
						onStage,
						slots,
						offStage,
						onStage.find((act) => act.act === "working")?.agentId ?? null,
						{ reduced }
					).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actView: ArcadeActView | null = withActs
		? {
				acts,
				clock,
				iconOnly: budget.iconOnly,
				nowMs,
				offStage,
				onAsk: (askId) => cards.openAsk(askId),
				onBlocker: (threadId, agentName) =>
					cards.openBlocker(threadId, agentName),
				onQueue: () => openQueue(queueOpener),
				owners,
				privacy,
				shown,
				slots,
				snapshot,
			}
		: null;
	// The sheet floats over the floor's right side; the HUD and the aisle
	// share what it leaves (on a narrow stage it covers everything).
	const cover =
		threadOpen || selectedMachine ? gameSheetCover(floorSize.width) : 0;
	const sheetCover = cover < floorSize.width ? cover : 0;
	const hudWidth = floorSize.width > 0 ? floorSize.width - sheetCover : 1440;
	const compact = hudWidth < 640;
	const wall = wallHeight(hudWidth);
	const filters = floor.wall.length > 0 || filterId !== null;
	const fit = floorFit(
		floor.machines.length,
		hudWidth - FLOOR_PADDING * 2,
		floorSize.height > 0
			? floorSize.height -
					wall -
					FLOOR_TOP -
					(filters ? FILTERS_HEIGHT : 0) -
					(compact ? 72 : HUD_BOTTOM)
			: Number.POSITIVE_INFINITY
	);
	const aisleRef = useRef<HTMLUListElement>(null);
	const walk = (direction: -1 | 1) => {
		aisleRef.current?.scrollBy({
			behavior: reduced ? "auto" : "smooth",
			left: direction * (SLOT_FOOTPRINT + SLOT_AISLE) * fit.zoom,
		});
	};
	const cabinet = (machine: Machine, zoom: number, describedBy?: string) => (
		<SlotCabinet
			active={openMachine?.id === machine.id}
			activeThreadId={
				openMachine?.id === machine.id ? (activeThreadId ?? null) : null
			}
			actLabel={withActs ? acts.get(machine.agent.id)?.ariaLabel : undefined}
			agents={snapshot.agents}
			blurId={blurId}
			composing={composerFor === machine.id}
			describedBy={describedBy}
			feedback={spinning.has(machine.id)}
			machine={machine}
			onCompose={() => pull(machine)}
			onOpen={(threadId) => open(threadId, machine.id)}
			palette={palette}
			reduced={reduced}
			zoom={zoom}
		/>
	);
	const actButtons = (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={compact}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={totals}
				unowned={unowned}
			/>
		</>
	);
	const actions = (
		<ArcadeActions
			compact={compact}
			floor={floor}
			loading={loading}
			next={withActs ? undefined : next}
			onCollect={open}
			onNewGame={newGame}
		/>
	);
	let filtersTop = compact ? "top-14" : "top-20";
	if (withActs) {
		filtersTop = compact ? "top-24" : "top-28";
	}
	const filterChips =
		filters && !loading ? (
			<ArcadeFilters
				acted={withActs}
				cabinets={floor.wall}
				filterId={filterId}
				onClear={clearFilter}
				onToggle={toggleFilter}
			/>
		) : null;
	const hud = (
		<>
			<GameHudSlot
				at="top-left"
				className={withActs ? "right-0 flex-col items-start" : "right-0"}
			>
				{withActs ? (
					<>
						<div className="flex w-full min-w-0 gap-2">
							<ArcadeTitle
								compact={compact}
								floor={floor}
								status={actSummaryLine(totals)}
							/>
							<div className="ms-auto flex shrink-0 items-start gap-2">
								{compact ? null : actButtons}
								{actions}
							</div>
						</div>
						<BlindSpotCaption snapshot={snapshot} />
						{/* On a phone the title can wrap: the chips follow the
						    column, so they never cover the caption. */}
						{compact && filterChips ? (
							<div className="max-w-full">{filterChips}</div>
						) : null}
					</>
				) : (
					<>
						<ArcadeTitle compact={compact} floor={floor} />
						<div className="ms-auto">{actions}</div>
					</>
				)}
			</GameHudSlot>
			{filterChips && !(withActs && compact) ? (
				<GameHudSlot at="top" className={filtersTop}>
					{filterChips}
				</GameHudSlot>
			) : null}
			{loading || empty ? null : (
				<>
					<GameHudSlot
						at="bottom-left"
						className={withActs ? "flex-col items-start" : undefined}
					>
						{withActs && compact ? (
							<div className="flex gap-2">{actButtons}</div>
						) : null}
						{settings.meters ? (
							<ArcadeMeters
								answers={withActs ? answersReady : undefined}
								compact={compact}
								floor={floor}
								running={withActs ? totals.working : undefined}
							/>
						) : null}
					</GameHudSlot>
					<GameHudSlot at="bottom-right">
						{/* The paytable counts legacy statuses; with acts the HUD summary does. */}
						{hudWidth >= 1100 && composerFor === null && !withActs ? (
							<ArcadePaytable floor={floor} palette={palette} />
						) : null}
						<IsoZoomControls view={isoView} />
					</GameHudSlot>
				</>
			)}
		</>
	);

	const floorView = (
		<div
			className="absolute inset-0 flex flex-col overflow-y-auto overflow-x-hidden"
			style={{
				backgroundColor: palette.carpetBase,
				backgroundImage: carpetTile(palette),
				paddingRight: sheetCover,
			}}
		>
			<ArcadeWall
				hudWidth={hudWidth}
				palette={palette}
				reduced={reduced}
				title={floor.filter?.name ?? "Arcade"}
				titleAs={withActs ? "p" : "h1"}
			/>
			<div className="relative flex flex-1 flex-col">
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
					style={{ background: palette.floorLight }}
				/>
				{filters && !loading ? (
					<div aria-hidden="true" className="h-16 shrink-0" />
				) : null}
				{loading ? (
					<div
						aria-hidden="true"
						className="relative flex flex-1 flex-wrap content-center items-end justify-center gap-x-6 gap-y-10 p-6"
					>
						{LOADING_CABINETS.map((key) => (
							<Skeleton
								className="h-[356px] w-[200px] rounded-t-[12px] rounded-b-[4px] bg-background/20"
								key={key}
							/>
						))}
					</div>
				) : null}
				{empty && floor.filter ? (
					<ArcadeEmpty
						action="Show every machine"
						body="None of its agents have a machine on the floor yet."
						marquee="NO MACHINES"
						onAction={clearFilter}
						palette={palette}
						title={`No machines in ${floor.filter.name}`}
					/>
				) : null}
				{empty && !floor.filter ? (
					<ArcadeEmpty
						action="New game"
						body="Each agent gets a slot machine here, with its three latest conversations on the reels. Start a conversation to open the floor."
						marquee="OPENING SOON"
						onAction={newGame}
						palette={palette}
						title="The floor is empty"
					/>
				) : null}
				{loading || empty ? null : (
					<div
						className="relative flex flex-1 items-center justify-center"
						style={{
							paddingBottom: compact ? 72 : HUD_BOTTOM,
							paddingInline: FLOOR_PADDING,
							paddingTop: FLOOR_TOP,
						}}
					>
						<p className="sr-only" id={hintId}>
							Tab moves between machines. Arrow keys move between a machine's
							reels, buttons, tickets and lever.
						</p>
						{fit.overflow ? (
							<div className="absolute top-1/2 left-2 z-10 -translate-y-1/2">
								<GameIconButton
									label="Walk left along the aisle"
									onClick={() => walk(-1)}
								>
									<ChevronLeft
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								</GameIconButton>
							</div>
						) : null}
						<ul
							aria-describedby={hintId}
							aria-label="Slot machines"
							className={cn(
								"flex max-w-full snap-x snap-mandatory items-end gap-x-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
								fit.overflow ? "overflow-x-auto" : "justify-center"
							)}
							ref={aisleRef}
							style={{
								width: bankWidth(fit.view),
								zoom: fit.zoom,
							}}
						>
							{floor.machines.map((machine) => {
								const act = acts.get(machine.agent.id);
								const describedBy = `${baseId}-act-${machine.id}`;
								return (
									<li className="shrink-0 snap-start pr-7" key={machine.id}>
										{cabinet(machine, fit.zoom, act ? describedBy : undefined)}
										{act ? (
											<div
												className={cn(
													GAME_PLATE,
													"mt-2 flex max-w-[200px] flex-col gap-1 p-2 text-(--gk-ink)"
												)}
											>
												<span className="sr-only" id={describedBy}>
													{act.ariaLabel}
												</span>
												<ActStatus
													act={act}
													clock={clock}
													nowMs={nowMs}
													onAsk={onAsk}
													onBlocker={onBlocker}
													snapshot={snapshot}
												/>
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
						{fit.overflow ? (
							<div className="absolute top-1/2 right-2 z-10 -translate-y-1/2">
								<GameIconButton
									label="Walk right along the aisle"
									onClick={() => walk(1)}
								>
									<ChevronRight
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								</GameIconButton>
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
	let sheet: ReactNode = null;
	if (threadOpen) {
		sheet = (
			<ArcadePanel
				headingRef={panelHeadingRef}
				machine={openMachine}
				onClose={close}
				showAge={!withActs}
				thread={openThread}
				threadView={threadView}
			/>
		);
	} else if (selectedMachine) {
		sheet = (
			<MachineSheet
				headingRef={panelHeadingRef}
				machine={selectedMachine}
				onClose={() => setSelectedId(null)}
				summary={
					withActs ? acts.get(selectedMachine.agent.id)?.ariaLabel : undefined
				}
			>
				{cabinet(selectedMachine, 1)}
			</MachineSheet>
		);
	}
	// The sheet's machine: the camera glides to its player when it opens.
	useFocusOnOpen(
		isoView,
		threadOpen ? (openMachine?.id ?? null) : (selectedMachine?.id ?? null)
	);
	const insets = {
		bottom: compact ? 72 : 96,
		left: 16,
		right: 16 + sheetCover,
		// A phone with acts stacks a two-line title, the caption and the
		// chips in one column.
		top:
			compact && withActs
				? 120 + (filters ? 56 : 0)
				: (compact ? 64 : 92) + (filters ? 56 : 0) + (withActs ? 36 : 0),
	};
	return (
		<GameShell
			accent="grape"
			busy={loading}
			data-arcade-floor=""
			data-arcade-mode={mode}
			data-arcade-paused={visible ? undefined : "true"}
			hud={hud}
			label={floor.filter ? `${floor.filter.name} floor` : "Floor"}
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={sheet}
			testId="interface-arcade"
		>
			<style>{ARCADE_KEYFRAMES}</style>
			{withActs ? (
				<>
					<h1 className="sr-only" ref={headingRef} tabIndex={-1}>
						Arcade
					</h1>
					<AskQueueList
						acts={acts}
						clock={clock}
						fallbackFocus={headingRef}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						snapshot={snapshot}
						unowned={unowned}
					/>
				</>
			) : null}
			<ReelDefs blurId={blurId} />
			<div className="absolute inset-0" ref={floorRef}>
				{loading || empty ? (
					floorView
				) : (
					<IsoStage
						bounds={{
							maxX: hall.halfWidth,
							maxZ: hall.halfDepth,
							minX: -hall.halfWidth,
							minZ: -hall.halfDepth,
							// The act signs stand over the marquees.
							top: withActs ? 3.8 : 3,
						}}
						fallback={floorView}
						fill={1.1}
						fitPlates={withActs ? ARCADE_ACT_PLATE_FIT : ARCADE_PLATE_FIT}
						insets={insets}
						label="Arcade hall: a slot machine per agent, its player beside it. Tab or the arrow keys move between players; Enter opens their machine. Drag to pan, plus and minus to zoom."
						night={night}
						reducedMotion={reduced}
						view={isoView}
					>
						{({ quality, theme }) => (
							<ArcadeDioramaScene
								acts={actView ? { onStage, view: actView } : null}
								collectable={floor.totals.jackpots}
								hall={hall}
								looks={looks}
								night={night}
								onCollect={() => {
									if (next) {
										open(next.id);
									}
								}}
								onSelect={selectMachine}
								platesAbove={portraitFloor}
								quality={quality}
								reduced={reduced}
								selectedId={selectedMachine?.id ?? null}
								shape={shape}
								skinOf={(machine) => cabinetSkin(mode, machine.skin)}
								theme={theme}
							/>
						)}
					</IsoStage>
				)}
			</div>
			{composerFor ? (
				<ArcadeComposer
					agents={composerMachine ? undefined : composerAgents}
					key={composerFor}
					machineName={composerMachine?.name}
					onClose={() => setComposerFor(null)}
					onSubmit={submit}
					reduced={reduced}
				/>
			) : null}
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{withActs ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
