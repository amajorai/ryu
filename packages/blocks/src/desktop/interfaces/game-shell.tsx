import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, X } from "lucide-react";
import { motion } from "motion/react";
import {
	type CSSProperties,
	type KeyboardEventHandler,
	type ReactNode,
	type Ref,
	useEffect,
} from "react";
import { ensureGameDisplayFont } from "./game-font.ts";
import { GAME_FOCUS, GameIconButton } from "./game-hud.tsx";
import { GAME_KIT_CSS, type GameAccent } from "./game-palette.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * The game kit: one shell, one HUD style and one side sheet that every game
 * interface (Kitchen, Town, Farm, Arcade, ...) adopts the same way, so the
 * games read as one product instead of office chrome over a picture.
 *
 * Files:
 * - `game-shell.tsx` (this file): `GameShell`, `GameHudSlot`, `GameSheet`,
 *   `gameSheetCover`.
 * - `game-hud.tsx`: the in-world HUD primitives, `GameTitlePlate`,
 *   `GameCounters` + `GameCounter`, `GameAction`, `GameLegend`,
 *   `GameIconButton`, `GameAgentCard`, `GamePlate`, and the class strings
 *   `GAME_PLATE` and `GAME_FOCUS`.
 * - `game-palette.ts`: the HUD's day and night colours (the only literal
 *   colours in the kit) and the accents a game can pick.
 * - `game-font.ts`: the bundled rounded display face (Fredoka, OFL).
 *
 * How a game adopts it:
 * 1. Render `<GameShell accent="tomato" label="Kitchen" hud={...}
 *    sheet={...}>{scene}</GameShell>` as the interface root. The children
 *    are the scene: it fills the whole interface edge to edge (no margins,
 *    no app bar). Paint the scene's own surroundings to the edges too (the
 *    floor, the grass, the carpet), never the theme background.
 * 2. Put the HUD in `hud`, placed with `GameHudSlot` (`top-left` for the
 *    title plate, `top-right` for the one primary `GameAction`,
 *    `bottom-left` for `GameCounters`, `bottom-right` for a clock or
 *    `GameLegend`). The HUD floats over the scene; only its plates take
 *    pointer events. Keep one primary action per game.
 * 3. Show the open thread or an agent in `sheet` with `GameSheet`: a framed
 *    sheet docked right over the scene (full screen on narrow stages). Its
 *    body is the user's theme, so the host's `threadView`, composers and
 *    lists look like the rest of the app inside the game frame. When the
 *    sheet is open the HUD layer shrinks to the uncovered part; scenes with
 *    a camera can call `gameSheetCover(width)` to reframe beside it. A game
 *    whose sheet needs more room (a passport booklet) passes `sheetWidth`
 *    to `GameShell` and the same width to `gameSheetCover(width, sheetWidth)`;
 *    `GameSheet bleed` fills a phone edge to edge.
 * 4. Give focusable things in the scene (name plates, plots, cabinets) the
 *    `GAME_FOCUS` class so keyboard focus is a thick ring visible on art.
 *
 * Light themes are day and dark themes are night (`.dark`), with no
 * JavaScript theme reads. Motion in the kit respects reduced motion.
 */

/** The sheet's width on wide stages, and the gap it keeps from the edges. */
const SHEET_WIDTH = 440;
const SHEET_GAP = 12;
/** Below this stage width the sheet covers the whole interface. */
export const GAME_SHEET_FULL_BELOW = 672;

/**
 * How many pixels of the stage's right side an open sheet covers, so a scene
 * camera can frame its world in the rest. On a narrow stage it is all of it.
 */
export function gameSheetCover(
	stageWidth: number,
	sheetWidth: number = SHEET_WIDTH
): number {
	if (stageWidth < GAME_SHEET_FULL_BELOW) {
		return stageWidth;
	}
	return Math.min(sheetWidth, stageWidth - SHEET_GAP * 2) + SHEET_GAP * 2;
}

export function GameShell({
	accent,
	busy,
	children,
	hud,
	label,
	onKeyDown,
	rootRef,
	sheet,
	sheetWidth,
	stageRef,
	testId,
	...data
}: {
	accent: GameAccent;
	busy?: boolean;
	/** The scene: fills the whole interface under the HUD. */
	children: ReactNode;
	hud?: ReactNode;
	/** The stage's accessible name (the game's name). */
	label: string;
	onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
	rootRef?: Ref<HTMLDivElement>;
	/** A `GameSheet` when a thread or an agent is open, else null. */
	sheet?: ReactNode;
	/** The sheet's width on wide stages (default 440px). */
	sheetWidth?: number;
	stageRef?: Ref<HTMLElement>;
	testId?: string;
	/** Extra `data-*` attributes for the root (a game's own CSS scope). */
	[data: `data-${string}`]: string | undefined;
}) {
	useEffect(() => {
		ensureGameDisplayFont();
	}, []);
	const sheetOpen = sheet !== null && sheet !== undefined && sheet !== false;
	return (
		<div
			className="@container/game relative isolate flex size-full min-h-0 overflow-hidden bg-(--gk-backdrop) text-(--gk-ink)"
			data-game-accent={accent}
			data-game-shell=""
			data-sheet-open={sheetOpen ? "" : undefined}
			data-testid={testId}
			onKeyDown={onKeyDown}
			ref={rootRef}
			style={
				sheetWidth
					? ({ "--gk-sheet-w": `${sheetWidth}px` } as CSSProperties)
					: undefined
			}
			{...data}
		>
			<style>{GAME_KIT_CSS}</style>
			<section
				aria-busy={busy}
				aria-label={label}
				className="absolute inset-0 isolate overflow-hidden"
				ref={stageRef}
			>
				{children}
			</section>
			{hud ? (
				<div
					className={cn(
						"pointer-events-none absolute inset-0 z-20",
						sheetOpen &&
							"@min-[672px]/game:right-[calc(min(var(--gk-sheet-w,440px),100%-24px)+24px)] @max-[671px]/game:hidden"
					)}
					data-game-hud=""
				>
					{hud}
				</div>
			) : null}
			{sheet}
		</div>
	);
}

