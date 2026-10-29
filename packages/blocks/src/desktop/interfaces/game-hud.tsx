import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useId, useState } from "react";

/**
 * The game kit's in-world HUD primitives (see `game-shell.tsx` for how a
 * game adopts the kit). Every piece is one chunky style: a rounded plate
 * with a dark outline and a lip, the bundled display face for names and
 * numbers, and big readable sizes. Colours come from `game-palette.ts`
 * custom properties, so the HUD is day in light themes and night in dark.
 */

/** A HUD plate: cream by day, slate by night, outlined, with a lip. */
export const GAME_PLATE =
	"rounded-2xl border-2 border-(--gk-edge) bg-(--gk-plate) text-(--gk-ink) shadow-(--gk-lip)";

/** A thick focus ring that stays visible on top of busy art. */
export const GAME_FOCUS =
	"outline-none focus-visible:outline-3 focus-visible:outline-(--gk-focus) focus-visible:outline-offset-2 focus-visible:outline-solid";

export function GamePlate({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn(GAME_PLATE, "pointer-events-auto", className)}>
			{children}
		</div>
	);
}

/**
 * The desktop and companion themes' spacing step (`--spacing`): Tailwind's
 * `h-12` is 12 of them (46.08px at a 16px root), not 3rem.
 */
export const GAME_SPACING_REM = 0.24;
/** A compact title plate's height with one status line: `min-h-12` (px). */
export const GAME_TITLE_COMPACT_PX = 12 * GAME_SPACING_REM * 16;
/**
 * A compact `keepStatus` title plate's height (px) once its status wraps:
 * the title line (21px) + two status lines (18px each) + the 2px border
 * top and bottom.
 */
export const GAME_TITLE_COMPACT_WRAPPED_PX = 21 + 2 * 18 + 4;

/**
 * The height (px) a compact title plate takes, for a game budgeting its
 * stage insets: `min-h-12` with one status line, GAME_TITLE_COMPACT_WRAPPED_PX
 * when `keepStatus` wraps the status to two lines. The wrap needs the title
 * column to be able to shrink (no `shrink-0` on it).
 */
export function gameTitleHeight(lines: 1 | 2 = 1, remPx = 16): number {
	return lines === 2
		? GAME_TITLE_COMPACT_WRAPPED_PX
		: 12 * GAME_SPACING_REM * remPx;
}

/**
 * Top left: the game's name and one short status line ("2 cooking, 5 ready
 * to serve"). The icon sits on the game's accent.
 */
export function GameTitlePlate({
	compact = false,
	icon,
	keepStatus = false,
	status,
	title,
}: {
	/** Narrow stages: the name only (the status stays for screen readers). */
	compact?: boolean;
	icon?: ReactNode;
	/**
	 * Keep the status visible on compact stages too (the act summary line,
	 * whose leading "need you" term must survive), wrapping to two lines.
	 */
	keepStatus?: boolean;
	status?: ReactNode;
	title: string;
}) {
	return (
		<div
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex min-w-0 items-center gap-3",
				compact && keepStatus && status
					? "min-h-12 ps-1.5 pe-3.5"
					: compact
						? "h-12 ps-1.5 pe-3.5"
						: "py-2 ps-2 pe-5"
			)}
		>
			{icon ? (
				<span
					aria-hidden="true"
					className={cn(
						"grid shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink) [&_svg]:size-5",
						compact ? "size-8" : "size-11 [&_svg]:size-6"
					)}
				>
					{icon}
				</span>
			) : null}
			<div className="flex min-w-0 flex-col">
				<p
					className={cn(
						"gk-display truncate",
						compact ? "text-[18px] leading-[21px]" : "text-[24px] leading-7"
					)}
				>
					{title}
				</p>
				{status ? (
					<p
						className={cn(
							"font-semibold text-(--gk-ink-muted) text-[13px]",
							compact ? "leading-[18px]" : "leading-5",
							// Compact and kept: wrap to two lines, never cut the summary.
							compact && keepStatus ? "line-clamp-2 break-words" : "truncate",
							compact && !keepStatus && "sr-only"
						)}
					>
						{status}
					</p>
				) : null}
			</div>
		</div>
	);
}

