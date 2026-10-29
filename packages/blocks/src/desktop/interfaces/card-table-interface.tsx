import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	clockLabel,
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { Club, Plus } from "lucide-react";
import { AnimatePresence } from "motion/react";
import {
	type CSSProperties,
	cloneElement,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	CardActProps,
	cardOverlays,
	cardPaths,
	seatHelpers,
	seatPose,
} from "./card-table-acts.tsx";
import { CardRoom, type CardRoomActors } from "./card-table-diorama.tsx";
import {
	CardTableDrawer,
	DRAWER_OVERLAY_BELOW,
	drawerWidth,
} from "./card-table-drawer.tsx";
import {
	type CardFlight,
	CardTableHand,
	EmptyHand,
	HandLabel,
	type HandLabelPlacement,
	PlayedCardFlight,
} from "./card-table-hand.tsx";
import { TableLegend } from "./card-table-legend.tsx";
import {
	type CardTableLook,
	CardTableLookContext,
} from "./card-table-look.tsx";
import {
	actCardVerdicts,
	actPotThreads,
	actSeatTone,
	type CardPose,
	dealActHand,
	dealHand,
	emptyPanelRect,
	type HandLayout,
	HOVER_LIFT,
	handLayout,
	handPose,
	handTop,
	MAX_SEATS,
	NEIGHBOUR_PART,
	nextDeal,
	PLATE_HALF,
	plural,
	poseBounds,
	poseCorners,
	potThreads,
	type SeatInfo,
	type StageSize,
	seatAgents,
	seatByActs,
	stackChips,
	type TableGeometry,
	tableGeometry,
	unseatedThreads,
} from "./card-table-model.ts";
import {
	cardRoomCloth,
	RAIL_LEATHER,
	ROOM_BACKGROUND,
	ROOM_MODE,
	ROOM_VARS,
	TABLE_SHADOW,
} from "./card-table-palette.ts";
import { ChipStack, HoleCards } from "./card-table-pieces.tsx";
import { TablePot } from "./card-table-pot.tsx";
import { CardTableRail } from "./card-table-rail.tsx";
import { ROOM_BOUNDS, ROOM_TOP, roomSeats } from "./card-table-room.ts";
import { type CardVerdicts, CardVerdictsContext } from "./card-table-rows.tsx";
import {
	EmptySeat,
	type SeatActions,
	type SeatMenuAlign,
	type SeatMenuSide,
	TableSeat,
} from "./card-table-seat.tsx";
import { CardTableSpread } from "./card-table-spread.tsx";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameTitlePlate,
} from "./game-hud.tsx";
import { GameHudSlot, GameShell } from "./game-shell.tsx";
import {
	actSummaryLine,
	actTotals,
	overlayBudget,
	stageAgents,
	toolForActivity,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	ActPlateButton,
	offStageLabel,
	offStageText,
} from "./game3d-signs.tsx";
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
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

type TableLayout = InterfaceParamsByRenderer["card-table"]["layout"];

/** Laid out at this size until the stage is measured (and in static renders). */
const DEFAULT_STAGE: StageSize = { height: 760, width: 1180 };
/** How long after mount layout moves start animating. */
const SETTLE_MS = 600;
const SEAT_SLOTS = Array.from({ length: MAX_SEATS }, (_, slot) => slot);
/** The interface's width until it is measured (and in static renders). */
const DEFAULT_ROOT_WIDTH = 1440;
/** How long seats follow the stage frame by frame while the drawer moves. */
const DRAWER_TRACK_MS = 700;
/** The rail opens as a panel only on a stage at least this wide. */
const RAIL_PANEL_MIN_STAGE = 1200;
/** The rail panel's width and inset (w-56, top-3/left-3). */
const RAIL_PANEL_WIDTH = 224;
const RAIL_INSET = 12;
/** Under this height the rail panel would be a scroll box; it folds instead. */
const RAIL_PANEL_MIN_HEIGHT = 96;
/** Gap between the fan's first card and the label beside it. */
const LABEL_GAP = 12;
const MINUTE_MS = 60_000;
/** Under this felt width the pot's pile shrinks, clear of the seats' chips. */
const NARROW_FELT = 720;
const SKELETON_CARDS = ["deal-1", "deal-2", "deal-3", "deal-4", "deal-5"];
/** The legend keeps this far from the stage's right edge, like the HUD. */
const LEGEND_INSET = 16;
/** Narrower than this the legend's lines no longer fit; it is left out. */
const LEGEND_MIN_WIDTH = 168;
/** Room the HUD's top plates take above the table. */
const HUD_TOP = "@min-[672px]/game:top-[76px] top-[64px]";
/** The same room in pixels on a wide stage, for the room's camera. */
const HUD_TOP_PX = 76;
/** With the act HUD (need-you, Queue, caption) the rail panel starts lower. */
const ACT_RAIL_TOP = 112;
/** Below this width the off-stage tally shows its count only. */
const PHONE_HUD_BELOW = 640;
/** Below this table width the HUD plates go compact. */
const COMPACT_HUD_BELOW = 900;
/** The island's rim round the card room. */
const ISLAND_RIM = 2.2;

/**
 * The stage's size, measured before paint and kept current. `settled` turns
 * true shortly after mount: the table only animates seat and felt moves from
 * then on, so it does not visibly grow from the default size (or follow the
 * host's own first layout passes) while the hand is being dealt.
 */
