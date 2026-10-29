import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceParamsByRenderer,
	type InterfacePort,
	isWorldTileFree,
	layoutWorld,
	resolveInterfaceParams,
	type World2dParams,
	type WorldDirection,
	type WorldEntity,
	type WorldLayout,
	type WorldPoint,
	waitBand,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GAME_PLATE } from "./game-hud.tsx";
import { GAME_KIT_CSS } from "./game-palette.ts";
import {
	actSummaryLine,
	actTotals,
	stageAgents,
	toolForActivity,
	youSpotSlots,
} from "./game3d-acts.ts";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useTalkingAgent, useWorldController } from "./use-world-controller.ts";
import type { World2dTool } from "./world-2d-act-sprites.ts";
import { AgentActor, PlayerMarker } from "./world-2d-actors.tsx";
import { world2dActorTile, world2dYouSpot } from "./world-2d-acts.ts";
import { loadPixelFont, PIXEL_FONT_STACK } from "./world-2d-font.ts";
import {
	ClockBox,
	ControlsPlank,
	ControlsToggle,
	EmptyVillage,
	HelpButton,
	Hotbar,
	HotbarPlaceholder,
	hotbarLayout,
	LocationPlaque,
	PixelKey,
	PromptTooltip,
	VillageMap,
} from "./world-2d-hud.tsx";
import {
	type SceneFrame,
	sceneFrame,
	villageProps,
} from "./world-2d-layout.ts";
import {
	countNeedingYou,
	hintOpensByDefault,
	lastStreet,
	needsYou,
	startPoint,
	talkSpot,
	type VillagerStatus,
	villagerStatuses,
} from "./world-2d-model.ts";
import { PIXEL_SCENES, svCssVariables } from "./world-2d-palette.ts";
import {
	World2dActed,
	World2dActLines,
	World2dPanel,
	world2dActLine,
} from "./world-2d-panel.tsx";
import { PX, SCALE, TILE } from "./world-2d-pixel.ts";
import {
	type ActorAct,
	type ActorState,
	buildGroundLayer,
	buildStaticScene,
	type SceneInput,
} from "./world-2d-render.ts";
import { useWorldStage } from "./world-2d-stage.ts";
import { villageRoofColors, WORLD_PALETTES } from "./world-themes.ts";
import { layoutVillage } from "./world-village.ts";

interface ViewportSize {
	height: number;
	width: number;
}

/** Used until the viewport is measured (and for server rendering). */
const FALLBACK_VIEWPORT: ViewportSize = { height: 700, width: 1024 };

let canvas2dSupport: boolean | null = null;
/**
 * Whether this document can paint a 2D canvas. Without one (SSR, or a test
 * DOM such as happy-dom) the baked pixel scene could never be drawn, so the
 * renderer skips building it.
 */
function canPaint2d(): boolean {
	if (canvas2dSupport === null) {
		canvas2dSupport =
			typeof document !== "undefined" &&
			document.createElement("canvas").getContext("2d") !== null;
	}
	return canvas2dSupport;
}
/** How the camera frames one axis: where the player sits, and edge peeks. */
interface CameraAxis {
	/** Where the player sits in the free view, 0 (start) to 1 (end). */
	anchor: number;
	/** Art pixels at the end of the view covered by the HUD. */
	endInset: number;
	/** Tiles past each world edge the camera may show. */
	peekEnd: number;
	peekStart: number;
}

const CAMERA_X: CameraAxis = {
	anchor: 0.5,
	endInset: 0,
	peekEnd: 1,
	peekStart: 1,
};
/**
 * The player sits mid-view in the north of the village and lower toward
 * the square (see `lookNorth`), so from the square the camera looks ahead
 * into town and the first row of roofs and chimneys is in shot. The bottom
 * keeps room for the hotbar so the square's furniture never hides under it.
 */
const CAMERA_Y: CameraAxis = {
	anchor: 0.5,
	endInset: 34,
	peekEnd: 1,
	peekStart: 1,
};

/**
 * Camera offset on one axis, in art pixels: follow the player, stop at the
 * world edges, and center a world smaller than the viewport.
 */
function cameraAxis(
	view: number,
	worldTiles: number,
	marginTiles: number,
	playerTile: number,
	axis: CameraAxis
): number {
	const origin = marginTiles * PX;
	const worldPx = worldTiles * PX;
	const free = view - axis.endInset;
	if (worldPx + (axis.peekStart + axis.peekEnd) * PX <= free) {
		return Math.round(free / 2 - (origin + worldPx / 2));
	}
	const follow = free * axis.anchor - (origin + (playerTile + 0.5) * PX);
	const min = free - (origin + worldPx + axis.peekEnd * PX);
	const max = -(origin - axis.peekStart * PX);
	return Math.round(Math.min(max, Math.max(min, follow)));
}

/**
 * Indoors the camera may rise to show the papered back wall, and shows a
 * strip of the front wall's wainscot below the floor.
 */
const CAMERA_Y_INDOOR: CameraAxis = {
	...CAMERA_Y,
	peekEnd: 0.6,
	peekStart: 2,
};

/**
 * At the village's south edge the player sits as low in the view as leaves
 * this many tiles below them clear of the hotbar (the square's fountain).
 */
const SOUTH_ROOM_TILES = 0.3;
const MAX_SOUTH_ANCHOR = 0.95;

/**
 * Outdoors the camera looks north the further south the player is: mid-view
 * among the cottages, sliding to low in the view as the player walks from
 * the last street down onto the square (keeping the fountain below clear of
 * the hotbar), so the cottages' roofs stay in shot from the square.
 */
function lookNorth(
	layout: WorldLayout,
	player: WorldPoint,
	viewHeight: number,
	base: CameraAxis
): CameraAxis {
	const free = viewHeight - base.endInset;
	const southAnchor = Math.min(
		MAX_SOUTH_ANCHOR,
		Math.max(base.anchor, (free - SOUTH_ROOM_TILES * PX) / free)
	);
	const north = Math.max(0, lastStreet(layout));
	const span = layout.height - 1 - north;
	const south = span > 0 ? (player.y - north) / span : 0;
	return {
		...base,
		anchor:
			base.anchor +
			(southAnchor - base.anchor) * Math.min(1, Math.max(0, south)),
	};
}