const SLOT = {
	bottom: "inset-x-0 bottom-0 justify-center items-end",
	"bottom-left": "bottom-0 left-0 items-end",
	"bottom-right": "bottom-0 right-0 items-end justify-end",
	top: "inset-x-0 top-0 justify-center",
	"top-left": "top-0 left-0",
	"top-right": "top-0 right-0 justify-end",
} as const;

/** A corner (or edge) of the HUD, inset from the stage like a game's HUD. */
export function GameHudSlot({
	at,
	children,
	className,
}: {
	at: keyof typeof SLOT;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"absolute flex max-w-full @min-[672px]/game:gap-3 gap-2 @min-[672px]/game:p-4 p-2.5",
				SLOT[at],
				className
			)}
		>
			{children}
		</div>
	);
}

/**
 * The side sheet: a game frame docked right over the scene (the whole
 * interface on narrow stages) whose body is the user's theme. The header
 * holds Back (when there is somewhere to go back to), the heading (focused
 * by the game when the sheet opens) and Close.
 */
export function GameSheet({
	backLabel,
	bleed = false,
	children,
	closeLabel = "Close",
	eyebrow,
	footer,
	headingRef,
	id,
	label,
	leading,
	onBack,
	onClose,
	sheetKey,
	subtitle,
	title,
	...data
}: {
	backLabel?: string;
	/** On a narrow stage, fill it edge to edge (no frame margin). */
	bleed?: boolean;
	/** The body, on the theme's surface. */
	children: ReactNode;
	closeLabel?: string;
	/** A small line over the heading (what kind of record this is). */
	eyebrow?: ReactNode;
	/** Pinned under the body (a composer), also on the theme's surface. */
	footer?: ReactNode;
	headingRef?: Ref<HTMLHeadingElement>;
	/** For `aria-controls` on whatever opened the sheet. */
	id?: string;
	/** The sheet's accessible name. */
	label: string;
	/** An avatar or icon before the heading. */
	leading?: ReactNode;
	onBack?: () => void;
	onClose: () => void;
	/** Changing it replays the entrance (a different thread or agent). */
	sheetKey?: string;
	subtitle?: ReactNode;
	title: ReactNode;
	[data: `data-${string}`]: string | undefined;
}) {
	const tl = useLiteralMessages();
	const reduced = useReducedMotion();
	return (
		<motion.aside
			animate={{ opacity: 1, transform: "translateX(0px)" }}
			aria-label={label}
			className={cn(
				"absolute @min-[672px]/game:inset-y-3 @min-[672px]/game:right-3 @min-[672px]/game:left-auto z-30 flex min-h-0 @min-[672px]/game:w-[min(var(--gk-sheet-w,440px),calc(100%-24px))] flex-col overflow-hidden @min-[672px]/game:rounded-[22px] @min-[672px]/game:border-2 border-(--gk-edge) bg-(--gk-plate) text-(--gk-ink) shadow-(--gk-lip)",
				bleed
					? "inset-0 rounded-none border-0"
					: "inset-2 rounded-[22px] border-2"
			)}
			data-game-sheet=""
			id={id}
			initial={reduced ? false : { opacity: 0, transform: "translateX(24px)" }}
			key={sheetKey}
			transition={{ duration: 0.2, ease: "easeOut" }}
			{...data}
		>
			<header className="flex shrink-0 items-center gap-2.5 py-2.5 ps-2.5 pe-2.5">
				{onBack ? (
					<GameIconButton
						label={backLabel ?? "Back"}
						onClick={onBack}
						title={tl("{label} (Esc)", { label: backLabel ?? "Back" })}
					>
						<ArrowLeft
							aria-hidden="true"
							className="size-5"
							strokeWidth={2.5}
						/>
					</GameIconButton>
				) : null}
				{leading ? (
					<span className={cn("shrink-0", onBack ? undefined : "ps-1")}>
						{leading}
					</span>
				) : null}
				<div
					className={cn(
						"flex min-w-0 flex-1 flex-col",
						!(onBack || leading) && "ps-2"
					)}
				>
					{eyebrow ? (
						<p className="truncate font-semibold text-(--gk-ink-soft) text-[12px] uppercase leading-4 tracking-wide">
							{eyebrow}
						</p>
					) : null}
					<h2
						className={cn(
							"gk-display truncate rounded-md text-[20px] leading-7",
							GAME_FOCUS
						)}
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					{subtitle ? (
						<div className="flex min-w-0 items-center gap-1.5 truncate font-medium text-(--gk-ink-muted) text-[13px] leading-5">
							{subtitle}
						</div>
					) : null}
				</div>
				<GameIconButton
					label={closeLabel}
					onClick={onClose}
					title={tl("{label} (Esc)", { label: closeLabel })}
				>
					<X aria-hidden="true" className="size-5" strokeWidth={2.5} />
				</GameIconButton>
			</header>
			<div className="mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border-(--gk-edge) border-2 bg-background text-foreground">
				<div className="flex min-h-0 flex-1 flex-col">{children}</div>
				{footer ? (
					<div className="shrink-0 border-border border-t p-3">{footer}</div>
				) : null}
			</div>
		</motion.aside>
	);
}