/** The status tones a counter's icon tile can wear. */
export type GameTone = "accent" | "bad" | "gold" | "good" | "info" | "warn";

const TONE: Record<GameTone, string> = {
	accent: "bg-(--gk-accent) text-(--gk-accent-ink)",
	bad: "bg-(--gk-bad) text-white",
	gold: "bg-(--gk-gold) text-(--gk-edge)",
	good: "bg-(--gk-good) text-white",
	info: "bg-(--gk-info) text-white",
	warn: "bg-(--gk-warn) text-(--gk-edge)",
};

/** A row of resource counters on one plate. */
export function GameCounters({
	children,
	className,
	label,
}: {
	children: ReactNode;
	className?: string;
	label: string;
}) {
	return (
		<section
			aria-label={label}
			className={cn(GAME_PLATE, "pointer-events-auto", className)}
		>
			<dl className="flex items-stretch divide-x-2 divide-(--gk-plate-sunk)">
				{children}
			</dl>
		</section>
	);
}

/**
 * One resource: an icon tile, a big tabular number and a label under it.
 * Compact counters keep the icon and the number; the label is still read.
 * Under 640px every counter is compact, so a game's counters stay one row.
 */
export function GameCounter({
	compact = false,
	icon,
	label,
	tone,
	value,
}: {
	compact?: boolean;
	icon: ReactNode;
	label: ReactNode;
	tone: GameTone;
	value: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex items-center",
				compact
					? "gap-1.5 px-2 py-1.5"
					: "@max-[639px]/game:gap-1.5 gap-2.5 @max-[639px]/game:px-2 @max-[639px]/game:py-1.5 py-2 ps-2.5 pe-4"
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"grid shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2",
					compact
						? "size-7 [&_svg]:size-4"
						: "@max-[639px]/game:size-7 size-10 @max-[639px]/game:[&_svg]:size-4 [&_svg]:size-5",
					TONE[tone]
				)}
			>
				{icon}
			</span>
			<div className="flex flex-col-reverse">
				<dt
					className={cn(
						"whitespace-nowrap font-semibold text-(--gk-ink-muted) text-[12px] uppercase leading-4 tracking-wide",
						compact ? "sr-only" : "@max-[639px]/game:sr-only"
					)}
				>
					{label}
				</dt>
				<dd
					className={cn(
						"gk-display whitespace-nowrap tabular-nums",
						compact
							? "text-[18px] leading-6"
							: "@max-[639px]/game:text-[18px] text-[26px] @max-[639px]/game:leading-6 leading-7"
					)}
				>
					{value}
				</dd>
			</div>
		</div>
	);
}