/**
 * While talking, the camera holds the villager mid-view and stops at the
 * village's south edge (the square's curb), so the conversation is framed
 * by the cottages around it rather than by empty paving under the hotbar.
 */
const TALKING_ANCHOR = 0.5;
/** Highest in the view the talking villager is lifted (share of it). */
const TALKING_ANCHOR_MIN = 0.36;
/** Art pixels kept between the next row's feet and the hotbar. */
const TALKING_FOOT_ROOM = 4;

/**
 * Where in the view the talking villager sits: mid-view, lifted (up to
 * {@link TALKING_ANCHOR_MIN}) so the villagers on the next street down
 * stand fully above the hotbar instead of under it.
 */
function talkingAnchor(
	layout: WorldLayout,
	player: WorldPoint,
	free: number
): number {
	let next: number | null = null;
	for (const entity of layout.entities) {
		if (entity.y > player.y && (next === null || entity.y < next)) {
			next = entity.y;
		}
	}
	if (next === null || free <= 0) {
		return TALKING_ANCHOR;
	}
	const below = (next - player.y + 0.5) * PX;
	const lifted = (free - TALKING_FOOT_ROOM - below) / free;
	return Math.min(TALKING_ANCHOR, Math.max(TALKING_ANCHOR_MIN, lifted));
}

/**
 * The village's last row holds the square's sign, fountain and notice
 * board. Rather than leave them sliced by the view's bottom edge (or under
 * the hotbar), once any of that row is in view the camera rises to show it
 * whole above the hotbar.
 */
function revealBottomRow(
	y: number,
	viewHeight: number,
	worldTiles: number,
	marginTiles: number,
	endInset: number
): number {
	const rowTop = y + (marginTiles + worldTiles - 1) * PX;
	const rowBottom = rowTop + PX;
	const free = viewHeight - endInset;
	if (rowTop < viewHeight && rowBottom > free) {
		return y - (rowBottom - free);
	}
	return y;
}

function cameraOffset(
	layout: WorldLayout,
	frame: SceneFrame,
	view: ViewportSize,
	player: WorldPoint,
	options: {
		indoor: boolean;
		/** Rows down to the square's curb, or null outside a conversation. */
		talkingRows: number | null;
	}
): WorldPoint {
	const base = options.indoor ? CAMERA_Y_INDOOR : CAMERA_Y;
	const x = cameraAxis(
		view.width,
		layout.width,
		frame.margin.x,
		player.x,
		CAMERA_X
	);
	if (options.talkingRows !== null && !options.indoor) {
		return {
			x,
			y: cameraAxis(
				view.height,
				Math.min(layout.height, options.talkingRows),
				frame.margin.y,
				player.y,
				{
					...base,
					anchor: talkingAnchor(layout, player, view.height - base.endInset),
					peekEnd: 0.3,
				}
			),
		};
	}
	const y = cameraAxis(
		view.height,
		layout.height,
		frame.margin.y,
		player.y,
		lookNorth(layout, player, view.height, base)
	);
	return {
		x,
		y: revealBottomRow(
			y,
			view.height,
			layout.height,
			frame.margin.y,
			base.endInset
		),
	};
}

/** Narrowest the controls hint gets in the top-left corner (CSS px). */
const HINT_MIN_WIDTH = 250;
/** Room the clock box takes in the top-right corner, with gaps (CSS px). */
const CLOCK_ROOM = 264;
/** The HUD's inset from the stage edges (CSS px). */
const HUD_INSET = 12;

/** How long the controls hint shows after the world opens. */
const HINT_MS = 6000;

/**
 * The controls hint: on a roomy stage it shows until the player first moves
 * (or for a few seconds); on a narrow one it starts closed, so it never
 * covers the player. Either way "?" or the "?" slot toggles it.
 */
function useControlsHint(
	player: WorldPoint,
	stageWidth: number,
	/** The "Controls hint" setting: `auto` follows the stage, as above. */
	setting: "auto" | "hidden" | "shown" = "auto",
	/** Keeps the "?" choice as the setting (`InterfacePort.updateSettings`). */
	persist?: (value: "hidden" | "shown") => void
): {
	open: boolean;
	toggle: () => void;
} {
	// null until the player (or the timer) decides: follow the setting, or
	// on `auto` the stage width.
	const [chosen, setChosen] = useState<boolean | null>(null);
	const fixed = setting === "auto" ? null : setting === "shown";
	const open = chosen ?? fixed ?? hintOpensByDefault(stageWidth);
	const start = useRef(player);
	const moved = useRef(false);
	// A setting changed in Settings (or by "?" below) decides afresh.
	useEffect(() => {
		setChosen(null);
	}, [setting]);
	useEffect(() => {
		if (setting !== "auto") {
			return;
		}
		const id = setTimeout(() => setChosen((value) => value ?? false), HINT_MS);
		return () => clearTimeout(id);
	}, [setting]);
	useEffect(() => {
		if (moved.current || setting !== "auto") {
			return;
		}
		if (player.x !== start.current.x || player.y !== start.current.y) {
			moved.current = true;
			setChosen((value) => value ?? false);
		}
	}, [player, setting]);
	const toggle = useCallback(() => {
		moved.current = true;
		setChosen(!open);
		persist?.(open ? "hidden" : "shown");
	}, [open, persist]);
	return { open, toggle };
}

/** Whether the app's theme is dark (the `.dark` class on the document). */
function useDarkTheme(): boolean {
	const [dark, setDark] = useState(false);
	useEffect(() => {
		const root = document.documentElement;
		const update = () => setDark(root.classList.contains("dark"));
		update();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(update);
		observer.observe(root, { attributeFilter: ["class"], attributes: true });
		return () => observer.disconnect();
	}, []);
	return dark;
}

/**
 * The port as the village uses it: leaving a conversation only closes a
 * thread when one is actually open (visiting a villager from the road with
 * nothing open must not tell the host to close anything).
 */
