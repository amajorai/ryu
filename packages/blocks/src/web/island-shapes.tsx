"use client";

/*
 * The Island's shape vocabulary — sizes, springs, glass skins, the Siri-border
 * CSS and the mini-island action pills — factored out of `global-island.tsx` so
 * more than one surface can draw a 1:1 island without re-typing the constants.
 *
 * Two surfaces use it today:
 *   - `global-island.tsx` — the draggable, persistent site chrome.
 *   - `hero-workflow-loop.tsx` — the scripted landing-page demo island.
 *
 * Everything here is copied verbatim from the real desktop Island
 * (apps/island `Island.tsx` + `island-config.ts`); keep it that way, since the
 * whole point of these blocks is that the marketing site shows the real thing.
 */

import { cn } from "@ryu/ui/lib/utils";
import { MotionConfig, motion } from "motion/react";
import type { CSSProperties } from "react";
import styles from "./island-shapes.module.css";
import type { IslandState } from "./island-store.ts";

/* ── island-config (inlined from apps/island/.../island-config.ts) ─────────── */

export const LOGO_CIRCLE = { width: 40, height: 40, radius: 20 } as const;
export const SPLIT_GAP = 8;
interface IslandDetailSize {
	height: number;
	radius: number;
	width: number;
}

/** Complete authored state catalogue; collapsed has no detail panel by default.
 * The public optional mutable slots retain existing consumer extension behavior.
 */
type IslandDetailSizes = { [State in IslandState]?: IslandDetailSize };

export const DETAIL_SIZES: IslandDetailSizes = {
	idle: { width: 96, height: 40, radius: 20 },
	suggestion: { width: 300, height: 62, radius: 20 },
	expanded: { width: 400, height: 480, radius: 28 },
	promo: { width: 400, height: 440, radius: 28 },
};
export const ACTION_PILL_WIDTH = 72;
export const ACTION_PILL_HEIGHT = 30;
export const SUGGESTION_STACK_GAP = 8;
export const ISLAND_SPRING = {
	type: "spring",
	bounce: 0.16,
	duration: 0.5,
} as const;
export const CONTENT_SPRING = {
	type: "spring",
	bounce: 0.12,
	duration: 0.35,
} as const;

/* ── shape skins (verbatim from Island.tsx — the "latest" Siri-border look) ── */

export const ISLAND_SURFACE_BASE = `${styles.siriBorder} relative shrink-0 overflow-hidden shadow-2xl`;
export const TRANSLUCENT_SKIN =
	"bg-gradient-to-b from-neutral-950/85 via-neutral-950/65 to-neutral-900/35 text-neutral-100 backdrop-blur-2xl";
export const ACTION_PILL_BASE = `${styles.siriBorder} relative flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-full font-medium text-xs shadow-xl backdrop-blur-2xl`;
export const ACTION_PILL_PRIMARY =
	"bg-warning/25 text-primary-foreground hover:bg-warning/40";
export const ACTION_PILL_DEFAULT =
	"bg-space-home-dark/70 text-space-rail-icon hover:bg-space-template-board-dark/85";

/* ── the Siri border + snap-zone overlay CSS, mirrored from the real app ────── */

/* ── action mini-islands (verbatim morph from Island.tsx) ──────────────────── */

export interface IslandAction {
	key: string;
	label: string;
	onClick?: () => void;
	primary?: boolean;
	width?: number;
}

/**
 * The row of mini-islands that morphs out from under a suggestion. `pressedKey`
 * is for scripted demos: it draws the pointer-down state of one pill without a
 * real pointer being over it.
 */
export function IslandActionPills({
	actions,
	pressedKey,
}: {
	actions: IslandAction[];
	pressedKey?: string | null;
}) {
	return (
		<MotionConfig reducedMotion="user">
			<div
				className={cn("flex", styles.dynamic1)}
				style={
					{
						"--blocks-gap": `${SPLIT_GAP}px`,
						"--blocks-marginLeft": `${LOGO_CIRCLE.width + SPLIT_GAP}px`,
						"--blocks-marginTop": `${SUGGESTION_STACK_GAP}px`,
					} satisfies PrivateStyle as PrivateStyle
				}
			>
				{actions.map((action, index) => (
					<motion.button
						animate={{
							width: action.width ?? ACTION_PILL_WIDTH,
							opacity: 1,
							scale: pressedKey === action.key ? 0.92 : 1,
						}}
						className={cn(
							ACTION_PILL_BASE,
							action.primary ? ACTION_PILL_PRIMARY : ACTION_PILL_DEFAULT,
							pressedKey === action.key &&
								"ring-2 ring-space-paper-line-placeholder/70",
							styles.dynamic4
						)}
						initial={{ width: 0, opacity: 0 }}
						key={action.key}
						onClick={action.onClick}
						style={
							{
								"--blocks-height": `${ACTION_PILL_HEIGHT}px`,
							} satisfies PrivateStyle as PrivateStyle
						}
						transition={{ ...ISLAND_SPRING, delay: index * 0.05 }}
						type="button"
					>
						{action.label}
					</motion.button>
				))}
			</div>
		</MotionConfig>
	);
}

interface PrivateStyle extends CSSProperties {
	"--blocks-gap"?: CSSProperties["gap"];
	"--blocks-height"?: CSSProperties["height"];
	"--blocks-marginLeft"?: CSSProperties["marginLeft"];
	"--blocks-marginTop"?: CSSProperties["marginTop"];
}