/** The game's one primary action ("New order", "Plant a seed"). */
export function GameAction({
	compact = false,
	disabled,
	icon,
	label,
	onClick,
}: {
	/** Narrow stages: a square icon button; the label is still its name. */
	compact?: boolean;
	disabled?: boolean;
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-label={label}
			className={cn(
				"gk-action gk-display pointer-events-auto inline-flex shrink-0 items-center justify-center gap-2 rounded-2xl bg-(--gk-accent) text-(--gk-accent-ink) transition-[transform,filter] duration-75 hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-5 [&_svg]:shrink-0",
				compact ? "size-12" : "h-12 ps-4 pe-5 text-[18px]",
				GAME_FOCUS
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{icon}
			{compact ? null : <span>{label}</span>}
		</button>
	);
}

/** A round outlined HUD button for paging, Back and Close. */
export function GameIconButton({
	children,
	disabled,
	label,
	onClick,
	title,
}: {
	children: ReactNode;
	disabled?: boolean;
	label: string;
	onClick: () => void;
	title?: string;
}) {
	return (
		<button
			aria-label={label}
			className={cn(
				"pointer-events-auto grid size-10 shrink-0 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) text-(--gk-ink) shadow-[0_2px_0_var(--gk-edge)] transition-[transform,background-color] duration-75 hover:bg-(--gk-plate-sunk) active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0 motion-reduce:active:translate-y-0",
				GAME_FOCUS
			)}
			disabled={disabled}
			onClick={onClick}
			title={title}
			type="button"
		>
			{children}
		</button>
	);
}

/**
 * The legend: one chip per meaning (a mark and a word), on one plate, so
 * the scene's symbols are explained in one consistent place. On narrow
 * stages (under 640px) it folds into a "?" plate that opens it, so phones
 * keep the scene clear and the legend one tap away.
 */
export function GameLegend({
	items,
	label,
}: {
	items: readonly { key: string; label: ReactNode; mark: ReactNode }[];
	label: string;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const listId = useId();
	return (
		<div className="pointer-events-auto flex min-w-0 flex-col-reverse items-end gap-2">
			<button
				aria-controls={listId}
				aria-expanded={open}
				aria-label={
					open
						? tl("Hide {legend}", { legend: label.toLowerCase() })
						: tl("Show {legend}", { legend: label.toLowerCase() })
				}
				className={cn(
					GAME_PLATE,
					GAME_FOCUS,
					"gk-display grid @min-[640px]/game:hidden size-12 shrink-0 place-items-center text-[22px] leading-none",
					open && "bg-(--gk-accent) text-(--gk-accent-ink)"
				)}
				onClick={() => setOpen((value) => !value)}
				onKeyDown={(event) => {
					if (event.key === "Escape" && open) {
						event.stopPropagation();
						setOpen(false);
					}
				}}
				type="button"
			>
				<span aria-hidden="true">?</span>
			</button>
			<ul
				aria-label={label}
				className={cn(
					GAME_PLATE,
					"flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5",
					"@max-[639px]/game:max-w-[min(360px,calc(100cqw-20px))] @max-[639px]/game:gap-x-3",
					open ? undefined : "@max-[639px]/game:hidden"
				)}
				id={listId}
			>
				{items.map((item) => (
					<li
						className="flex items-center gap-2 font-semibold text-[13px] leading-5"
						key={item.key}
					>
						<span
							aria-hidden="true"
							className="grid shrink-0 place-items-center"
						>
							{item.mark}
						</span>
						{item.label}
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * An agent's card at the top of the sheet: a big avatar, what they do, and
 * their numbers as small counters. Sits on the sheet's theme body.
 */
export function GameAgentCard({
	avatar,
	description,
	stats,
	status,
}: {
	/** Leave out when the sheet's header already shows the face. */
	avatar?: ReactNode;
	description?: string;
	stats: readonly { key: string; label: string; value: ReactNode }[];
	status?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 border-border border-b px-4 py-4">
			<div className="flex items-center gap-3">
				{avatar ? <span className="shrink-0">{avatar}</span> : null}
				<div className="flex min-w-0 flex-col gap-1">
					{status ? (
						<div className="flex items-center gap-1.5 font-medium text-foreground text-sm leading-5">
							{status}
						</div>
					) : null}
					{description ? (
						<p className="line-clamp-2 text-pretty text-muted-foreground text-sm leading-5">
							{description}
						</p>
					) : null}
				</div>
			</div>
			{stats.length > 0 ? (
				<dl className="grid grid-flow-col gap-2">
					{stats.map((stat) => (
						<div
							className="flex flex-col-reverse rounded-lg bg-muted/60 px-3 py-2"
							key={stat.key}
						>
							<dt className="text-[12px] text-muted-foreground leading-4">
								{stat.label}
							</dt>
							<dd className="font-semibold text-foreground text-lg tabular-nums leading-6">
								{stat.value}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</div>
	);
}