function useVillagePort(
	port: InterfacePort,
	threadOpen: boolean
): InterfacePort {
	return useMemo(
		() => ({
			closeThread: () => {
				if (threadOpen) {
					port.closeThread();
				}
			},
			openThread: port.openThread,
			startThread: port.startThread,
		}),
		[port, threadOpen]
	);
}

/** The HUD's colors and its pixel face, set once on the world's root. */
const SV_VARIABLES: CSSProperties = {
	...svCssVariables(),
	"--sv-font": PIXEL_FONT_STACK,
} as CSSProperties;

/**
 * The hotbar's page: turned with the arrows or [ ], and moved to whichever
 * villager the player is talking to or standing by.
 */
function useHotbarPage(
	agentIds: readonly string[],
	pageSize: number,
	activeId: string | null
): { page: number; pageCount: number; turn: (delta: -1 | 1) => void } {
	const pageCount = Math.max(1, Math.ceil(agentIds.length / pageSize));
	const [page, setPage] = useState(0);
	const activeIndex = activeId ? agentIds.indexOf(activeId) : -1;
	useEffect(() => {
		if (activeIndex >= 0) {
			setPage(Math.floor(activeIndex / pageSize));
		}
	}, [activeIndex, pageSize]);
	const turn = useCallback(
		(delta: -1 | 1) =>
			setPage((current) =>
				Math.min(pageCount - 1, Math.max(0, current + delta))
			),
		[pageCount]
	);
	return { page: Math.min(page, pageCount - 1), pageCount, turn };
}

/** Tracks the rendered size of the world viewport. */
function useViewportSize(): {
	/** False until the stage's size is known (the fallback size is shown). */
	measured: boolean;
	ref: RefObject<HTMLDivElement | null>;
	size: ViewportSize;
} {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<ViewportSize | null>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => {
			const { height, width } = element.getBoundingClientRect();
			setSize((previous) =>
				previous?.height === height && previous.width === width
					? previous
					: { height, width }
			);
		};
		update();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { measured: size !== null, ref, size: size ?? FALLBACK_VIEWPORT };
}

/** The largest size seen so far (per axis), stable between growths. */
function useLargestSize(size: ViewportSize): ViewportSize {
	const largest = useRef(size);
	const { height, width } = largest.current;
	if (size.height > height || size.width > width) {
		largest.current = {
			height: Math.max(height, size.height),
			width: Math.max(width, size.width),
		};
	}
	return largest.current;
}

/**
 * When a thread is opened from outside the world (or was open as it
 * mounted), walk the player up to that thread's agent so the open panel and
 * the player's position agree. Runs once per newly opened agent.
 */
function useMeetActiveThreadAgent(
	snapshot: InterfaceRendererProps<World2dParams>["snapshot"],
	activeThreadId: string | null,
	world: { meet: (agentId: string) => void; talkingTo: string | null }
): void {
	const agentId = activeThreadId
		? (snapshot.threads.find((thread) => thread.id === activeThreadId)
				?.agentIds[0] ?? null)
		: null;
	const met = useRef<string | null>(null);
	const { meet, talkingTo } = world;
	useEffect(() => {
		if (!agentId) {
			met.current = null;
			return;
		}
		if (met.current === agentId) {
			return;
		}
		met.current = agentId;
		if (talkingTo !== agentId) {
			meet(agentId);
		}
	}, [agentId, meet, talkingTo]);
}

/** Villagers face the player when they are close, otherwise the street. */
function facingToward(
	entity: WorldEntity,
	player: WorldPoint,
	near: boolean
): WorldDirection {
	if (!near) {
		return "down";
	}
	const dx = player.x - entity.x;
	const dy = player.y - entity.y;
	if (Math.abs(dx) > Math.abs(dy)) {
		return dx > 0 ? "right" : "left";
	}
	return dy < 0 ? "up" : "down";
}

const DIGIT_KEYS = "1234567890";
const NO_NOTICES: readonly WorldPoint[] = [];
const NO_ACTORS: readonly ActorState[] = [];
/** Above a villager's tile centre: its head and its "!" (px). */
const HEAD_ROOM = 110;
/** The act column on a wide stage: its width and its bottom edge (px). */
const HUD_WIDE_WIDTH = 340;
const HUD_WIDE_BOTTOM = 330;
/** The HUD band across the top of a phone's stage (px). */
const HUD_NARROW_BOTTOM = 300;
/** The hotbar's band along the bottom of the stage (px). */
const HOTBAR_ROOM = 110;
/** The controller's talk keys: next to an asker they open its ask. */
const ASK_KEYS = new Set(["e", "enter", " "]);

/**
 * Whether the focused element inside the world needs the key itself (as the
 * world controller judges it): text fields, and Enter/Space on a button or
 * link, which activate it natively.
 */
function ownsAskKey(
	target: EventTarget,
	world: EventTarget,
	key: string
): boolean {
	if (target === world || !(target instanceof HTMLElement)) {
		return false;
	}
	if (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	) {
		return true;
	}
	return (
		key !== "e" &&
		key !== "E" &&
		(target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement)
	);
}

/** The kit's tools the 2D village draws (others hold nothing). */
const WORLD_2D_TOOLS = new Set<string>([
	"book",
	"clipboard",
	"globe",
	"lens",
	"quill",
	"wrench",
]);

function parseIso(iso: string | null | undefined): number | null {
	const value = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(value) ? value : null;
}