function useStageSize(ref: RefObject<HTMLDivElement | null>): {
	settled: boolean;
	size: StageSize;
} {
	const [size, setSize] = useState<StageSize>(DEFAULT_STAGE);
	const [settled, setSettled] = useState(false);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			const rect = element.getBoundingClientRect();
			// Detached or unlaid-out stages (tests, hidden tabs) keep the default.
			if (rect.width > 0 && rect.height > 0) {
				setSize({ height: rect.height, width: rect.width });
			}
		};
		measure();
		const timer = setTimeout(() => setSettled(true), SETTLE_MS);
		if (typeof ResizeObserver === "undefined") {
			return () => clearTimeout(timer);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			clearTimeout(timer);
			observer.disconnect();
		};
	}, [ref]);
	return { settled, size };
}

/**
 * Where an element ends below its offset parent's top (px), kept current;
 * 0 until laid out (and in static renders).
 */
function useBottomEdge(ref: RefObject<HTMLDivElement | null>, on: boolean) {
	const [bottom, setBottom] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!(on && element)) {
			setBottom(0);
			return;
		}
		const measure = () =>
			setBottom(Math.ceil(element.offsetTop + element.offsetHeight));
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [on, ref]);
	return bottom;
}

/** The time, refreshed every minute so ages and timers move on their own. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/**
 * An element's width, kept current. `ready` turns true one frame after the
 * first real measurement, so layout that depends on it can jump into place on
 * mount and only animate the changes that follow.
 */
