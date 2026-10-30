import { cn } from "@ryu/ui/lib/utils";
import { Ghost, Gift, Lamp } from "lucide-react";
import type { ReactNode } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import type { IsoPortrait } from "./game3d-stage.tsx";
import {
	plural,
	type Season,
	type SeasonBoard,
	type SeasonCopy,
} from "./seasonal-model.ts";

/** Below this stage width the HUD plates go compact. */
export const COMPACT_BELOW = 900;
/** Room the HUD's top plates take above the diorama. */
export const HUD_TOP = 84;
export const HUD_TOP_COMPACT = 68;
/** The extra room the act layer's HUD row (Need you, Queue) takes. */
export const HUD_ACTS = 64;
/** The gap kept under the HUD's measured bottom. */
export const HUD_GAP = 4;
/**
 * How much closer the camera frames the board with the act layer on (the
 * patch's cast stands in its furrows, closest together).
 */
export const ACTS_FILL: Record<Season, number> = {
	advent: 1.25,
	halloween: 1.4,
	"lunar-new-year": 1.25,
};
/**
 * How each diorama frames a phone with the act layer on: a steeper look,
 * turned a little, spreads the cast down the tall screen so its plates
 * part (the village's square and the street's wires run up it).
 */
export const ACT_PORTRAIT: Record<Season, IsoPortrait> = {
	advent: { pitch: 1.45, yaw: Math.PI / 4 + 0.35 },
	halloween: { pitch: 1.3, yaw: Math.PI / 4 - 0.35 },
	"lunar-new-year": { fill: 1.1, pitch: 1.45, yaw: Math.PI / 4 + 0.35 },
};
/** The island's rim round each diorama, for the woods and the shore. */
export const ISLAND_RIM = 2.4;
/** The gift card's width, and its inset from the stage's edge. */
export const GIFT_WIDTH = 340;
export const GIFT_INSET = 16;

export type SidePanel = "all" | "compose" | "more" | null;

/** The title plate's count line: totals, with what needs you. */
export function headerSummary(board: SeasonBoard, copy: SeasonCopy): string {
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
export const DIORAMA_LABEL: Record<Season, string> = {
	advent:
		"a snowy village square round an advent house whose 24 numbered doors and windows are conversations.",
	halloween:
		"a night pumpkin patch of 24 numbered pumpkins, one per conversation.",
	"lunar-new-year":
		"a lantern festival street hung with 24 numbered lanterns, one per conversation.",
};

export const SEASON_ICON: Record<Season, ReactNode> = {
	advent: <Gift aria-hidden="true" />,
	halloween: <Ghost aria-hidden="true" />,
	"lunar-new-year": <Lamp aria-hidden="true" />,
};

/** A HUD plate button (the season choice, More, All doors). */
/** The season switcher's option that follows the date (the `auto` setting). */
export const FROM_TODAY = "From today's date";

export const PLATE_BUTTON = cn(
	GAME_PLATE,
	GAME_FOCUS,
	"gk-display pointer-events-auto inline-flex h-12 shrink-0 items-center gap-2 px-4 text-[16px] transition-colors hover:bg-(--gk-plate-sunk) aria-pressed:bg-(--gk-plate-sunk)"
);
