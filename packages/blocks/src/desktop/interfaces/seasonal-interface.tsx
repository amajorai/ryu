import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
	type SeasonalParams,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, Ghost, Gift, Lamp, List, Plus } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameTitlePlate,
} from "./game-hud.tsx";
import {
	GameHudSlot,
	GameSheet,
	GameShell,
	gameSheetCover,
} from "./game-shell.tsx";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	blockerEntries,
	overlayBudget,
	youSpotSlots,
} from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	type IsoPortrait,
	IsoStage,
	IsoZoomControls,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	actVillagers,
	boardAgents,
	doorActs,
	SeasonActProps,
	seasonActPaths,
	seasonStations,
} from "./seasonal-acts.tsx";
import { type SeasonActors, SeasonDiorama } from "./seasonal-diorama.tsx";
import { GRID_SLOTS, SeasonalGrid } from "./seasonal-grid.tsx";
import {
	boardSummary,
	buildBoard,
	DOOR_COUNT,
	doorInDirection,
	doorLabel,
	doorOfThread,
	doorOrder,
	isSeason,
	type OpenedDoors,
	plural,
	readOpened,
	resolveSeason,
	SEASON_COPY,
	SEASONS,
	type Season,
	type SeasonBoard,
	type SeasonCopy,
	type SeasonDoor,
	todayDoor,
	writeOpened,
} from "./seasonal-model.ts";
import {
	BoardSkeleton,
	ComposerPanel,
	DoorRow,
	EmptyNote,
	GiftCard,
	GiftTag,
	GiftTagPanel,
	Legend,
	OverflowPanel,
} from "./seasonal-parts.tsx";
import { layoutSeasonWorld } from "./seasonal-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

/** Below this stage width the HUD plates go compact. */
const COMPACT_BELOW = 900;
/** Room the HUD's top plates take above the diorama. */
const HUD_TOP = 84;
const HUD_TOP_COMPACT = 68;
/** The extra room the act layer's HUD row (Need you, Queue) takes. */
const HUD_ACTS = 64;
/** The gap kept under the HUD's measured bottom. */
const HUD_GAP = 4;
/**
 * How much closer the camera frames the board with the act layer on (the
 * patch's cast stands in its furrows, closest together).
 */
const ACTS_FILL: Record<Season, number> = {
	advent: 1.25,
	halloween: 1.4,
	"lunar-new-year": 1.25,
};
/**
 * How each diorama frames a phone with the act layer on: a steeper look,
 * turned a little, spreads the cast down the tall screen so its plates
 * part (the village's square and the street's wires run up it).
 */
const ACT_PORTRAIT: Record<Season, IsoPortrait> = {
	advent: { pitch: 1.45, yaw: Math.PI / 4 + 0.35 },
	halloween: { pitch: 1.3, yaw: Math.PI / 4 - 0.35 },
	"lunar-new-year": { fill: 1.1, pitch: 1.45, yaw: Math.PI / 4 + 0.35 },
};
/** The island's rim round each diorama, for the woods and the shore. */
const ISLAND_RIM = 2.4;
/** The gift card's width, and its inset from the stage's edge. */
const GIFT_WIDTH = 340;
const GIFT_INSET = 16;