function useElementWidth(
	ref: RefObject<HTMLDivElement | null>,
	fallback: number
): { ready: boolean; width: number } {
	const [width, setWidth] = useState(fallback);
	const [measured, setMeasured] = useState(false);
	const [ready, setReady] = useState(false);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			const next = element.getBoundingClientRect().width;
			if (next > 0) {
				setWidth(next);
				setMeasured(true);
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
	useEffect(() => {
		if (!measured || ready) {
			return;
		}
		const frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, [measured, ready]);
	return { ready, width };
}

/**
 * True for a moment after the drawer opens or closes. The stage then resizes
 * every frame with the drawer, and seats follow it directly instead of easing
 * after it (an eased seat lags, and can slip off the shrinking stage).
 */
function useDrawerTracking(panelOpen: boolean): boolean {
	const [tracking, setTracking] = useState(false);
	const previous = useRef(panelOpen);
	useEffect(() => {
		if (previous.current === panelOpen) {
			return;
		}
		previous.current = panelOpen;
		setTracking(true);
		const timer = setTimeout(() => setTracking(false), DRAWER_TRACK_MS);
		return () => clearTimeout(timer);
	}, [panelOpen]);
	return tracking;
}

/** Escape and arrows inside a text field belong to the field. */
function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

function SeatSkeleton({ compact }: { compact: boolean }) {
	if (compact) {
		return (
			<div className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-card/90 px-2 py-2 shadow-sm">
				<Skeleton className="size-8" radius="pill" />
				<Skeleton className="h-2 w-10" radius="pill" />
			</div>
		);
	}
	return (
		<div className="flex w-[200px] items-center gap-2.5 rounded-2xl border border-border bg-card/90 py-2 ps-2 pe-3 shadow-sm">
			<Skeleton className="size-10 shrink-0" radius="pill" />
			<div className="flex flex-1 flex-col gap-1.5">
				<Skeleton className="h-2.5 w-16" radius="pill" />
				<Skeleton className="h-2 w-12" radius="pill" />
			</div>
		</div>
	);
}

function HandSkeleton({
	geometry,
	stage,
}: {
	geometry: TableGeometry;
	stage: StageSize;
}) {
	return (
		<div aria-hidden="true" className="absolute inset-0 z-20">
			{SKELETON_CARDS.map((key, index) => {
				const pose = handPose({
					count: SKELETON_CARDS.length,
					geometry,
					index,
					lifted: null,
					stage,
				});
				return (
					<Skeleton
						className="absolute top-0 left-0 rounded-xl border border-border bg-card"
						key={key}
						radius="panel"
						style={{
							height: geometry.card.height,
							transform: `translate(${pose.x}px, ${pose.y}px) rotate(${pose.rotate}deg)`,
							transformOrigin: "50% 135%",
							width: geometry.card.width,
						}}
					/>
				);
			})}
		</div>
	);
}

function SeatChips({
	compact,
	point,
	seat,
	slot,
}: {
	compact: boolean;
	point: { x: number; y: number };
	seat: SeatInfo;
	slot: number;
}) {
	const count = seat.threads.length;
	if (count === 0) {
		return null;
	}
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute z-[5] flex -translate-x-1/2 -translate-y-1/2 items-end gap-2 group-data-settled/stage:transition-[left,top] group-data-settled/stage:duration-300 group-data-settled/stage:ease-out motion-reduce:transition-none"
			data-chips={seat.agent.id}
			style={{ left: point.x, top: point.y }}
		>
			{seat.agentTurn > 0 ? <HoleCards width={compact ? 22 : 30} /> : null}
			<ChipStack
				chips={stackChips(count)}
				colorIndex={slot}
				size={compact ? 22 : 32}
			/>
		</div>
	);
}

/**
 * Where the rail goes: a panel in the top-left corner when agents wait on it,
 * the stage is wide, and the panel can stop above the seats under it;
 * otherwise a pill.
 */
function railFit(
	geometry: TableGeometry,
	stage: StageSize,
	railAgents: number,
	top = RAIL_INSET
): { collapsed: boolean; maxHeight: number } {
	// Agentless threads alone are a short list: a pill, not a panel.
	if (
		railAgents === 0 ||
		geometry.compact ||
		stage.width < RAIL_PANEL_MIN_STAGE
	) {
		return { collapsed: true, maxHeight: 0 };
	}
	const panelRight = RAIL_INSET + RAIL_PANEL_WIDTH + RAIL_INSET;
	let bottom = stage.height - RAIL_INSET;
	for (const seat of geometry.seats) {
		if (seat.x - PLATE_HALF.width < panelRight) {
			bottom = Math.min(bottom, seat.y - PLATE_HALF.height - RAIL_INSET);
		}
	}
	// Measured from where the panel starts (below the act HUD, with acts).
	const maxHeight = bottom - top;
	return { collapsed: maxHeight < RAIL_PANEL_MIN_HEIGHT, maxHeight };
}

/** The pot's chip size: smaller on a narrow felt, smallest on a phone. */
function potChipSize(geometry: TableGeometry): number {
	if (geometry.compact) {
		return 22;
	}
	return geometry.felt.width < NARROW_FELT ? 27 : 34;
}

/**
 * Which way a seat's menu opens: the top chairs drop it toward the felt; the
 * side and bottom chairs open it sideways, toward the middle of the table, so
 * it never covers the chair below or the hand. Bottom chairs grow it upward.
 */
function seatMenuPlacement(
	slot: number,
	point: { x: number; y: number },
	stage: StageSize
): { align: SeatMenuAlign; side: SeatMenuSide } {
	if (slot < 2) {
		return { align: "center", side: "bottom" };
	}
	const side = point.x > stage.width / 2 ? "left" : "right";
	return { align: slot >= 4 ? "end" : "center", side };
}

/** Where the hand's label sits: beside the fan if the layout left room. */
function labelPlacement(
	layout: HandLayout,
	geometry: TableGeometry,
	stage: StageSize
): HandLabelPlacement {
	const first = handPose({
		count: layout.dealt,
		geometry,
		index: 0,
		lifted: null,
		spread: layout.spread,
		stage,
	});
	if (layout.labelBeside) {
		// The first card's tilted corner reaches a little past its box, and it
		// moves further left when its neighbour lifts and the cards part.
		const [topLeft] = poseCorners(first, geometry.card);
		const bounds = poseBounds(first, geometry.card);
		const fanLeft = bounds.x - geometry.card.width * NEIGHBOUR_PART;
		return {
			kind: "beside",
			right: Math.max(LABEL_GAP, stage.width - fanLeft + LABEL_GAP),
			// Level with the first card's top corner, so the label reads as the
			// hand's heading rather than a caption floating beside it.
			top: (topLeft?.y ?? first.y) + 2,
		};
	}
	// Clear of the middle card even when it lifts, so the caption never hides.
	const top = handTop(layout.dealt, geometry, stage, layout.spread);
	return {
		bottom: stage.height - top + HOVER_LIFT + 6,
		centerX: stage.width / 2,
		kind: "above",
	};
}

/**
 * Card Table: your agents seated around a felt table in a card room, on the
 * shared game kits (game-shell.tsx, game3d-stage.tsx): the room is a 3D
 * diorama (card-table-diorama.tsx) under the hand. Working agents take the
 * first chairs (each with an action timer), chips in front of a seat count its
 * threads, the pot in the middle holds every live run, and the threads waiting
 * on you are dealt to you as a hand of cards. Playing a card opens the host's
 * real conversation in a drawer while the table stays in view; a seat's menu
 * deals a new thread with that agent.
 */
/** Phones frame the room tight on its seat plates: little rim around them. */
const PHONE_ROOM_FIT = { above: 0.9, below: 1.6, max: 2.2, side: 0.4 };

/** How much of a card's height a phone's tucked hand shows over the edge. */
const HAND_PEEK = 0.46;

/** The table's contexts: its look (felt, deck) and the acts' card verdicts. */
function CardTableProviders({
	children,
	look,
	verdicts,
}: {
	children: ReactNode;
	look: CardTableLook;
	verdicts: CardVerdicts | null;
}) {
	return (
		<CardTableLookContext.Provider value={look}>
			<CardVerdictsContext.Provider value={verdicts}>
				{children}
			</CardVerdictsContext.Provider>
		</CardTableLookContext.Provider>
	);
}

type CardTableSettings = Required<InterfaceParamsByRenderer["card-table"]>;

/** The Card Table's own settings, resolved from its live params. */
export function cardTableSettings(
	params: InterfaceParamsByRenderer["card-table"] | undefined
): CardTableSettings {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("card-table", params) as CardTableSettings;
}

export function CardTableInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["card-table"]>) {
	const settings = cardTableSettings(params);
	const kitSettings = useGameKitSettings();
	// The Table/Cards switch keeps its choice (a setting), live from Settings.
	const [layout, setLayout] = useInterfaceSetting<TableLayout>(
		port,
		"layout",
		settings.layout
	);
	const { deck, felt } = settings;
	const look = useMemo(() => ({ deck, felt }), [deck, felt]);
	const cloth = useMemo(() => cardRoomCloth(felt, deck), [deck, felt]);
	const isSpread = layout === "spread";
	const stageRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	// Focusing a card of the tucked fan (below the edge) must not scroll
	// the clipped game frame: put any such scroll straight back.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const settle = (event: Event) => {
			const target = event.target;
			// Only clipped frames (overflow hidden); real scrollers keep scrolling.
			if (
				target instanceof HTMLElement &&
				root.contains(target) &&
				target.scrollTop !== 0 &&
				getComputedStyle(target).overflowY === "hidden"
			) {
				target.scrollTop = 0;
			}
		};
		root.addEventListener("scroll", settle, { capture: true });
		return () => root.removeEventListener("scroll", settle, { capture: true });
	}, []);
	const cardRefs = useRef(new Map<string, HTMLButtonElement>());
	const closingRef = useRef(false);
	const reduceMotion = useReducedMotion();
	const { settled, size: stage } = useStageSize(stageRef);
	const { ready: rootReady, width: rootWidth } = useElementWidth(
		rootRef,
		DEFAULT_ROOT_WIDTH
	);
	const geometry = useMemo(() => tableGeometry(stage), [stage]);
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const shape = useMemo(
		() =>
			islandFor(
				ROOM_BOUNDS.maxX - ROOM_BOUNDS.minX,
				ROOM_BOUNDS.maxZ - ROOM_BOUNDS.minZ,
				ISLAND_RIM
			),
		[]
	);
	const actsView = useActs(snapshot);
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const headingRef = useRef<HTMLHeadingElement>(null);
	// The act HUD (need you, queue, caption): the Cards layout starts below it.
	const actHudRef = useRef<HTMLDivElement>(null);
	const actHudBottom = useBottomEdge(actHudRef, actsOn && isSpread && !loading);
	// With acts the chairs go to the most urgent acts (stageAgents), never
	// the working-first sort, so a failure or an ask is never railed.
	const staged = useMemo(() => stageAgents(acts, MAX_SEATS), [acts]);
	const stageOrder = useMemo(
		() =>
			stageAgents(acts, Number.POSITIVE_INFINITY).onStage.map(
				(act) => act.agentId
			),
		[acts]
	);
	const { rail, seated } = useMemo(
		() =>
			actsOn
				? seatByActs(
						snapshot,
						stageOrder.slice(0, MAX_SEATS),
						stageOrder.slice(MAX_SEATS)
					)
				: seatAgents(snapshot),
		[actsOn, snapshot, stageOrder]
	);
	// With acts the cards read the acts: what is in your hand, each card's
	// suit and words, the pot (the working agents' threads).
	const verdicts = useMemo(
		() => (actsOn ? actCardVerdicts(snapshot, acts) : null),
		[acts, actsOn, snapshot]
	);
	const verdictContext = useMemo(
		() => (verdicts ? { nowMs, verdicts } : null),
		[nowMs, verdicts]
	);
	const hand = useMemo(
		() => (verdicts ? dealActHand(snapshot, verdicts) : dealHand(snapshot)),
		[snapshot, verdicts]
	);
	const running = useMemo(
		() => (actsOn ? actPotThreads(snapshot, acts) : potThreads(snapshot)),
		[acts, actsOn, snapshot]
	);
	const unseated = useMemo(() => unseatedThreads(snapshot), [snapshot]);
	const [cursorId, setCursorId] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [flight, setFlight] = useState<CardFlight | null>(null);
	const now = useMinuteClock();
	const next = nextDeal(snapshot.events, actsOn ? nowMs : now);
	const panelOpen = threadView !== null;
	const tracking = useDrawerTracking(panelOpen);
	const overlay = rootWidth < DRAWER_OVERLAY_BELOW;
	const drawer = overlay ? rootWidth : drawerWidth(rootWidth);
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	// With acts the drawer's avatar rings from its lead agent's act.
	const leadId = activeThread?.agentIds[0];
	const leadAct = actsOn && leadId ? acts.get(leadId) : undefined;
	const isEmpty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;

	// The fan deals as many cards as stay readable; the rest are held back.
	const fan = handLayout(hand.cards.length, geometry, stage);
	const dealt = hand.cards.slice(0, fan.dealt);
	const heldThreads = useMemo(
		() => [...hand.cards.slice(fan.dealt), ...hand.heldThreads],
		[hand, fan.dealt]
	);
	const held = heldThreads.length;
	const railLayout = railFit(
		geometry,
		stage,
		rail.length,
		actsOn ? ACT_RAIL_TOP : RAIL_INSET
	);
	const agentIds = useMemo(() => seated.map((seat) => seat.agent.id), [seated]);
	const { looks } = useVillagerLooks(agentIds, night);
	// Phones tuck the hand into a compact fan that peeks over the bottom
	// edge (rank, suit and status of every card); a tap opens it.
	const [handOpen, setHandOpen] = useState(false);
	const openTop = handTop(fan.dealt, geometry, stage, fan.spread);
	const handTuck =
		geometry.compact && dealt.length > 0
			? Math.max(
					0,
					Math.round(stage.height - geometry.card.height * HAND_PEEK - openTop)
				)
			: 0;
	const tucked = handOpen ? 0 : handTuck;
	// The room fits above the hand (or the empty hand's note), framed above
	// the tucked fan on phones so opening it never moves the camera.
	const handEdge = dealt.length > 0 ? openTop + handTuck : stage.height - 72;
	const insets = useMemo(
		() => ({
			// Phones lift the room under the HUD (it is framed by its width,
			// so the extra room below only moves it up).
			bottom:
				Math.max(24, stage.height - handEdge + 8) +
				(geometry.compact ? Math.round(stage.height * 0.16) : 0),
			left: 16,
			right: 16,
			// The act HUD adds a row of buttons and the blind-spot caption.
			top: HUD_TOP_PX + 8 + (actsOn ? 64 : 0),
		}),
		[actsOn, geometry.compact, handEdge, stage.height]
	);
	const handLabel = labelPlacement(fan, geometry, stage);

	const open = (threadId: string) => {
		const thread = snapshot.threads.find((item) => item.id === threadId);
		setAnnouncement(`Opened ${thread?.title.trim() || "thread"}`);
		port.openThread(threadId);
	};
	const play = (threadId: string, pose: CardPose) => {
		setHandOpen(false);
		const thread = snapshot.threads.find((item) => item.id === threadId);
		const stageElement = stageRef.current;
		if (thread && stageElement && !reduceMotion) {
			const left = stageElement.offsetLeft;
			const top = stageElement.offsetTop;
			// Toward the drawer's edge (or the middle, when it covers the table).
			const edge = overlay ? rootWidth / 2 : rootWidth - drawer;
			setFlight({
				from: { ...pose, x: pose.x + left, y: pose.y + top },
				thread,
				to: {
					x: edge - geometry.card.width * 0.35,
					y: top + pose.y - geometry.card.height * 0.9,
				},
			});
		}
		open(threadId);
	};
	const deal = (agentId?: string) => {
		port.startThread(agentId ? { agentId } : {});
	};
	const close = () => {
		closingRef.current = true;
		port.closeThread();
	};

	const actions: SeatActions = {
		activeThreadId,
		now,
		onDeal: deal,
		onOpen: open,
		snapshot,
	};

	// Closing the drawer takes away whatever had focus inside it (it is still
	// sliding out); put focus back on the card that was in play (or the hand)
	// instead of leaving it in a closing drawer or dropping it to <body>.
	useLayoutEffect(() => {
		if (panelOpen || !closingRef.current) {
			return;
		}
		closingRef.current = false;
		const active = document.activeElement;
		if (
			active &&
			active !== document.body &&
			rootRef.current?.contains(active) &&
			!active.closest("[data-card-table-drawer]")
		) {
			return;
		}
		const target =
			(cursorId ? cardRefs.current.get(cursorId) : undefined) ??
			cardRefs.current.values().next().value;
		target?.focus();
	}, [panelOpen, cursorId]);

	// Keys with nothing focused (after a click on the felt) still reach the
	// table: arrows pick up the hand, Escape closes the open thread. The
	// handler reads the latest hand; the listener is added once.
	const onDocumentKeyDown = useEffectEvent(
		(event: globalThis.KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.target !== document.body ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			if (event.key === "Escape" && panelOpen) {
				event.preventDefault();
				close();
				return;
			}
			if (
				isSpread ||
				(event.key !== "ArrowLeft" && event.key !== "ArrowRight")
			) {
				return;
			}
			if (dealt.length === 0) {
				return;
			}
			event.preventDefault();
			const current = dealt.findIndex(
				(thread) => thread.id === (cursorId ?? activeThreadId)
			);
			let index = current;
			if (current === -1) {
				index = event.key === "ArrowLeft" ? dealt.length - 1 : 0;
			} else {
				index = Math.min(
					dealt.length - 1,
					Math.max(0, current + (event.key === "ArrowLeft" ? -1 : 1))
				);
			}
			const target = dealt[index];
			if (target) {
				setCursorId(target.id);
				cardRefs.current.get(target.id)?.focus();
			}
		}
	);
	useEffect(() => {
		const listener = (event: globalThis.KeyboardEvent) =>
			onDocumentKeyDown(event);
		document.addEventListener("keydown", listener);
		return () => document.removeEventListener("keydown", listener);
	}, []);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			panelOpen &&
			!event.defaultPrevented &&
			!isEditable(event.target)
		) {
			event.preventDefault();
			close();
		}
	};

	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const totals = actTotals(snapshot, acts);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				staged.onStage.map((act) => act.agentId)
			),
		[acts, staged, unowned]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(stage.width, { domTargets: true });
	const shownKey = [
		...budget.fill(
			cardOverlays(staged.onStage, slots, staged.offStage, reduceMotion).filter(
				(item) => keepsActOverlay(item, kitSettings)
			)
		),
	]
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const roomPlaces = useMemo(() => roomSeats(), []);
	const actPaths = useMemo(
		() => cardPaths(roomPlaces, budget.narrow),
		[budget.narrow, roomPlaces]
	);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actStatus = (agentId: string) => {
		const act = acts.get(agentId);
		return act ? (
			<ActStatus
				act={act}
				clock={clock}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				snapshot={snapshot}
			/>
		) : null;
	};
	/** A seat's act: its plate's words and what activating it does. */
	const seatAct = (agentId: string, scene: boolean) => {
		const act = acts.get(agentId);
		if (!(actsOn && act)) {
			return undefined;
		}
		const ask = act.act === "asking" ? act.ask : null;
		return {
			answer: ask
				? (opener: HTMLElement) => cards.openAsk(ask.id, opener)
				: null,
			iconOnly: scene && budget.iconOnly,
			scene,
			sentence: act.ariaLabel,
			status: scene ? undefined : actStatus(agentId),
			tone: actSeatTone(act),
		};
	};
	const railActs = actsOn
		? {
				answer: (agentId: string) => {
					const ask = acts.get(agentId)?.ask;
					return acts.get(agentId)?.act === "asking" && ask
						? (opener: HTMLElement) => cards.openAsk(ask.id, opener)
						: null;
				},
				sentence: (agentId: string) => acts.get(agentId)?.ariaLabel ?? null,
				status: actStatus,
				tone: (agentId: string) => {
					const act = acts.get(agentId);
					return act ? actSeatTone(act) : "idle";
				},
			}
		: undefined;
	const roomActors: CardRoomActors | undefined = actsOn
		? {
				helpers: seated.flatMap((seat, slot) => {
					const act = acts.get(seat.agent.id);
					const look = looks.get(seat.agent.id);
					const place = roomPlaces[slot];
					return act && look && place ? seatHelpers(act, look, place) : [];
				}),
				poses: new Map(
					seated.flatMap((seat) => {
						const act = acts.get(seat.agent.id);
						return act
							? [
									[
										seat.agent.id,
										{
											pose: seatPose(act),
											tool:
												act.act === "working"
													? toolForActivity(act.carry)
													: undefined,
										},
									] as const,
								]
							: [];
					})
				),
				props: (
					<CardActProps
						clock={clock}
						dealer={next !== undefined}
						iconOnly={budget.iconOnly}
						narrow={budget.narrow}
						nowMs={nowMs}
						offStage={staged.offStage}
						onAsk={(askId, opener) => cards.openAsk(askId, opener)}
						onBlocker={(threadId, agentName) =>
							cards.openBlocker(threadId, agentName)
						}
						onQueue={() => openQueue(queueOpener)}
						onStage={staged.onStage}
						owners={owners}
						paths={actPaths}
						reduced={reduceMotion}
						seated={seated.flatMap((seat, slot) => {
							const act = acts.get(seat.agent.id);
							const place = roomPlaces[slot];
							return act && place ? [{ act, seat: place }] : [];
						})}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
					/>
				),
			}
		: undefined;
	const agentCount = snapshot.agents.length;
	const yours = hand.cards.length + hand.held;
	let summary = loading
		? "Dealing…"
		: [
				plural(agentCount, "agent"),
				`${running.length} running`,
				`${yours} waiting on you`,
			].join(" · ");
	if (actsOn && !loading) {
		summary = actSummaryLine(totals);
	}

	const compactHud =
		rootWidth - (panelOpen && !overlay ? drawer : 0) < COMPACT_HUD_BELOW;
	const hud = (
		<div className="pointer-events-none absolute inset-0 z-30">
			<h1
				className="sr-only"
				ref={headingRef}
				tabIndex={actsOn ? -1 : undefined}
			>
				Card Table
			</h1>
			{actsOn && !loading ? null : (
				<p className="sr-only @min-[560px]/game:hidden">{summary}</p>
			)}
			<GameHudSlot at="top-left" className="min-w-0 max-w-[calc(100%-9rem)]">
				{/* A phone keeps its top row for the table's controls: the title
				    shrinks to its icon (the name stays for screen readers). */}
				<span
					aria-hidden="true"
					className="pointer-events-auto grid @min-[560px]/game:hidden size-12 place-items-center rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) shadow-(--gk-lip)"
					title="Card Table"
				>
					<span className="grid size-8 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink) [&_svg]:size-5">
						<Club />
					</span>
				</span>
				<div className="@max-[559px]/game:hidden min-w-0">
					<GameTitlePlate
						compact={compactHud}
						icon={<Club aria-hidden="true" />}
						keepStatus={actsOn}
						status={<span data-testid="card-table-summary">{summary}</span>}
						title="Card Table"
					/>
				</div>
			</GameHudSlot>
			{actsOn && !loading ? (
				<div
					className={cn(
						"absolute left-0 flex max-w-full flex-col items-start @min-[672px]/game:gap-3 gap-2 @min-[672px]/game:px-4 px-2.5 @min-[672px]/game:pt-2 pt-1",
						HUD_TOP
					)}
					ref={actHudRef}
				>
					{/* Phones hide the title plate: its summary shows here. */}
					<p
						className="pointer-events-auto @min-[560px]/game:hidden max-w-full truncate rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2.5 py-0.5 font-semibold text-(--gk-ink) text-[12px] shadow-[0_2px_0_var(--gk-edge)]"
						data-testid="card-table-summary-phone"
					>
						{summary}
					</p>
					<div className="pointer-events-auto flex flex-wrap items-center gap-2">
						<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
						<QueueButton
							acts={acts}
							clock={clock}
							narrow={budget.narrow}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							openRef={queueOpener}
							snapshot={snapshot}
							totals={totals}
							unowned={unowned}
						/>
						{staged.offStage.count > 0 && shown.has("tally:off") ? (
							// The agents off the table, beside the queue: visible and
							// tappable whether the rail is a panel or folded.
							<ActPlateButton
								budgeted="tally"
								focusable
								kind="tally"
								label={offStageLabel(staged.offStage.count)}
								onActivate={() => openQueue(queueOpener)}
								tally="off"
							>
								{budget.narrow || rootWidth < PHONE_HUD_BELOW
									? `+${staged.offStage.count}`
									: offStageText(staged.offStage)}
							</ActPlateButton>
						) : null}
					</div>
					<span className="pointer-events-auto">
						<BlindSpotCaption snapshot={snapshot} />
					</span>
				</div>
			) : null}
			<GameHudSlot at="top-right" className="items-center">
				{!(loading || isSpread) && railLayout.collapsed ? (
					<span className="pointer-events-auto">
						<CardTableRail
							actions={actions}
							acts={railActs}
							collapsed
							seats={rail}
							unseated={unseated}
						/>
					</span>
				) : null}
				<div
					aria-label="Lay out as"
					className={cn(
						GAME_PLATE,
						"pointer-events-auto flex h-12 items-center gap-1 p-1"
					)}
					role="group"
				>
					{(
						[
							["poker", "Table"],
							["spread", "Cards"],
						] as const
					).map(([value, name]) => (
						<button
							aria-pressed={layout === value}
							className={cn(
								"gk-display h-full rounded-[11px] px-3.5 text-[15px] transition-colors",
								GAME_FOCUS,
								layout === value
									? "bg-(--gk-accent) text-(--gk-accent-ink)"
									: "text-(--gk-ink-muted) hover:bg-(--gk-plate-sunk) hover:text-(--gk-ink)"
							)}
							key={value}
							onClick={() => setLayout(value)}
							type="button"
						>
							{name}
						</button>
					))}
				</div>
				<GameAction
					compact={compactHud}
					disabled={loading}
					icon={<Plus aria-hidden="true" strokeWidth={3} />}
					label="Deal a thread"
					onClick={() => deal()}
				/>
			</GameHudSlot>
		</div>
	);

	const pot =
		isEmpty || loading ? null : (
			<TablePot
				activeThreadId={activeThreadId}
				actNext={
					actsOn
						? next
							? clockLabel(next.start, nowMs, clock)
							: null
						: undefined
				}
				compact={geometry.compact}
				next={next}
				now={now}
				onOpen={open}
				pileSize={potChipSize(geometry)}
				running={running}
				snapshot={snapshot}
				word={actsOn ? "working" : undefined}
			/>
		);
	// With acts the room's felt holds the chips; its plate is the pot's
	// count and the dealer button only, clear of the queue at your seat.
	const roomPot = pot && actsOn ? cloneElement(pot, { pile: false }) : pot;
	const chairPlate = (slot: number, compact: boolean, nameplate = false) => {
		const seat = seated[slot];
		const point = geometry.seats[slot];
		const placement = point
			? seatMenuPlacement(slot, point, stage)
			: ({ align: "center", side: "bottom" } as const);
		if (seat) {
			return (
				<TableSeat
					act={seatAct(seat.agent.id, nameplate)}
					actions={actions}
					align={placement.align}
					compact={compact}
					nameplate={nameplate}
					seat={seat}
					side={placement.side}
				/>
			);
		}
		return (
			<EmptySeat
				align={placement.align}
				compact={compact}
				onDeal={() => deal()}
				side={placement.side}
			/>
		);
	};
	// Without WebGL (and in tests) the table is laid flat: an oval of felt,
	// the pot in its middle, chips before each seat and the seats round it.
	const table = (
		<>
			<div
				aria-hidden="true"
				className="absolute rounded-[50%] border-(--gk-edge)/30 border-[10px] bg-(--gk-plate-sunk)"
				data-testid="card-table-felt"
				style={{
					height: geometry.felt.height,
					left: geometry.felt.x,
					top: geometry.felt.y,
					width: geometry.felt.width,
				}}
			/>
			<div
				className="absolute flex items-center justify-center"
				style={{
					height: geometry.felt.height,
					left: geometry.felt.x,
					top: geometry.felt.y,
					width: geometry.felt.width,
				}}
			>
				{pot}
			</div>
			{/* With acts a seat's progress and marks say it; no chip per thread. */}
			{(actsOn ? [] : seated).map((seat, slot) => {
				const point = geometry.chips[slot];
				return point ? (
					<SeatChips
						compact={geometry.compact}
						key={seat.agent.id}
						point={point}
						seat={seat}
						slot={slot}
					/>
				) : null;
			})}
			<ul aria-label="Seats" className="pointer-events-none absolute inset-0">
				{SEAT_SLOTS.map((slot) => {
					const point = geometry.seats[slot];
					if (!point) {
						return null;
					}
					const seat = seated[slot];
					return (
						<li
							className="pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-1/2 group-data-settled/stage:transition-[left,top] group-data-settled/stage:duration-300 group-data-settled/stage:ease-out motion-reduce:transition-none"
							data-slot-index={slot}
							key={seat ? seat.agent.id : `slot-${slot}`}
							style={{ left: point.x, top: point.y }}
						>
							{chairPlate(slot, geometry.compact)}
						</li>
					);
				})}
			</ul>
		</>
	);

	return (
		<GameShell
			accent="leaf"
			busy={loading}
			label="Card Table"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			testId="interface-card-table"
		>
			<CardTableProviders look={look} verdicts={verdictContext}>
				<div
					className={cn("absolute inset-0 flex", ROOM_MODE)}
					style={{ ...ROOM_VARS, backgroundImage: ROOM_BACKGROUND }}
				>
					<section
						aria-label="Card Table"
						className="relative flex min-h-0 min-w-0 flex-1 flex-col"
					>
						{hud}
						{actsOn && !loading ? (
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
						) : null}
						{isSpread ? (
							// The spread is laid on felt inside the table's leather rail.
							<div
								className={cn(
									"absolute inset-x-0 bottom-0 @max-[671px]/game:mx-1.5 mx-3 @max-[671px]/game:mb-1.5 mb-3 flex flex-col rounded-[32px] @max-[671px]/game:p-1.5 p-2.5 shadow-(--ct-rail-shadow)",
									HUD_TOP
								)}
								style={
									{
										background: RAIL_LEATHER,
										"--ct-rail-shadow": TABLE_SHADOW,
										...(actHudBottom > 0 ? { top: actHudBottom + 8 } : {}),
									} as CSSProperties
								}
							>
								<CardTableSpread
									actions={{
										activeThreadId,
										now,
										onDeal: deal,
										onOpen: open,
										snapshot,
									}}
									acts={
										actsOn
											? {
													act: (agentId: string) => acts.get(agentId),
													answer: railActs?.answer ?? (() => null),
													status: actStatus,
													tone: (agentId: string) => {
														const act = acts.get(agentId);
														return act ? actSeatTone(act) : "idle";
													},
												}
											: undefined
									}
									isEmpty={isEmpty}
									key="spread"
									loading={loading}
									panelOpen={panelOpen}
								/>
							</div>
						) : (
							<div
								aria-busy={loading}
								className={cn(
									// The room's canvas runs up under the HUD, so this does not clip.
									"group/stage absolute inset-x-0 bottom-0",
									HUD_TOP
								)}
								data-compact={geometry.compact ? "" : undefined}
								data-settled={settled && !tracking ? "" : undefined}
								ref={stageRef}
							>
								{/* The hand comes first in reading and tab order: it is what you
				    act on. It is positioned, so this does not move it. */}
								{loading ? (
									<HandSkeleton geometry={geometry} stage={stage} />
								) : null}
								{!loading && dealt.length > 0 ? (
									<>
										<CardTableHand
											activeThreadId={activeThreadId}
											cardRefs={cardRefs}
											cards={dealt}
											cursorId={cursorId}
											geometry={geometry}
											held={held}
											layout={fan}
											now={now}
											onCursor={setCursorId}
											onPlay={play}
											onTuck={handTuck > 0 ? setHandOpen : undefined}
											snapshot={snapshot}
											stage={stage}
											tucked={tucked}
										/>
										<HandLabel
											actions={actions}
											acts={actsOn}
											count={dealt.length}
											heldThreads={heldThreads}
											placement={handLabel}
											tucked={tucked}
										/>
										{/* Mirrors the hand's label, inside the HUD's 16px inset. */}
										{handLabel.kind === "beside" &&
										stage.width - handLabel.right - LEGEND_INSET >=
											LEGEND_MIN_WIDTH ? (
											<TableLegend
												acts={actsOn}
												left={handLabel.right}
												maxWidth={stage.width - handLabel.right - LEGEND_INSET}
												top={handLabel.top}
											/>
										) : null}
									</>
								) : null}
								{!loading && dealt.length === 0 ? (
									<EmptyHand geometry={geometry} stage={stage} />
								) : null}

								{isEmpty ? (
									<div className="absolute inset-0 z-20 flex items-center justify-center p-4">
										<div
											className="flex flex-col items-center gap-2 rounded-2xl bg-background/85 px-5 py-4 text-center shadow-[0_12px_30px_-18px] shadow-foreground/50 backdrop-blur-md"
											data-testid="card-table-empty-panel"
											style={{ width: emptyPanelRect(geometry).width }}
										>
											<p className="font-semibold text-foreground text-sm">
												Nobody is at the table yet
											</p>
											<p className="text-muted-foreground text-xs">
												Deal a thread to bring an agent in. Their runs land in
												the pot, and replies come back to you as cards.
											</p>
											<Button
												className="mt-1"
												onClick={() => deal()}
												size="sm"
												type="button"
											>
												<Plus aria-hidden="true" data-icon="inline-start" />
												Deal a thread
											</Button>
										</div>
									</div>
								) : null}
								{loading ? (
									<div
										className="absolute rounded-[50%] bg-(--gk-plate-sunk)/50"
										style={{
											height: geometry.felt.height,
											left: geometry.felt.x,
											top: geometry.felt.y,
											width: geometry.felt.width,
										}}
									>
										<Skeleton
											className="absolute top-1/2 left-1/2 h-8 w-32 -translate-x-1/2 -translate-y-1/2 bg-background/60"
											radius="pill"
										/>
									</div>
								) : null}
								{loading ? (
									<ul aria-label="Seats" className="absolute inset-0">
										{SEAT_SLOTS.map((slot) => {
											const point = geometry.seats[slot];
											return point ? (
												<li
													className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
													key={`slot-${slot}`}
													style={{ left: point.x, top: point.y }}
												>
													<SeatSkeleton compact={geometry.compact} />
												</li>
											) : null;
										})}
									</ul>
								) : (
									<div className="absolute inset-x-0 -top-[64px] @min-[672px]/game:-top-[76px] bottom-0">
										<IsoStage
											bounds={{ ...ROOM_BOUNDS, top: ROOM_TOP }}
											fallback={table}
											fitPlates={geometry.compact ? PHONE_ROOM_FIT : undefined}
											insets={insets}
											label="Card room: your agents seated round the felt table with their chips, and the pot in the middle. Tab moves between the seats and the pot; drag to pan, plus and minus to zoom."
											motes={false}
											night={night}
											reducedMotion={reduceMotion}
											view={isoView}
										>
											{({ quality, theme }) => (
												<CardRoom
													actors={roomActors}
													cloth={cloth}
													looks={looks}
													night={night}
													potPlate={roomPot}
													quality={quality}
													reducedMotion={reduceMotion}
													running={running.length}
													seated={seated}
													seatPlate={(slot) => chairPlate(slot, true, true)}
													shape={shape}
													theme={theme}
												/>
											)}
										</IsoStage>
									</div>
								)}

								{loading || isEmpty || geometry.compact ? null : (
									<div className="absolute top-3 right-3 z-30">
										<IsoZoomControls view={isoView} />
									</div>
								)}
								{loading || railLayout.collapsed ? null : (
									<CardTableRail
										actions={actions}
										acts={railActs}
										collapsed={false}
										maxHeight={railLayout.maxHeight}
										seats={rail}
										top={actsOn ? ACT_RAIL_TOP : undefined}
										unseated={unseated}
									/>
								)}
								<p aria-live="polite" className="sr-only">
									{announcement}
								</p>
							</div>
						)}
					</section>
					<AnimatePresence initial={false}>
						{panelOpen ? (
							<CardTableDrawer
								actTone={leadAct ? actSeatTone(leadAct) : undefined}
								instant={!rootReady}
								key="drawer"
								now={now}
								onClose={close}
								overlay={overlay}
								snapshot={snapshot}
								thread={activeThread}
								threadView={threadView}
								width={drawer}
							/>
						) : null}
					</AnimatePresence>
					{flight && !isSpread ? (
						<PlayedCardFlight
							flight={flight}
							geometry={geometry}
							key={flight.thread.id}
							now={now}
							onDone={() => setFlight(null)}
							snapshot={snapshot}
						/>
					) : null}
				</div>
			</CardTableProviders>
			{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
