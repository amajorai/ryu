import type { LiteralMessage } from "@ryu/i18n/react";
import type { HandLabelPlacement } from "./card-table-hand.tsx";
import {
	type HandLayout,
	HOVER_LIFT,
	handPose,
	handTop,
	MAX_SEATS,
	NEIGHBOUR_PART,
	PLATE_HALF,
	poseBounds,
	poseCorners,
	type StageSize,
	type TableGeometry,
} from "./card-table-model.ts";
import type { SeatMenuAlign, SeatMenuSide } from "./card-table-seat.tsx";

/**
 * The Card Table renderer's layout maths and HUD words: where the rail, the
 * seat menus and the hand's label go, and the title plate's summary. Split
 * out of `card-table-interface.tsx`.
 */

export const SEAT_SLOTS = Array.from({ length: MAX_SEATS }, (_, slot) => slot);
/** The interface's width until it is measured (and in static renders). */
export const DEFAULT_ROOT_WIDTH = 1440;
/** The rail opens as a panel only on a stage at least this wide. */
const RAIL_PANEL_MIN_STAGE = 1200;
/** The rail panel's width and inset (w-56, top-3/left-3). */
const RAIL_PANEL_WIDTH = 224;
export const RAIL_INSET = 12;
/** Under this height the rail panel would be a scroll box; it folds instead. */
const RAIL_PANEL_MIN_HEIGHT = 96;
/** Gap between the fan's first card and the label beside it. */
const LABEL_GAP = 12;
/** Under this felt width the pot's pile shrinks, clear of the seats' chips. */
const NARROW_FELT = 720;
/** The legend keeps this far from the stage's right edge, like the HUD. */
export const LEGEND_INSET = 16;
/** Narrower than this the legend's lines no longer fit; it is left out. */
export const LEGEND_MIN_WIDTH = 168;
/** Room the HUD's top plates take above the table. */
export const HUD_TOP = "@min-[672px]/game:top-[76px] top-[64px]";
/** The same room in pixels on a wide stage, for the room's camera. */
export const HUD_TOP_PX = 76;
/** With the act HUD (need-you, Queue, caption) the rail panel starts lower. */
export const ACT_RAIL_TOP = 112;
/** Below this width the off-stage tally shows its count only. */
export const PHONE_HUD_BELOW = 640;
/** Below this table width the HUD plates go compact. */
export const COMPACT_HUD_BELOW = 900;
/** The island's rim round the card room. */
export const ISLAND_RIM = 2.2;
/** Phones frame the room tight on its seat plates: little rim around them. */
export const PHONE_ROOM_FIT = { above: 0.9, below: 1.6, max: 2.2, side: 0.4 };
/** How much of a card's height a phone's tucked hand shows over the edge. */
export const HAND_PEEK = 0.46;

/**
 * Where the rail goes: a panel in the top-left corner when agents wait on it,
 * the stage is wide, and the panel can stop above the seats under it;
 * otherwise a pill.
 */
export function railFit(
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
export function potChipSize(geometry: TableGeometry): number {
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
export function seatMenuPlacement(
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
export function labelPlacement(
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
 * The room's camera insets: it fits above the hand (or the empty hand's
 * note) and below the HUD; phones lift it under the HUD (it is framed by
 * its width, so the extra room below only moves it up).
 */
export function roomInsets(
	stageHeight: number,
	handEdge: number,
	compact: boolean,
	actsOn: boolean
) {
	return {
		bottom:
			Math.max(24, stageHeight - handEdge + 8) +
			(compact ? Math.round(stageHeight * 0.16) : 0),
		left: 16,
		right: 16,
		// The act HUD adds a row of buttons and the blind-spot caption.
		top: HUD_TOP_PX + 8 + (actsOn ? 64 : 0),
	};
}

/** The counts the title plate's summary reads (without acts). */
export interface TableSummaryCounts {
	agents: number;
	running: number;
	waiting: number;
}

/**
 * The title plate's status without acts: "Dealing…" while loading, then
 * "3 agents · 1 running · 2 waiting on you" as one ICU message, so each
 * count agrees with its words in every UI language.
 */
export function tableSummary(
	counts: TableSummaryCounts | null,
	tl: LiteralMessage
): string {
	if (!counts) {
		return tl("Dealing…");
	}
	return tl(
		"{agents, plural, one {# agent} other {# agents}} · {running, plural, other {# running}} · {waiting, plural, other {# waiting on you}}",
		counts
	);
}