/** What a villager's act draws over its sprite (world-2d-render `ActorAct`). */
export function actorAct(
	act: InterfaceAgentAct,
	nowMs: number,
	/** `minimal` (the "Overlay density" setting) drops pips, "~" and the next sign. */
	density: "full" | "minimal" = "full"
): ActorAct {
	const minimal = density === "minimal";
	const ask = act.act === "asking" ? act.ask : null;
	let carry: ActorAct["carry"] = null;
	if (act.carry === "approval") {
		carry = "letter";
	} else if (act.carry === "question") {
		carry = "scroll";
	}
	const tool =
		act.act === "working" ? toolForActivity(act.carry ?? null) : undefined;
	return {
		// One lamp per counted failure (an interruption has its flag, a
		// rate limit its zzz), and a dim one per failure too old to count.
		alarms: act.blockers.filter(
			(blocker) =>
				blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
		).length,
		back:
			act.act === "limited"
				? (/back (.+)$/.exec(act.bubble?.text ?? "")?.[1] ?? null)
				: null,
		carry: ask ? carry : null,
		followers: act.helpers?.running ?? 0,
		next: !minimal && act.next !== null,
		oldAlarms: act.pending.old,
		tool: tool && WORLD_2D_TOOLS.has(tool) ? (tool as World2dTool) : null,
		waitTint: ask
			? waitBand(parseIso(ask.since), nowMs, parseIso(ask.expiresAt))
			: undefined,
		failed:
			act.act === "blocked" &&
			act.blockers.some((blocker) => blocker.kind !== "interrupted"),
		interrupted:
			act.blockers.some((blocker) => blocker.kind === "interrupted") &&
			!act.blockers.some(
				(blocker) =>
					blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
			),
		suggestion: act.suggestions.length > 0,
		unread: act.pending.unread > 0,
		limited: act.act === "limited",
		// Steps the agent reported (plan or workflow) as pips; a routine's
		// estimate is only a "~", never guessed steps.
		estimate:
			!minimal && act.act === "working" && act.progress?.kind === "estimate",
		pips:
			!minimal &&
			act.act === "working" &&
			(act.progress?.kind === "plan" || act.progress?.kind === "workflow") &&
			act.progress.total > 0
				? { done: act.progress.done, total: act.progress.total }
				: null,
		wait: ask
			? waitLabel(ask.since, nowMs, {
					approx: ask.sinceApprox,
					until: ask.expiresAt ?? null,
					untilApprox: ask.expiresApprox,
				})
			: null,
	};
}

/**
 * Stardew Valley-style pixel village: every agent has a cottage and stands on
 * its doorstep, the player (straw hat) walks the streets and talks to them.
 * Villagers waiting on the user wear Stardew's "!" quest marker; busy ones
 * show the "..." emote. The world is real pixel art drawn at 16x16 art
 * tiles (2x2 per world tile) on a canvas and upscaled with nearest-neighbor
 * filtering; an accessible DOM layer sits on top. Under a dark app theme
 * the village is shown at night.
 */

