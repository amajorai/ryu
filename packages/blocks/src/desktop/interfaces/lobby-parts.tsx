import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent, ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { ComponentProps, ReactNode } from "react";
import { SQUAD_STATE_LABELS, type SquadState } from "./lobby-model.ts";
import { figureColors } from "./lobby-palette.ts";
import { LobbyBust, topperFor } from "./lobby-portrait.tsx";

/**
 * Display type: heavy upright condensed caps. The bundled condensed face
 * (lobby-font.ts) comes first so the look never depends on the OS, then the
 * theme's heading face. Line height is an arbitrary property so a size class
 * after it (merged by `cn`) cannot drop it. The slant lives in the panel
 * shapes, never in the letters.
 */
export const DISPLAY =
	"font-extrabold! [font-family:'Ryu_Lobby_Display',var(--font-heading)] uppercase tracking-[0.005em] [line-height:0.92]";

/** Small label type: bold caps with open tracking. */
export const KICKER =
	"font-bold! font-heading text-[11px] uppercase leading-4 tracking-[0.08em]";

/**
 * A hero tile with its top-right corner cut, the lobby's panel shape. Kept
 * for the few large surfaces (roster cards, the featured story, the mode
 * card); rows and lists stay square.
 */
export const CUT_CORNER =
	"[clip-path:polygon(0_0,calc(100%-20px)_0,100%_20px,100%_100%,0_100%)]";

/**
 * The same cut, 1px inside: 20 − (√2 − 1) keeps the diagonal stroke as thick
 * as the straight edges.
 */
const CUT_CORNER_INNER =
	"[clip-path:polygon(0_0,calc(100%-19.6px)_0,100%_19.6px,100%_100%,0_100%)]";

/**
 * An outlined cut-corner panel. A ring would be clipped off the diagonal, so
 * the stroke is the outer layer's fill showing around a 1px-inset surface.
 */
export function CutFrame({
	children,
	className,
	stroke = "border",
	...props
}: ComponentProps<"div"> & { stroke?: "border" | "primary" }) {
	return (
		<div
			className={cn(
				"relative",
				CUT_CORNER,
				stroke === "primary" ? "bg-primary" : "bg-border",
				className
			)}
			{...props}
		>
			<span
				aria-hidden="true"
				className={cn("absolute inset-px bg-background", CUT_CORNER_INNER)}
			/>
			{children}
		</div>
	);
}

/** An agent's own picture, as a round badge on the portrait. */
function LobbyAvatarImage({
	className,
	src,
}: {
	className?: string;
	src: string;
}) {
	return (
		<Avatar
			aria-hidden="true"
			className={cn("before:hidden", className)}
			data-testid="lobby-avatar"
		>
			<AvatarImage alt="" src={src} />
			<AvatarFallback className="bg-transparent" />
		</Avatar>
	);
}

/**
 * A squad member's portrait: the operator bust in the agent's own hue (see
 * lobby-portrait.tsx), with the agent's own picture as a badge on the chest
 * when it has one. Decorative; the surrounding control names it.
 */
export function LobbyFigure({
	agent,
	className,
	state = "ready",
}: {
	agent: InterfaceAgent;
	className?: string;
	state?: SquadState;
}) {
	return (
		<div
			aria-hidden="true"
			className={cn("relative aspect-[4/5] w-full", className)}
			data-face={state}
			data-testid="lobby-figure"
		>
			<LobbyBust
				className="absolute inset-0 size-full overflow-visible"
				colors={figureColors(agent)}
				state={state}
				topper={topperFor(agent)}
			/>
			{agent.avatarUrl ? (
				<LobbyAvatarImage
					className="absolute bottom-[3%] left-1/2 size-[22%] -translate-x-1/2 ring-2 ring-black/40"
					src={agent.avatarUrl}
				/>
			) : null}
		</div>
	);
}

/**
 * The portrait's head on its own, for rows and menus where the whole bust
 * would not fit: the helmet and visor on a tile of the agent's hue.
 */
export function LobbyHead({
	agent,
	className,
	state = "ready",
}: {
	agent: InterfaceAgent;
	className?: string;
	state?: SquadState;
}) {
	const colors = figureColors(agent);
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative flex size-8 shrink-0 overflow-hidden rounded-[30%]",
				className
			)}
			style={{
				background: colors.lit,
				boxShadow: `inset 0 0 0 1.5px ${colors.outline}`,
			}}
		>
			{agent.avatarUrl ? (
				<LobbyAvatarImage className="size-full" src={agent.avatarUrl} />
			) : (
				<LobbyBust
					className="absolute inset-[6%] size-[88%]"
					colors={colors}
					state={state}
					topper={topperFor(agent)}
					viewBox="14 6 92 92"
				/>
			)}
		</span>
	);
}

/** A thread's status as a small dot beside its title. */
export const STATUS_DOT: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-muted-foreground/40",
	waiting: "bg-info",
	working: "bg-success motion-safe:animate-pulse",
	"your-turn": "bg-warning",
};