function useElementSize(ref: { current: HTMLElement | null }) {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const rect = element.getBoundingClientRect();
		setSize({ height: rect.height, width: rect.width });
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((records) => {
			const box = records[0]?.contentRect;
			if (box) {
				setSize({ height: box.height, width: box.width });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/**
 * How far down the stage the HUD's top-left column reaches (its measured
 * bottom, relative to the stage's top), or 0 before it is measured. The
 * column wraps at a phone width, so a fixed height would frame the
 * diorama under it.
 */
function useHudBottom(
	hudRef: { current: HTMLElement | null },
	stageRef: { current: HTMLElement | null },
	/** Changes when the stage resizes or the HUD remounts. */
	layoutKey: string
) {
	const [bottom, setBottom] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the stage resizes or the HUD remounts.
	useLayoutEffect(() => {
		const hud = hudRef.current;
		if (!hud) {
			return;
		}
		const measure = () => {
			const stageTop = stageRef.current?.getBoundingClientRect().top;
			const rect = hud.getBoundingClientRect();
			if (stageTop === undefined || rect.height === 0) {
				return;
			}
			setBottom(Math.max(0, Math.round(rect.bottom - stageTop)));
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(hud);
		return () => observer.disconnect();
	}, [hudRef, stageRef, layoutKey]);
	return bottom;
}

/** Doors this viewer has opened, kept in this browser. */
function useOpenedDoors() {
	const [opened, setOpened] = useState<OpenedDoors>({});
	useEffect(() => {
		setOpened(readOpened());
	}, []);
	const update = useCallback(
		(change: (current: OpenedDoors) => OpenedDoors) => {
			setOpened((current) => {
				const next = change(current);
				writeOpened(next);
				return next;
			});
		},
		[]
	);
	return [opened, update] as const;
}

type SidePanel = "all" | "compose" | "more" | null;

/** How often the board checks whether the local date has turned over. */
const DAY_CHECK_MS = 60_000;

/** Whether two instants fall on different local calendar dates. */
export function localDateChanged(previous: number, next: number): boolean {
	return new Date(previous).toDateString() !== new Date(next).toDateString();
}

/**
 * The current time, advanced only when the local date changes: today's door
 * and an `auto` season move on overnight without re-rendering every minute.
 * Polling (not one long timeout to midnight) survives a sleeping laptop.
 */
function useLocalDayNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => {
			const next = Date.now();
			setNow((previous) =>
				localDateChanged(previous, next) ? next : previous
			);
		}, DAY_CHECK_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/** The title plate's count line: totals, with what needs you. */
function headerSummary(board: SeasonBoard, copy: SeasonCopy): string {
	const { needsYou, threads, working } = board.totals;
	return [
		plural(threads, copy.door, copy.doors),
		needsYou > 0 ? `${needsYou} need you` : null,
		working > 0 ? `${working} working` : null,
	]
		.filter(Boolean)
		.join(" \u00b7 ");
}

/** What each diorama shows, for the stage's name. */
const DIORAMA_LABEL: Record<Season, string> = {
	advent:
		"a snowy village square round an advent house whose 24 numbered doors and windows are conversations.",
	halloween:
		"a night pumpkin patch of 24 numbered pumpkins, one per conversation.",
	"lunar-new-year":
		"a lantern festival street hung with 24 numbered lanterns, one per conversation.",
};

const SEASON_ICON: Record<Season, ReactNode> = {
	advent: <Gift aria-hidden="true" />,
	halloween: <Ghost aria-hidden="true" />,
	"lunar-new-year": <Lamp aria-hidden="true" />,
};

/** A HUD plate button (the season choice, More, All doors). */
/** The season switcher's option that follows the date (the `auto` setting). */
const FROM_TODAY = "From today's date";

const PLATE_BUTTON = cn(
	GAME_PLATE,
	GAME_FOCUS,
	"gk-display pointer-events-auto inline-flex h-12 shrink-0 items-center gap-2 px-4 text-[16px] transition-colors hover:bg-(--gk-plate-sunk) aria-pressed:bg-(--gk-plate-sunk)"
);

/**
 * Seasonal: the workspace as a seasonal board, on the shared game kits
 * (game-shell.tsx, game3d-stage.tsx): a diorama fills the interface and
 * the HUD carries the title, the season, Add and the legend. Advent is a
 * snowy village square round a big advent house with 24 numbered doors and
 * windows, Halloween a night pumpkin patch of 24 numbered pumpkins, Lunar
 * New Year a lantern festival street of 24 numbered lanterns. Each place
 * is a conversation, most urgent at the lowest numbers; opening one reveals
 * a gift card, and "Open conversation" hangs the host's conversation beside
 * the board on a gift tag.
 */
type SeasonalSettings = Required<InterfaceParamsByRenderer["seasonal"]>;

/** The Seasonal board's own settings, resolved from its live params. */
export function seasonalSettings(
	params: Partial<SeasonalParams> | undefined
): SeasonalSettings {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("seasonal", params) as SeasonalSettings;
}

export function SeasonalInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<SeasonalParams>) {
	const sceneId = `ss-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const giftId = `${sceneId}-gift`;
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const lastDoorRef = useRef<HTMLButtonElement | null>(null);
	const stage = useElementSize(stageRef);
	const reduceMotion = useReducedMotion() ?? false;
	const now = useLocalDayNow();

	const settings = seasonalSettings(params);
	const kitSettings = useGameKitSettings();
	// The season picker keeps its choice (a setting), live from Settings.
	const [seasonSetting, setSeason] = useInterfaceSetting<
		SeasonalParams["season"]
	>(port, "season", settings.season);
	const season = resolveSeason(seasonSetting, new Date(now));
	const copy = SEASON_COPY[season];
	const today = useMemo(() => todayDoor(new Date(now), season), [now, season]);

	const actsView = useActs(snapshot);
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const totals = actTotals(snapshot, acts);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const queueOpener = useRef<(() => void) | null>(null);

	const [opened, updateOpened] = useOpenedDoors();
	// With acts, a door's mark follows its agent's act and it is opened once
	// its answers are read (thread.unread), not from this browser's storage.
	const marks = useMemo(
		() => (actsOn ? doorActs(snapshot, acts) : undefined),
		[acts, actsOn, snapshot]
	);
	const board = useMemo(
		() => buildBoard(snapshot, opened, today, marks),
		[snapshot, opened, today, marks]
	);

	const [gift, setGift] = useState<number | null>(null);
	const [side, setSide] = useState<SidePanel>(null);
	const [pickedAgent, setPickedAgent] = useState<string | undefined>();

	const threadOpen = threadView !== null && threadView !== undefined;
	const panelOpen = threadOpen || side !== null;
	const compact = stage.width > 0 && stage.width < COMPACT_BELOW;
	const activeDoor = threadOpen ? doorOfThread(board, activeThreadId) : null;
	const giftDoor = gift ? (board.doors[gift - 1] ?? null) : null;
	const hudRef = useRef<HTMLDivElement>(null);
	const hudBottom = useHudBottom(
		hudRef,
		stageRef,
		`${stage.width}x${stage.height}:${actsOn}:${loading}`
	);
	// With acts, the HUD's measured bottom and a gap below it; until it is
	// measured (and without acts), the usual room.
	const hudTop =
		actsOn && hudBottom > 0
			? hudBottom + HUD_GAP
			: (compact ? HUD_TOP_COMPACT : HUD_TOP) + (actsOn ? HUD_ACTS : 0);

	// The pumpkin patch is always at night; the others follow the theme.
	const themeNight = useGameNight(rootRef);
	const night = season === "halloween" || themeNight;
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const isoView = useIsoView();
	const world = useMemo(
		() => layoutSeasonWorld(season, actsOn, today),
		[actsOn, season, today]
	);
	const shape = useMemo(
		() =>
			islandFor(
				world.bounds.maxX - world.bounds.minX,
				world.bounds.maxZ - world.bounds.minZ,
				ISLAND_RIM
			),
		[world]
	);
	// The sheet floats over the right; the diorama refits beside it (on a
	// narrow stage the sheet covers it all).
	const cover = panelOpen && stage.width > 0 ? gameSheetCover(stage.width) : 0;
	const sheetCover = cover < stage.width ? cover : 0;
	const insets = useMemo(
		() => ({
			bottom: compact ? 64 : 80,
			left: 16,
			right: 16 + sheetCover,
			top: hudTop,
		}),
		[compact, hudTop, sheetCover]
	);

	// Close the gift card when the door it belongs to changes season or empties.
	useEffect(() => {
		if (gift && !board.doors[gift - 1]?.thread) {
			setGift(null);
		}
	}, [board.doors, gift]);

	const focusDoor = useCallback((number: number) => {
		const element = stageRef.current?.querySelector<HTMLButtonElement>(
			`[data-door="${number}"]`
		);
		element?.focus();
	}, []);

	const closeGift = useCallback(() => {
		setGift(null);
		lastDoorRef.current?.focus({ preventScroll: true });
	}, []);

	const compose = useCallback(() => {
		setGift(null);
		if (threadOpen) {
			port.closeThread();
		}
		setSide("compose");
	}, [port, threadOpen]);

	const showMore = useCallback(() => {
		setGift(null);
		if (threadOpen) {
			port.closeThread();
		}
		setSide((current) => (current === "more" ? null : "more"));
	}, [port, threadOpen]);

	const showList = useCallback(() => {
		setGift(null);
		if (threadOpen) {
			port.closeThread();
		}
		setSide((current) => (current === "all" ? null : "all"));
	}, [port, threadOpen]);

	const openThread = useCallback(
		(threadId: string) => {
			setGift(null);
			setSide(null);
			port.openThread(threadId);
		},
		[port]
	);

	const activate = useCallback(
		(number: number, element: HTMLButtonElement) => {
			lastDoorRef.current = element;
			const door = board.doors[number - 1];
			const thread = door?.thread;
			if (!(door && thread)) {
				compose();
				return;
			}
			if (gift === number) {
				setGift(null);
				return;
			}
			if (!(door.opened || actsOn)) {
				updateOpened((current) => ({
					...current,
					[thread.id]: thread.updatedAt,
				}));
			}
			setGift(number);
		},
		[actsOn, board.doors, compose, gift, updateOpened]
	);

	const reclose = useCallback(() => {
		const thread = giftDoor?.thread;
		if (thread) {
			updateOpened((current) => {
				const next = { ...current };
				delete next[thread.id];
				return next;
			});
		}
		closeGift();
	}, [closeGift, giftDoor, updateOpened]);

	const onDoorKeyDown = useCallback(
		(event: KeyboardEvent<HTMLButtonElement>) => {
			const number = Number(event.currentTarget.dataset.door);
			if (event.key === "Escape" && gift) {
				event.preventDefault();
				closeGift();
				return;
			}
			// In the diorama the stage already moved focus, in door order.
			if (event.defaultPrevented) {
				return;
			}
			// On the plain grid, left and right count through the numbers and
			// up and down move a row.
			const moves: Record<string, number | null> = {
				ArrowDown: doorInDirection(GRID_SLOTS, number, "down"),
				ArrowLeft: number - 1,
				ArrowRight: number + 1,
				ArrowUp: doorInDirection(GRID_SLOTS, number, "up"),
				End: DOOR_COUNT,
				Home: 1,
			};
			const target = moves[event.key];
			if (target === undefined) {
				return;
			}
			event.preventDefault();
			if (target !== null) {
				focusDoor(Math.min(DOOR_COUNT, Math.max(1, target)));
			}
		},
		[closeGift, focusDoor, gift]
	);

	// A click anywhere outside the card and the doors puts the card away.
	useEffect(() => {
		if (!gift) {
			return;
		}
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (
				target instanceof Element &&
				(target.closest("[data-seasonal-gift]") ||
					target.closest("[data-door]"))
			) {
				return;
			}
			// A click on another control keeps the focus it moves there; a click
			// on the picture or the page hands focus back to the door.
			if (
				target instanceof Element &&
				target.closest("button, a, input, textarea, select, [tabindex]")
			) {
				setGift(null);
				return;
			}
			closeGift();
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [closeGift, gift]);

	const closePanel = useCallback(() => {
		setSide(null);
		if (threadOpen) {
			port.closeThread();
		}
	}, [port, threadOpen]);

	// The gift card sits under the HUD, clear of it.
	const giftPosition = {
		left: GIFT_INSET,
		top: actsOn ? hudTop + HUD_GAP : hudTop + 8,
		width: Math.max(240, Math.min(GIFT_WIDTH, stage.width - GIFT_INSET * 2)),
	};
	const labelOf = (door: SeasonDoor) =>
		doorLabel(door, copy, today === door.number);
	const activeNumber = activeDoor?.number ?? null;

	const composeAgent =
		snapshot.agents.find((agent) => agent.id === pickedAgent)?.id ??
		snapshot.agents[0]?.id;

	const nextNumber =
		board.totals.threads < DOOR_COUNT ? board.totals.threads + 1 : null;

	const activeThread =
		snapshot.threads.find((item) => item.id === activeThreadId) ?? null;
	// The list reads most urgent first, the order the doors were handed out in.
	const filledDoors = doorOrder(today)
		.map((number) => board.doors[number - 1])
		.filter((door): door is SeasonDoor => Boolean(door?.thread));
	const doorList = (flush: boolean) => (
		<ul
			className={cn(
				"grid pb-2",
				flush
					? "@3xl/seasonal:grid-cols-2 @7xl/seasonal:grid-cols-3 grid-cols-1 gap-x-4"
					: "grid-cols-1"
			)}
		>
			{filledDoors.map((door) =>
				door.thread ? (
					<DoorRow
						active={door.thread.id === activeThreadId && threadOpen}
						acts={actsOn}
						actWords={door.actWords}
						flush={flush}
						key={door.thread.id}
						label={labelOf(door)}
						now={now}
						number={door.number}
						onOpen={() => {
							if (door.thread) {
								openThread(door.thread.id);
							}
						}}
						snapshot={snapshot}
						thread={door.thread}
					/>
				) : null
			)}
		</ul>
	);
	let sheet: ReactNode = null;
	if (threadOpen) {
		sheet = (
			<GameSheet
				closeLabel="Close conversation"
				data-seasonal-panel=""
				label="Conversation"
				leading={activeDoor ? <GiftTag number={activeDoor.number} /> : null}
				onClose={closePanel}
				sheetKey={activeThreadId ?? "thread"}
				title={activeThread?.title || "New conversation"}
			>
				<GiftTagPanel
					acts={actsOn}
					door={activeDoor}
					headless
					now={now}
					onClose={closePanel}
					snapshot={snapshot}
					stacked={false}
					thread={activeThread}
					threadView={threadView}
				/>
			</GameSheet>
		);
	} else if (side === "compose") {
		sheet = (
			<GameSheet
				closeLabel="Cancel"
				data-seasonal-panel=""
				label={copy.add}
				leading={nextNumber ? <GiftTag number={nextNumber} /> : null}
				onClose={() => setSide(null)}
				sheetKey="compose"
				title={copy.add}
			>
				<ComposerPanel
					agents={snapshot.agents}
					copy={copy}
					headless
					nextNumber={nextNumber}
					onClose={() => setSide(null)}
					onPick={setPickedAgent}
					picked={composeAgent}
					stacked={false}
				>
					<InterfaceComposer
						agents={snapshot.agents.length > 1 ? undefined : snapshot.agents}
						defaultAgentId={composeAgent}
						label={copy.add}
						onSubmit={({ agentId, prompt }) => {
							setSide(null);
							port.startThread({ agentId, prompt });
						}}
						placeholder="What should the agent work on?"
						submitLabel="Start"
					/>
				</ComposerPanel>
			</GameSheet>
		);
	} else if (side === "more") {
		sheet = (
			<GameSheet
				closeLabel={`Close ${copy.more.toLowerCase()}`}
				data-seasonal-panel=""
				label={copy.more}
				onClose={() => setSide(null)}
				sheetKey="more"
				subtitle={plural(
					board.overflow.length,
					"conversation",
					"conversations"
				)}
				title={copy.more}
			>
				<OverflowPanel
					activeThreadId={activeThreadId}
					acts={actsOn}
					copy={copy}
					headless
					now={now}
					onClose={() => setSide(null)}
					onOpen={openThread}
					snapshot={snapshot}
					stacked={false}
					threads={board.overflow}
				/>
			</GameSheet>
		);
	} else if (side === "all") {
		sheet = (
			<GameSheet
				closeLabel={`Close all ${copy.doors}`}
				data-seasonal-panel=""
				label={`All ${copy.doors}`}
				onClose={() => setSide(null)}
				sheetKey="all"
				subtitle={
					actsOn
						? `${plural(board.totals.threads, copy.door, copy.doors)} · ${actSummaryLine(totals)}`
						: boardSummary(board, copy)
				}
				title={`All ${copy.doors}`}
			>
				<div className="min-h-0 flex-1 overflow-y-auto">{doorList(false)}</div>
			</GameSheet>
		);
	}

	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});

	// The diorama's own width: an open sheet covers the rest.
	const budget = overlayBudget(Math.max(0, stage.width - sheetCover), {
		domTargets: true,
	});
	const narrow = budget.iconOnly;
	const stations = useMemo(
		() =>
			actsOn ? seasonStations(season, world, board.doors, acts, narrow) : [],
		[acts, actsOn, board.doors, narrow, season, world]
	);
	const { offStage, onStage } = useMemo(
		() => boardAgents(acts, stations),
		[acts, stations]
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
	const owners = useMemo(() => askOwners(acts), [acts]);
	const shownKey = [
		...budget.fill(
			actOverlays(
				onStage,
				slots,
				offStage,
				onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
			).filter(
				// On a phone only the focus agent's work bubble shows: the
				// others' words stay in their rows (as under reduced motion).
				(item) =>
					!(budget.iconOnly && item.kind === "work-bubble" && !item.focus) &&
					keepsActOverlay(item, kitSettings)
			)
		),
	]
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const actPaths = useMemo(
		() => seasonActPaths(season, stations),
		[season, stations]
	);
	const openAsk = cards.openAsk;
	const cast = useMemo(
		() =>
			actVillagers({
				acts,
				looks,
				nowMs,
				onAsk: (askId) => openAsk(askId),
				paths: actPaths,
				reduced: reduceMotion,
				season,
				shown,
				slots: slots.slots,
				stations,
			}),
		[
			acts,
			actPaths,
			looks,
			nowMs,
			openAsk,
			reduceMotion,
			season,
			shown,
			slots,
			stations,
		]
	);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const stoppedPlaces = actsOn
		? blockerEntries(snapshot, acts).flatMap((entry) => {
				const number = board.doors.find(
					(door) => door.thread?.id === entry.threadId
				)?.number;
				const place = world.doors.find((item) => item.number === number);
				return place ? [place] : [];
			})
		: [];
	const actors: SeasonActors | undefined = actsOn
		? {
				doorOf: new Map(
					stations.map((station) => [station.agentId, station.number])
				),
				iconOnly: budget.iconOnly,
				paths: actPaths,
				props: (
					<SeasonActProps
						acts={acts}
						clock={clock}
						iconOnly={budget.iconOnly}
						nowMs={nowMs}
						offStage={offStage}
						onAsk={(askId) => cards.openAsk(askId)}
						onBlocker={(threadId, agentName) =>
							cards.openBlocker(threadId, agentName)
						}
						onQueue={() => openQueue(queueOpener)}
						onStage={onStage}
						owners={owners}
						reduced={reduceMotion}
						season={season}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
						stations={stations}
						stopped={stoppedPlaces}
					/>
				),
				villagers: cast,
			}
		: undefined;

	const empty = !loading && board.totals.threads === 0;
	const pickSeason = (picked: unknown) => {
		if (picked === "auto" || isSeason(picked)) {
			setGift(null);
			setSeason(picked);
		}
	};

	const hud = (
		<>
			<GameHudSlot at="top-left" className="min-w-0 max-w-[calc(100%-8rem)]">
				{actsOn ? (
					<div className="flex min-w-0 flex-col items-start gap-2" ref={hudRef}>
						<GameTitlePlate
							compact={compact}
							icon={SEASON_ICON[season]}
							keepStatus
							status={loading ? "Setting up the board" : actSummaryLine(totals)}
							title={copy.board}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={totals}
							/>
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
						</div>
						<BlindSpotCaption snapshot={snapshot} />
					</div>
				) : (
					<GameTitlePlate
						compact={compact}
						icon={SEASON_ICON[season]}
						status={
							loading ? "Setting up the board" : headerSummary(board, copy)
						}
						title={copy.board}
					/>
				)}
			</GameHudSlot>
			<GameHudSlot at="top-right" className="items-center">
				{compact ? (
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger
								render={
									<DropdownMenuTrigger
										aria-label={`Season: ${copy.label}`}
										render={<button className={PLATE_BUTTON} type="button" />}
									/>
								}
							>
								{/* With acts the summary line needs the room: the season's icon. */}
								{actsOn ? (
									<span className="flex [&_svg]:size-5">
										{SEASON_ICON[season]}
									</span>
								) : (
									<>
										{copy.label}
										<ChevronDown aria-hidden="true" className="size-4" />
									</>
								)}
							</TooltipTrigger>
							<TooltipContent side="bottom">
								Season: {copy.label}
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent
							align="end"
							className="w-48"
							drawerLabel="Season"
						>
							<DropdownMenuGroup>
								<DropdownMenuRadioGroup
									onValueChange={pickSeason}
									value={seasonSetting}
								>
									<DropdownMenuRadioItem value="auto">
										{FROM_TODAY}
									</DropdownMenuRadioItem>
									{SEASONS.map((item) => (
										<DropdownMenuRadioItem key={item} value={item}>
											{SEASON_COPY[item].label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					<div
						aria-label="Season"
						className={cn(
							GAME_PLATE,
							"pointer-events-auto flex h-12 items-center gap-1 p-1"
						)}
						role="group"
					>
						{(["auto", ...SEASONS] as const).map((item) => (
							<button
								aria-pressed={item === seasonSetting}
								className={cn(
									"gk-display h-full rounded-[11px] px-3.5 text-[15px] transition-colors",
									GAME_FOCUS,
									item === seasonSetting
										? "bg-(--gk-accent) text-(--gk-accent-ink)"
										: "text-(--gk-ink-muted) hover:bg-(--gk-plate-sunk) hover:text-(--gk-ink)"
								)}
								key={item}
								onClick={() => pickSeason(item)}
								type="button"
							>
								{item === "auto" ? FROM_TODAY : SEASON_COPY[item].label}
							</button>
						))}
					</div>
				)}
				{board.overflow.length > 0 ? (
					<button
						aria-pressed={side === "more"}
						className={PLATE_BUTTON}
						onClick={showMore}
						type="button"
					>
						{copy.more}
						<span className="text-(--gk-ink-muted) tabular-nums">
							{board.overflow.length}
						</span>
					</button>
				) : null}
				<GameAction
					compact={compact}
					disabled={loading}
					icon={<Plus aria-hidden="true" strokeWidth={3} />}
					label={copy.add}
					onClick={compose}
				/>
			</GameHudSlot>
			{loading ? null : (
				<GameHudSlot at="bottom-left">
					<Legend acts={actsOn} today={today !== null} />
				</GameHudSlot>
			)}
			{loading ? null : (
				<GameHudSlot at="bottom-right">
					{filledDoors.length === 0 || compact ? null : (
						<button
							aria-pressed={side === "all"}
							className={PLATE_BUTTON}
							onClick={showList}
							type="button"
						>
							<List aria-hidden="true" className="size-4" strokeWidth={2.5} />
							All {copy.doors}
							<span className="text-(--gk-ink-muted) tabular-nums">
								{filledDoors.length}
							</span>
						</button>
					)}
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);

	return (
		<div
			className="ryu-seasonal relative flex size-full min-h-0"
			data-season={season}
			data-testid="interface-seasonal"
		>
			<GameShell
				accent="tomato"
				busy={loading}
				hud={hud}
				label={copy.board}
				rootRef={rootRef}
				sheet={sheet}
			>
				<main
					aria-label={copy.board}
					className="@container/seasonal absolute inset-0 flex min-h-0 flex-col"
				>
					{/* Focus lands here when an ask or blocker card closes on nothing. */}
					{actsOn ? (
						<h1 className="sr-only" ref={headingRef} tabIndex={-1}>
							{copy.board}
						</h1>
					) : (
						<h1 className="sr-only">{copy.board}</h1>
					)}
					{loading ? (
						<div
							className="flex min-h-0 flex-1 flex-col"
							style={{ paddingTop: hudTop }}
						>
							<BoardSkeleton />
						</div>
					) : (
						<div className="relative min-h-0 flex-1" ref={stageRef}>
							{actsOn ? (
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
							<div className="absolute inset-0">
								<IsoStage
									bounds={{ ...world.bounds, top: world.top }}
									fallback={
										<div
											className="absolute inset-0 overflow-y-auto pb-24"
											style={{ paddingTop: hudTop + 8 }}
										>
											<SeasonalGrid
												activeNumber={activeNumber}
												doors={board.doors}
												giftId={giftId}
												giftNumber={gift}
												label={`${copy.board} ${copy.doors}`}
												labelOf={labelOf}
												onActivate={activate}
												onKeyDown={onDoorKeyDown}
												today={today}
											/>
											{actsOn ? (
												<section
													aria-labelledby={`${sceneId}-agents`}
													className="mx-auto mt-4 w-full max-w-[720px] px-3"
												>
													<div className="overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-background p-4 text-foreground shadow-(--gk-lip)">
														<h2
															className="gk-display pb-2 text-[18px] leading-6"
															id={`${sceneId}-agents`}
														>
															Agents
														</h2>
														<ActAgentList
															acts={acts}
															clock={clock}
															nowMs={nowMs}
															onAsk={onAsk}
															onBlocker={onBlocker}
															onOpenThread={openThread}
															snapshot={snapshot}
														/>
													</div>
												</section>
											) : null}
											{filledDoors.length > 0 ? (
												<section
													aria-labelledby={`${sceneId}-list`}
													className="mx-auto mt-4 w-full max-w-[720px] px-3"
												>
													<div className="overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-background text-foreground shadow-(--gk-lip)">
														<h2
															className="gk-display px-4 pt-4 pb-2 text-[18px] leading-6"
															id={`${sceneId}-list`}
														>
															All {copy.doors}
														</h2>
														{doorList(false)}
													</div>
												</section>
											) : null}
										</div>
									}
									// With acts the cast's plates need the room: frame closer.
									fill={actsOn ? ACTS_FILL[season] : undefined}
									// The street's cast fills its front half: zoom on to it.
									// Beside an open sheet it frames the street whole instead,
									// so its plates keep the room to part.
									fitPlates={
										actsOn && season === "lunar-new-year" && sheetCover === 0
											? {}
											: undefined
									}
									insets={insets}
									label={`${copy.board}: ${DIORAMA_LABEL[season]} Tab or the arrow keys move between them; drag to pan, plus and minus to zoom.`}
									motes={settings.weather && season !== "advent"}
									night={night}
									portrait={actsOn ? ACT_PORTRAIT[season] : undefined}
									reducedMotion={reduceMotion}
									view={isoView}
								>
									{({ quality, theme }) => (
										<SeasonDiorama
											activeNumber={activeNumber}
											actors={actors}
											doors={board.doors}
											giftId={giftId}
											giftNumber={gift}
											labelOf={labelOf}
											looks={looks}
											night={night}
											onActivate={activate}
											onKeyDown={onDoorKeyDown}
											quality={quality}
											reducedMotion={reduceMotion}
											season={season}
											shape={shape}
											theme={theme}
											today={today}
											weather={settings.weather}
											world={world}
										/>
									)}
								</IsoStage>
							</div>
							{giftDoor ? (
								<GiftCard
									acts={actsOn}
									copy={copy}
									door={giftDoor}
									id={giftId}
									key={`${season}-${giftDoor.number}`}
									now={now}
									onClose={closeGift}
									onOpen={() => {
										if (giftDoor.thread) {
											openThread(giftDoor.thread.id);
										}
									}}
									onReclose={reclose}
									position={giftPosition}
									reduceMotion={reduceMotion}
								/>
							) : null}
							{empty ? <EmptyNote copy={copy} onAdd={compose} /> : null}
						</div>
					)}
				</main>
				{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
				{cards.element}
			</GameShell>
		</div>
	);
}