export function World2dInterface({
	activeThreadId,
	loading,
	params,
	port: hostPort,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["world-2d"]>) {
	// The live settings (a bare `{}` resolves to the defaults).
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	const settings = resolveInterfaceParams("world-2d", params) as Required<
		InterfaceParamsByRenderer["world-2d"]
	>;
	const dark = useDarkTheme();
	useEffect(() => {
		loadPixelFont();
	}, []);
	const theme = dark && settings.theme === "meadow" ? "night" : settings.theme;
	const port = useVillagePort(
		hostPort,
		activeThreadId !== null || threadView !== null
	);
	const layout = useMemo(() => layoutWorld(snapshot), [snapshot]);
	const village = useMemo(() => layoutVillage(layout), [layout]);
	// The player starts among the cottages rather than on the empty square.
	const startLayout = useMemo(
		() => ({ ...layout, spawn: startPoint(layout, village) }),
		[layout, village]
	);
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	// With acts the villagers' marks (the "!" emote, the hotbar and map
	// badges) follow the acts: an ask or an answer waiting, a stopped run,
	// work; everything else is idle.
	const statuses = useMemo(() => {
		if (!withActs) {
			return villagerStatuses(snapshot.agents, snapshot.threads);
		}
		const out = new Map<string, VillagerStatus>();
		for (const agent of snapshot.agents) {
			const act = acts.get(agent.id);
			let status: VillagerStatus = "idle";
			if (act?.act === "asking" || act?.act === "delivering") {
				status = "your-turn";
			} else if (
				act?.act === "blocked" &&
				act.blockers[0]?.kind !== "interrupted"
			) {
				status = "attention";
			} else if (act?.act === "working") {
				status = "working";
			}
			out.set(agent.id, status);
		}
		return out;
	}, [acts, snapshot, withActs]);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const worldHeadingRef = useRef<HTMLHeadingElement>(null);
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: worldHeadingRef,
		nowMs,
		port: hostPort,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const totals = actTotals(snapshot, acts);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const palette = WORLD_PALETTES[theme];
	const pixel = PIXEL_SCENES[theme];
	const indoor = pixel.indoor;
	const furniture = useMemo(
		() => villageProps(layout, village, indoor),
		[indoor, layout, village]
	);
	const roofs = useMemo(
		() => villageRoofColors(village, palette),
		[palette, village]
	);
	// Furniture stands on free grass beside the streets, so blocking it never
	// cuts an agent off from the plaza.
	const obstacles = useMemo(
		() => new Set([...village.blocked, ...furniture.blocking]),
		[furniture, village]
	);
	const viewport = useViewportSize();
	const reducedMotion = useReducedMotion();
	// The forest margin only ever grows with the viewport, so opening the
	// talk panel (a narrower view) never re-bakes the ground.
	const frameViewport = useLargestSize(viewport.size);
	// A narrow stage queues down your column. Held while you talk, so the
	// talk panel narrowing the view never swings the queue round.
	const liveNarrow = viewport.size.width < 640;
	// Held while you talk (the last render's talk state), and read straight
	// from the measured size otherwise, so the first measured frame already
	// places the queue for this stage (no walk from the fallback's places).
	const talkOpenRef = useRef(false);
	const heldNarrow = useRef(liveNarrow);
	if (!talkOpenRef.current) {
		heldNarrow.current = liveNarrow;
	}
	const narrowStage = heldNarrow.current;
	// With acts: each villager's tile for its act (an asker queues on your
	// doorstep, a deliverer by the chest), and the chest itself.
	// Where you stood at the last render: act places keep off it.
	const playerTile = useRef<WorldPoint>(startLayout.spawn);
	const { height: stageHeight, width: stageWidth } = viewport.size;
	const rawPlaces = useMemo(() => {
		if (!withActs) {
			return null;
		}
		const height = stageHeight;
		const width = stageWidth;
		// Never the tile you stand on (the controller would snap you away),
		// and never where the HUD (the act column, or the top band on a phone)
		// would cover the villager and its "!", seen from your doorstep.
		const player = playerTile.current;
		// Seen as the camera frames your doorstep (it stops at the village's
		// edges, so the doorstep need not be mid-view).
		const startFrame = sceneFrame(layout, frameViewport, TILE);
		const camera = cameraOffset(
			layout,
			startFrame,
			{ height: Math.ceil(height / SCALE), width: Math.ceil(width / SCALE) },
			startLayout.spawn,
			{ indoor, talkingRows: null }
		);
		const underHud = (point: WorldPoint) => {
			if (width <= 0 || height <= 0) {
				return false;
			}
			const x = (camera.x + (point.x + startFrame.margin.x + 0.5) * PX) * SCALE;
			const feet =
				(camera.y + (point.y + startFrame.margin.y + 1) * PX) * SCALE;
			const top = feet - TILE / 2 - HEAD_ROOM;
			// The hotbar along the bottom covers feet as the HUD covers heads.
			if (feet > height - HOTBAR_ROOM) {
				return true;
			}
			return narrowStage
				? top < HUD_NARROW_BOTTOM
				: top < HUD_WIDE_BOTTOM && x > width - HUD_WIDE_WIDTH - TILE / 2;
		};
		const free = (point: WorldPoint) =>
			isWorldTileFree(layout, point) &&
			!obstacles.has(`${point.x},${point.y}`) &&
			!(point.x === player.x && point.y === player.y) &&
			!underHud(point);
		const placed = new Set(layout.entities.map((entity) => entity.agentId));
		const { onStage } = stageAgents(
			new Map([...acts].filter(([agentId]) => placed.has(agentId))),
			Number.POSITIVE_INFINITY
		);
		const { slots } = youSpotSlots(
			acts,
			unowned,
			onStage.map((act) => act.agentId)
		);
		// Your doorstep: the tile you start on. Only the slots in use get a
		// place, villagers first, so each fits in a thin view.
		const spot = world2dYouSpot(startLayout, free, narrowStage, {
			posts: slots
				.filter((slot) => slot.carrier === "notice")
				.map((slot) => slot.point),
			villagers: slots
				.filter((slot) => slot.carrier === "villager")
				.map((slot) => slot.point),
		});
		const delivering = onStage
			.filter((act) => act.act === "delivering")
			.map((act) => act.agentId);
		const tiles = new Map<string, WorldPoint>();
		for (const entity of layout.entities) {
			const act = acts.get(entity.agentId);
			if (act) {
				tiles.set(
					entity.agentId,
					world2dActorTile(
						act,
						{ x: entity.x, y: entity.y },
						spot,
						slots,
						reducedMotion,
						delivering.indexOf(entity.agentId)
					)
				);
			}
		}
		const replies = (snapshot.asks ?? []).some((ask) => ask.kind === "reply");
		return {
			chest: delivering.length > 0 || replies ? spot.tray : null,
			// An ask nobody carries (unowned, or parked by a busy agent) waits
			// on its queue tile as a notice post.
			notices: slots.flatMap((slot) => {
				const tile = slot.carrier === "notice" ? spot.slots[slot.point] : null;
				return tile ? [tile] : [];
			}),
			tiles,
		};
	}, [
		acts,
		frameViewport,
		indoor,
		layout,
		obstacles,
		narrowStage,
		reducedMotion,
		snapshot.asks,
		stageHeight,
		stageWidth,
		startLayout,
		unowned,
		withActs,
	]);
	// Keyed by where things stand, not by the acts map (a new one every
	// second): the village rebuilds, walks and redraws only when a place
	// changes.
	const placesKey = rawPlaces
		? JSON.stringify([rawPlaces.chest, rawPlaces.notices, [...rawPlaces.tiles]])
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the places' content.
	const actPlaces = useMemo(() => rawPlaces, [placesKey]);
	// The village as you walk it: villagers stand on their acts' tiles, so
	// you bump into, stand by and talk to them where they are.
	const actLayout = useMemo(() => {
		const tiles = actPlaces?.tiles;
		if (!tiles) {
			return startLayout;
		}
		return {
			...startLayout,
			entities: startLayout.entities.map((entity) => ({
				...entity,
				...tiles.get(entity.agentId),
			})),
		};
	}, [actPlaces, startLayout]);
	const world = useWorldController(actLayout, port, obstacles);
	playerTile.current = world.player;
	talkOpenRef.current =
		world.talkingTo !== null || activeThreadId !== null || threadView !== null;
	const view = useMemo(
		() => ({
			height: Math.ceil(viewport.size.height / SCALE),
			width: Math.ceil(viewport.size.width / SCALE),
		}),
		[viewport.size]
	);
	const frame = useMemo(
		() => sceneFrame(layout, frameViewport, TILE),
		[layout, frameViewport]
	);
	const frameKey = `${frame.margin.x},${frame.margin.y}`;
	const { talkingAgent, talkingThreads } = useTalkingAgent(
		snapshot,
		world.talkingTo,
		activeThreadId
	);
	// While talking the player is drawn beside the villager (see talkSpot).
	const spot = useMemo(
		() =>
			talkSpot(
				actLayout,
				world.talkingTo,
				world.player,
				(point) =>
					isWorldTileFree(actLayout, point) &&
					!village.blocked.has(`${point.x},${point.y}`)
			),
		[actLayout, village, world.player, world.talkingTo]
	);
	const shownPlayer = spot?.point ?? world.player;
	const shownFacing = spot?.facing ?? world.facing;
	const camera = cameraOffset(layout, frame, view, shownPlayer, {
		indoor,
		talkingRows: talkingAgent ? village.plaza.top : null,
	});
	useMeetActiveThreadAgent(snapshot, activeThreadId, world);

	const title = indoor ? "Ryu HQ" : "Ryu Village";
	const agentsWorking = useMemo(() => {
		const map = new Map<string, boolean>();
		for (const entity of layout.entities) {
			map.set(entity.agentId, entity.status === "working");
		}
		return map;
	}, [layout]);
	const sceneInput: SceneInput = useMemo(
		() => ({
			agentsWorking,
			frame,
			layout,
			props: furniture,
			roofs,
			scene: pixel,
			sceneTones: palette.scene,
			title,
			village,
		}),
		[
			agentsWorking,
			frame,
			furniture,
			layout,
			palette,
			pixel,
			roofs,
			title,
			village,
		]
	);
	const canDraw = canPaint2d();
	const ground = useMemo(
		() => (canDraw ? buildGroundLayer(sceneInput) : null),
		// The ground ignores statuses: rebuild only when the place changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[canDraw, frame, furniture, layout, pixel, village]
	);
	const staticScene = useMemo(
		() => (ground ? buildStaticScene(sceneInput, ground) : null),
		[ground, sceneInput]
	);

	const nearbyId = world.nearby?.agentId ?? null;
	const talkingId = talkingAgent?.id ?? null;
	// With acts, what each villager says in the talk box.
	const actLines = useMemo(() => {
		if (!withActs) {
			return null;
		}
		const lines = new Map<string, string>();
		for (const act of acts.values()) {
			const line = world2dActLine(act, snapshot.threads, privacy);
			if (line) {
				lines.set(act.agentId, line);
			}
		}
		return lines;
	}, [acts, privacy, snapshot.threads, withActs]);
	// Each villager's act sprites, keyed by what they draw (a wait plaque
	// changes by the minute, not every second).
	const rawSprites = useMemo(
		() =>
			new Map(
				withActs
					? [...acts].map(([agentId, act]) => [
							agentId,
							actorAct(act, nowMs, settings.overlayDensity),
						])
					: []
			),
		[acts, nowMs, settings.overlayDensity, withActs]
	);
	const spritesKey = JSON.stringify([...rawSprites]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the sprites' content.
	const actSprites = useMemo(() => rawSprites, [spritesKey]);
	const actors: ActorState[] = useMemo(
		() =>
			layout.entities.map((entity, index) => {
				const talking = entity.agentId === talkingId;
				const near = entity.agentId === nearbyId || talking;
				const status = statuses.get(entity.agentId) ?? "idle";
				const tile = actPlaces?.tiles.get(entity.agentId);
				const placed = tile ? { ...entity, ...tile } : entity;
				return {
					act: actSprites.get(entity.agentId),
					emote: settings.workBubbles,
					alert:
						status === "attention" || status === "your-turn" ? status : null,
					entity: placed,
					facing: facingToward(placed, shownPlayer, near),
					lookIndex: index,
					near,
					talking,
					working: entity.status === "working",
				};
			}),
		[
			actPlaces,
			actSprites,
			layout,
			nearbyId,
			settings.workBubbles,
			shownPlayer,
			statuses,
			talkingId,
		]
	);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const playerRef = useRef<HTMLDivElement>(null);
	const stageRefs = useMemo(
		() => ({ canvas: canvasRef, overlay: overlayRef, player: playerRef }),
		[]
	);
	useWorldStage(
		{
			// Nobody is drawn before the stage is measured: a villager first seen
			// at the fallback size's places would then walk to this stage's.
			actors: viewport.measured ? actors : NO_ACTORS,
			camera,
			chest: actPlaces?.chest ?? null,
			notices: actPlaces?.notices ?? NO_NOTICES,
			frameKey,
			pixel,
			player: shownPlayer,
			playerFacing: shownFacing,
			reducedMotion,
			scene: staticScene,
			view,
		},
		stageRefs
	);

	const [mapOpen, setMapOpen] = useState(false);
	const toggleMap = useCallback(() => setMapOpen((open) => !open), []);
	const persistControls = useCallback(
		(value: "hidden" | "shown") =>
			hostPort.updateSettings?.({ controls: value }),
		[hostPort]
	);
	const hint = useControlsHint(
		world.player,
		viewport.size.width,
		settings.controls,
		persistControls
	);
	const toggleHint = hint.toggle;
	// With acts the hotbar leads with the askers, in the queue's order: an
	// asker's slot says its ask and answers it; the rest say their act.
	const allHotbarAgents = useMemo(() => {
		const slots = layout.entities.map((entity, index) => {
			const act = withActs ? acts.get(entity.agentId) : undefined;
			const ask = act?.act === "asking" ? act.ask : null;
			let actLabel: string | undefined;
			if (ask) {
				actLabel = `${askAriaLabel(ask, entity.name, nowMs, privacy)} Answer their ask.`;
			} else if (act) {
				actLabel = `${act.ariaLabel} Visit ${entity.name}.`;
			}
			return {
				ask,
				slot: {
					actLabel,
					agentId: entity.agentId,
					index,
					name: entity.name,
					status: statuses.get(entity.agentId) ?? "idle",
				},
			};
		});
		if (!withActs) {
			return slots.map((item) => item.slot);
		}
		return [
			...slots
				.filter((item) => item.ask)
				.sort((a, b) => (a.ask && b.ask ? compareAsks(a.ask, b.ask) : 0)),
			...slots.filter((item) => !item.ask),
		].map((item) => item.slot);
	}, [acts, layout, nowMs, privacy, statuses, withActs]);
	// The hotbar's order (askers first with acts) pages the slots.
	const agentIds = useMemo(
		() => allHotbarAgents.map((agent) => agent.agentId),
		[allHotbarAgents]
	);
	const bar = hotbarLayout(viewport.size.width, agentIds.length);
	const pageSize = bar.pageSize;
	const hotbar = useHotbarPage(agentIds, pageSize, talkingId ?? nearbyId);
	const turnPage = hotbar.turn;
	const hotbarAgents = useMemo(
		() =>
			allHotbarAgents.slice(
				hotbar.page * pageSize,
				hotbar.page * pageSize + pageSize
			),
		[allHotbarAgents, hotbar.page, pageSize]
	);
	const { onKeyDown: worldKeyDown, talkTo: visit } = world;
	// With acts an asker is answered, not visited: its ask opens instead.
	const askerAsk = useCallback(
		(agentId: string) => {
			const act = withActs ? acts.get(agentId) : undefined;
			return act?.act === "asking" ? act.ask : null;
		},
		[acts, withActs]
	);
	const openAskCard = cards.openAsk;
	const talkTo = useCallback(
		(agentId: string) => {
			const ask = askerAsk(agentId);
			if (ask) {
				openAskCard(ask.id);
				return;
			}
			visit(agentId);
		},
		[askerAsk, openAskCard, visit]
	);
	const nearbyAsk = world.nearby ? askerAsk(world.nearby.agentId) : null;
	// Where a villager's talk button stands: on its act's tile.
	const placedEntity = (entity: WorldEntity): WorldEntity => {
		const tile = actPlaces?.tiles.get(entity.agentId);
		return tile ? { ...entity, ...tile } : entity;
	};
	const controllerKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			// The controller's talk keys, past its own guards: a key a field
			// or button inside the world owns stays theirs.
			if (
				nearbyAsk &&
				!(event.metaKey || event.ctrlKey || event.altKey) &&
				ASK_KEYS.has(event.key.toLowerCase()) &&
				!ownsAskKey(event.target, event.currentTarget, event.key)
			) {
				event.preventDefault();
				openAskCard(nearbyAsk.id);
				return;
			}
			worldKeyDown(event);
		},
		[nearbyAsk, openAskCard, worldKeyDown]
	);
	const visitFromMap = useCallback(
		(agentId: string) => {
			setMapOpen(false);
			talkTo(agentId);
		},
		[talkTo]
	);
	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			const target = event.target as HTMLElement;
			const typing =
				target.isContentEditable ||
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement;
			if (!(typing || event.metaKey || event.ctrlKey || event.altKey)) {
				const key = event.key.toLowerCase();
				if (key === "m" || (key === "escape" && mapOpen)) {
					event.preventDefault();
					toggleMap();
					return;
				}
				if (key === "?") {
					event.preventDefault();
					toggleHint();
					return;
				}
				if (key === "[" || key === "]") {
					event.preventDefault();
					turnPage(key === "[" ? -1 : 1);
					return;
				}
				const slot = DIGIT_KEYS.indexOf(key);
				const agent = slot >= 0 ? hotbarAgents[slot] : undefined;
				if (agent) {
					event.preventDefault();
					talkTo(agent.agentId);
					return;
				}
			}
			controllerKeyDown(event);
		},
		[
			controllerKeyDown,
			hotbarAgents,
			mapOpen,
			talkTo,
			toggleHint,
			toggleMap,
			turnPage,
		]
	);

	const empty = !loading && layout.entities.length === 0;
	const settled = !(loading || empty);
	// The controls hint sits in the top-left corner, clear of the clock, the
	// hotbar and the square's sign; on a narrow stage it sits above the
	// hotbar's left end instead (and starts closed there).
	const hintRoom = viewport.size.width - HUD_INSET * 2 - CLOCK_ROOM;
	const hintOnTop = hintRoom >= HINT_MIN_WIDTH;
	let prompt: ReactNode = null;
	if (talkingAgent) {
		// The talk panel carries its own Walk away button (and Esc).
		prompt = null;
	} else if (world.nearby) {
		prompt = (
			<span className="inline-flex items-center gap-2">
				<PixelKey>E</PixelKey>
				<span>
					{nearbyAsk ? "Answer" : "Talk to"}{" "}
					<span className="text-(--sv-gold)">{world.nearby.name}</span>
				</span>
			</span>
		);
	} else if (loading) {
		prompt = "Loading villagers";
	}
	let controls: ReactNode = null;
	if (hint.open && settled) {
		const visitable = Math.min(pageSize, hotbarAgents.length);
		controls = (
			<span className="inline-flex flex-wrap items-center gap-x-4 gap-y-2">
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>WASD</PixelKey>
					Walk
				</span>
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>E</PixelKey>
					Talk
				</span>
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>{visitable === 1 ? "1" : `1–${visitable % 10}`}</PixelKey>
					Visit
				</span>
				{hotbar.pageCount > 1 ? (
					<span className="inline-flex items-center gap-1.5">
						<PixelKey>[</PixelKey>
						<PixelKey>]</PixelKey>
						Page
					</span>
				) : null}
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>M</PixelKey>
					Map
				</span>
			</span>
		);
	}
	// With acts the clock counts what the acts say.
	const needYouCount = withActs ? totals.needYou : countNeedingYou(statuses);
	const workingCount = withActs
		? totals.working
		: layout.entities.filter((entity) => entity.status === "working").length;

	return (
		<div
			// isolate: the world's own layers (the HUD, the act plates) stay
			// under the cards and sheets the act layer opens over it.
			className={cn("relative flex size-full min-h-0", withActs && "isolate")}
			// The act layer's plates and buttons are game-kit pieces: with acts
			// the world carries the kit's tokens (old hosts are unchanged).
			data-game-accent={withActs ? "leaf" : undefined}
			data-game-shell={withActs ? "" : undefined}
			data-testid="interface-world-2d"
			style={SV_VARIABLES}
		>
			{withActs ? <style>{GAME_KIT_CSS}</style> : null}
			<div
				aria-busy={loading}
				aria-label={
					withActs
						? "Agent world. Use arrow keys or WASD to walk, E to talk or answer."
						: "Agent world. Use arrow keys or WASD to walk, E to talk."
				}
				className="relative min-w-0 flex-1 overflow-hidden outline-none focus-visible:shadow-[inset_0_0_0_3px_var(--sv-focus)]"
				onKeyDown={onKeyDown}
				ref={world.mapRef}
				role="application"
				style={{ background: pixel.backdrop }}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the map is a keyboard-driven game surface (role="application").
				tabIndex={0}
			>
				<div className="absolute inset-0" ref={viewport.ref}>
					<div aria-hidden="true" className="absolute top-0 left-0">
						<canvas
							className="block [image-rendering:pixelated]"
							height={view.height}
							ref={canvasRef}
							style={{ height: view.height * SCALE, width: view.width * SCALE }}
							width={view.width}
						/>
					</div>
					<div className="absolute top-0 left-0" ref={overlayRef}>
						{layout.entities.map((entity) => (
							<AgentActor
								asking={askerAsk(entity.agentId) !== null}
								emote={
									(withActs
										? statuses.get(entity.agentId) === "working"
										: entity.status === "working") ||
									needsYou(statuses.get(entity.agentId) ?? "idle")
								}
								entity={placedEntity(entity)}
								indoor={indoor}
								key={entity.agentId}
								margin={frame.margin}
								near={nearbyId === entity.agentId}
								onTalk={talkTo}
								talking={talkingId === entity.agentId}
							/>
						))}
						<PlayerMarker elementRef={playerRef} />
					</div>
				</div>
				<div
					className="pointer-events-none absolute inset-0 z-[400] select-none"
					data-testid="world-hud"
				>
					<div className="absolute top-3 left-3 flex items-start gap-2">
						{/* Outdoors the village sign names the place. */}
						{indoor ? <LocationPlaque title={title} /> : null}
						{bar.helpInBar || !settled ? null : (
							<HelpButton onToggle={toggleHint} open={hint.open} size={42} />
						)}
						{controls && hintOnTop ? (
							<div style={{ maxWidth: hintRoom }}>
								<ControlsPlank>{controls}</ControlsPlank>
							</div>
						) : null}
						{/* Where the strip was: a small plank that brings it back. */}
						{bar.helpInBar && hintOnTop && settled && !hint.open ? (
							<ControlsToggle onToggle={toggleHint} />
						) : null}
					</div>
					<div className="absolute top-3 right-3 flex flex-col items-end gap-2">
						<ClockBox
							compact={viewport.size.width < 760}
							needYouCount={needYouCount}
							showStatus={settled}
							workingCount={workingCount}
						/>
					</div>
					{empty ? <EmptyVillage onStart={() => port.startThread({})} /> : null}
					<div className="absolute inset-x-3 bottom-3 flex flex-col items-center gap-2">
						{controls && !hintOnTop ? (
							<div className="max-w-full self-start">
								<ControlsPlank>{controls}</ControlsPlank>
							</div>
						) : null}
						<PromptTooltip visuallyHidden={loading && !world.nearby}>
							{prompt}
						</PromptTooltip>
						{loading ? <HotbarPlaceholder size={bar.size} /> : null}
						{settled ? (
							<Hotbar
								activeId={talkingId ?? nearbyId}
								agents={hotbarAgents}
								helpInBar={bar.helpInBar}
								helpOpen={hint.open}
								mapOpen={mapOpen}
								onPage={turnPage}
								onToggleHelp={toggleHint}
								onToggleMap={toggleMap}
								onVisit={talkTo}
								page={hotbar.page}
								pageCount={hotbar.pageCount}
								size={bar.size}
							/>
						) : null}
					</div>
					{mapOpen && settled ? (
						<div className="absolute inset-0 z-10 flex items-center justify-center p-3">
							{/* Clicking off the map closes it; the visible "X" (and Esc
							    or M) are the accessible ways out. */}
							<button
								aria-hidden="true"
								className="pointer-events-auto absolute inset-0 cursor-default bg-(--sv-outline)/45 outline-none"
								onClick={toggleMap}
								tabIndex={-1}
								type="button"
							/>
							<div className="relative">
								<VillageMap
									layout={layout}
									maxWidth={viewport.size.width - 64}
									nearbyId={nearbyId}
									onClose={toggleMap}
									onVisit={visitFromMap}
									pixel={pixel}
									player={shownPlayer}
									pond={furniture.pond}
									roofs={roofs}
									statuses={statuses}
									title={title}
									village={village}
								/>
							</div>
						</div>
					) : null}
				</div>
			</div>
			{withActs ? (
				// Siblings of the map (never inside role="application"), so its
				// digit / M / [ / ] / ? keys never see theirs.
				<>
					<h1 className="sr-only" ref={worldHeadingRef} tabIndex={-1}>
						World 2D
					</h1>
					<div
						// While talking the panel takes the right of the stage: the
						// column moves left of it (wide), or steps out (narrow, where
						// the panel covers the map) so nothing hides in the Tab order.
						className={cn(
							"pointer-events-none absolute right-3 z-[450] flex max-w-[calc(100%-24px)] flex-col items-end gap-2",
							talkingAgent &&
								"max-sm:hidden sm:right-[calc(clamp(320px,40%,440px)+12px)] sm:max-w-[calc(60%-24px)]"
						)}
						// Below the village clock.
						style={{ top: viewport.size.width < 760 ? 156 : 184 }}
					>
						<p
							className={cn(
								GAME_PLATE,
								"pointer-events-auto w-fit max-w-full truncate rounded-xl px-3 py-1.5 font-semibold text-[13px]"
							)}
							data-act-summary=""
						>
							{actSummaryLine(totals)}
						</p>
						<div className="pointer-events-auto">
							<BlindSpotCaption snapshot={snapshot} />
						</div>
						<div className="pointer-events-auto flex gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={totals}
							/>
							<QueueButton
								acts={acts}
								clock={clock}
								narrow={viewport.size.width < 640}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								openRef={queueOpener}
								snapshot={snapshot}
								totals={totals}
								unowned={unowned}
							/>
						</div>
					</div>
					{/* Over the map's HUD (z-400) and the act plate (z-450): a
					    revealed list is never painted under them. */}
					<div className="pointer-events-none absolute inset-0 z-[460] [&_button]:pointer-events-auto [&_ul]:pointer-events-auto">
						<AskQueueList
							acts={acts}
							clock={clock}
							fallbackFocus={worldHeadingRef}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							snapshot={snapshot}
							unowned={unowned}
						/>
						<ActAgentList
							acts={acts}
							clock={clock}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							onOpenThread={hostPort.openThread}
							revealOnFocus
							snapshot={snapshot}
						/>
					</div>
					<ActAnnouncer sentence={sentence} />
				</>
			) : null}
			{cards.element}
			{talkingAgent ? (
				<World2dActed.Provider value={withActs}>
					<World2dActLines.Provider value={actLines}>
						<World2dPanel
							activeThreadId={activeThreadId}
							agent={talkingAgent}
							lookIndex={layout.entities.findIndex(
								(entity) => entity.agentId === talkingAgent.id
							)}
							onClose={world.walkAway}
							port={port}
							status={statuses.get(talkingAgent.id) ?? "idle"}
							threads={talkingThreads}
							threadView={threadView}
						/>
					</World2dActLines.Provider>
				</World2dActed.Provider>
			) : null}
		</div>
	);
}