/**
 * Every chip is the same neutral plate (foreground on background, which
 * clears 4.5:1 in every theme); the marker is the only color, so the four
 * states read as one component. None of the markers is the theme's primary,
 * so the states stay apart when the primary sits near success or
 * destructive.
 */
const STATE_CHIP: Record<SquadState, string> = {
	downed: "text-foreground",
	"in-match": "text-foreground",
	"needs-you": "text-foreground",
	ready: "text-foreground/80",
	waiting: "text-foreground/80",
};

const STATE_MARK: Record<SquadState, string> = {
	downed: "bg-destructive",
	"in-match": "bg-success",
	"needs-you": "bg-warning",
	ready: "bg-muted-foreground/50",
	waiting: "bg-muted-foreground",
};

/** READY / IN MATCH / NEEDS YOU / DOWNED. */
export function LobbyStateChip({
	className,
	state,
}: {
	className?: string;
	state: SquadState;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 -skew-x-12 items-center gap-1.5 whitespace-nowrap bg-background px-2",
				KICKER,
				"text-[10px]",
				STATE_CHIP[state],
				className
			)}
			data-state={state}
		>
			<span className="inline-flex skew-x-12 items-center gap-1.5">
				<span aria-hidden="true" className="relative flex size-2">
					{state === "in-match" ? (
						<span className="absolute inset-0 rounded-full bg-success motion-safe:animate-ping" />
					) : null}
					<span
						className={cn("relative size-2 rounded-full", STATE_MARK[state])}
					/>
				</span>
				{SQUAD_STATE_LABELS[state]}
			</span>
		</span>
	);
}

/** XP reward chip on a quest: a small gold kit plate. */
export function LobbyXpChip({ xp }: { xp: string }) {
	return (
		<span className="gk-display inline-flex h-6 shrink-0 items-center rounded-lg border-(--gk-edge) border-2 bg-(--gk-gold) px-2 text-(--gk-edge) text-[13px] tabular-nums leading-none shadow-[0_2px_0_var(--gk-edge)]">
			+{xp} XP
		</span>
	);
}

/** A slanted progress track. The numbers beside it carry the meaning. */
export function LobbyProgress({
	className,
	complete,
	goal,
	label,
	value,
}: {
	className?: string;
	complete?: boolean;
	goal: number;
	label: string;
	value: number;
}) {
	const ratio = goal > 0 ? Math.min(1, Math.max(0, value / goal)) : 0;
	return (
		<div
			aria-label={label}
			aria-valuemax={goal}
			aria-valuemin={0}
			aria-valuenow={Math.min(value, goal)}
			className={cn(
				"h-2 -skew-x-12 overflow-hidden bg-foreground/10",
				className
			)}
			role="progressbar"
		>
			<div
				className={cn(
					"h-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
					complete ? "bg-primary" : "bg-foreground/70"
				)}
				style={{ width: `${ratio * 100}%` }}
			/>
		</div>
	);
}

type ChunkyTone = "primary" | "quiet" | "secondary";
type ChunkySize = "lg" | "md" | "sm";

const CHUNKY_TONE: Record<ChunkyTone, string> = {
	primary:
		"gk-action bg-(--gk-accent) text-(--gk-accent-ink) enabled:hover:brightness-105 disabled:opacity-60",
	quiet:
		"text-(--gk-ink) hover:bg-(--gk-plate-sunk) active:bg-(--gk-plate-sunk) disabled:text-(--gk-ink-soft)",
	secondary:
		"border-2 border-(--gk-edge) bg-(--gk-plate) text-(--gk-ink) shadow-[0_2px_0_var(--gk-edge)] hover:bg-(--gk-plate-sunk) enabled:active:shadow-none disabled:opacity-50",
};

const CHUNKY_SIZE: Record<ChunkySize, string> = {
	lg: "h-12 px-6 text-[19px] rounded-2xl",
	md: "h-10 px-4 text-[16px] rounded-xl",
	sm: "h-8 px-3 text-[14px] rounded-lg",
};

/**
 * The lobby's game button, in the game kit's style: the accent with a lip
 * for the primary action, an outlined plate otherwise.
 */
export function ChunkyButton({
	children,
	className,
	size = "md",
	tone = "secondary",
	type = "button",
	...props
}: ComponentProps<"button"> & {
	children?: ReactNode;
	size?: ChunkySize;
	tone?: ChunkyTone;
}) {
	return (
		<button
			className={cn(
				"gk-display relative inline-flex shrink-0 select-none items-center justify-center gap-2 uppercase tracking-[0.03em] outline-none transition-[background-color,filter,transform] duration-100 focus-visible:outline-(--gk-focus) focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-offset-2 enabled:active:translate-y-px disabled:cursor-not-allowed motion-reduce:enabled:active:translate-y-0",
				CHUNKY_SIZE[size],
				CHUNKY_TONE[tone],
				className
			)}
			type={type}
			{...props}
		>
			{children}
		</button>
	);
}
