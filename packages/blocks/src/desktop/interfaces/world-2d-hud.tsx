import { cn } from "@ryu/ui/lib/utils";
import type { WorldLayout, WorldPoint } from "@ryuhq/protocol/interfaces";
import {
	type ComponentProps,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import { insidePond, type TileRect } from "./world-2d-layout.ts";
import {
	needsYou,
	type VillagerStatus,
	villagerStatusSuffix,
} from "./world-2d-model.ts";
import {
	type PixelScene,
	SV_ICONS,
	SV_MAP,
	SV_UI,
} from "./world-2d-palette.ts";
import { PixelPortrait } from "./world-2d-portrait.tsx";
import type { VillageLayout } from "./world-village.ts";

/**
 * The 2D village's Stardew-style HUD: wooden frames with parchment insides,
 * the clock and date box (top right), the location plaque (top left), the
 * hotbar with one slot per villager (bottom), the interaction tooltip above
 * it, and a toggleable village map. One face and weight throughout (the
 * app's display face, semibold) at two sizes, 16px and 13px. Colors are
 * Stardew's menu colors from `world-2d-palette.ts`, read through the
 * `--sv-*` variables the world sets on its root.
 */

const HUD_FONT =
	"font-(family-name:--sv-font) font-normal [font-synthesis:none]";

/**
 * A chunky keyboard key in the hotbar's beige. The glyph is crisp: no text
 * shadow (the HUD's pixel shadow smears a keycap's small letters).
 */
export function PixelKey({
	className,
	style,
	...props
}: ComponentProps<"kbd">) {
	return (
		<kbd
			className={cn(
				"font-(family-name:--sv-font) inline-flex h-6 min-w-6 items-center justify-center border-(--sv-wood-dark) border-2 bg-(--sv-key) px-1 font-normal text-(--sv-ink) text-[16px] leading-5 shadow-[inset_-2px_-2px_0_var(--sv-key-shade),0_2px_0_var(--sv-outline)] [font-synthesis:none]",
				className
			)}
			style={{ ...style, textShadow: "none" }}
			{...props}
		/>
	);
}

/** Stardew's red close "X", as pixels (4 screen pixels per art pixel). */
function CloseIcon() {
	return (
		<svg
			aria-hidden="true"
			height="28"
			shapeRendering="crispEdges"
			viewBox="0 0 7 7"
			width="28"
		>
			<path
				d="M0 0h2v1h1v1h1v-1h1v-1h2v2h-1v1h-1v1h1v1h1v2h-2v-1h-1v-1h-1v1h-1v1h-2v-2h1v-1h1v-1h-1v-1h-1z"
				fill={SV_UI.closeDark}
			/>
			<path
				d="M1 1h1v1h1v1h1v-1h1v-1h1v1h-1v1h-1v1h1v1h1v1h-1v-1h-1v-1h-1v1h-1v1h-1v-1h1v-1h1v-1h-1v-1h-1z"
				fill={SV_UI.close}
			/>
		</svg>
	);
}

/**
 * Stardew's red close "X" (a 32px target), placed just past a menu's
 * top-right corner rather than on its frame.
 */
export function CloseButton({
	keyShortcut,
	label,
	onClick,
	title,
}: {
	keyShortcut?: string;
	label: string;
	onClick: () => void;
	title: string;
}) {
	return (
		<button
			aria-keyshortcuts={keyShortcut}
			aria-label={label}
			className="pointer-events-auto flex size-8 shrink-0 items-center justify-center outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-1 active:translate-y-px"
			onClick={onClick}
			title={title}
			type="button"
		>
			<CloseIcon />
		</button>
	);
}

/** Current time, refreshed every 20 seconds. */
function useNow(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 20_000);
		return () => clearInterval(id);
	}, []);
	return now;
}

function SunIcon() {
	return (
		<svg
			aria-hidden="true"
			height="18"
			shapeRendering="crispEdges"
			viewBox="0 0 9 9"
			width="18"
		>
			<path
				d="M4 0h1v1h-1zM4 8h1v1h-1zM0 4h1v1h-1zM8 4h1v1h-1zM1 1h1v1h-1zM7 1h1v1h-1zM1 7h1v1h-1zM7 7h1v1h-1z"
				fill={SV_ICONS.sunRay}
			/>
			<path d="M3 2h3v1h1v3h-1v1h-3v-1h-1v-3h1z" fill={SV_ICONS.sun} />
			<path d="M3 3h1v1h-1z" fill={SV_ICONS.sunGlint} />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			aria-hidden="true"
			height="18"
			shapeRendering="crispEdges"
			viewBox="0 0 9 9"
			width="18"
		>
			<path
				d="M3 0h3v1h-3zM2 1h2v1h-2zM1 2h3v5h-3zM2 7h2v1h-2zM3 8h3v1h-3z"
				fill={SV_ICONS.moon}
			/>
			<path d="M1 3h1v3h-1zM3 8h2v1h-2z" fill={SV_ICONS.moonShade} />
			<path d="M3 1h1v1h-1z" fill={SV_ICONS.moonGlint} />
		</svg>
	);
}

/** Spring leaf: the season badge. */
function LeafIcon() {
	return (
		<svg
			aria-hidden="true"
			height="18"
			shapeRendering="crispEdges"
			viewBox="0 0 9 9"
			width="18"
		>
			<path
				d="M5 1h3v3h-1v2h-1v1h-3v1h-2v-1h1v-1h1v-2h1v-2h1z"
				fill={SV_ICONS.leaf}
			/>
			<path
				d="M6 2h1v1h-1zM5 3h1v1h-1zM4 4h1v1h-1zM3 5h1v1h-1z"
				fill={SV_ICONS.leafVein}
			/>
		</svg>
	);
}

/**
 * Stardew's dial: a half disc from dawn (left) to dusk (right) with a hand
 * pointing at the real time of day. The sky follows the clock it sits
 * beside (not the world's theme): daylight blue with clouds and a sunset
 * edge by day, dark with a moon and stars at night.
 */
function DayDial({ hours, night }: { hours: number; night: boolean }) {
	// 6:00 points left, 2:00 (26h) points right.
	const progress = Math.min(1, Math.max(0, ((hours - 6 + 24) % 24) / 20));
	const angle = Math.PI * (1 - progress);
	const hx = Math.round(12 + Math.cos(angle) * 8);
	const hy = Math.round(12 - Math.sin(angle) * 8);
	return (
		<svg
			aria-hidden="true"
			height="39"
			shapeRendering="crispEdges"
			viewBox="0 0 24 13"
			width="72"
		>
			<path
				d="M7 1h10v1h2v1h1v1h1v2h1v2h1v5h-22v-5h1v-2h1v-2h1v-1h1v-1h2z"
				fill={SV_UI.outline}
			/>
			<path
				d="M7 2h5v10h-10v-4h1v-2h1v-2h1v-1h2z"
				fill={night ? SV_ICONS.dialNightDawn : SV_ICONS.dialDawn}
			/>
			<path
				d="M12 2h5v1h2v1h1v2h1v2h1v4h-10z"
				fill={night ? SV_ICONS.dialNightDusk : SV_ICONS.dialDusk}
			/>
			{night ? (
				<path
					d="M5 4h2v1h-1v2h1v1h-2v-1h-1v-2h1zM9 8h1v1h-1z"
					fill={SV_ICONS.star}
				/>
			) : (
				<path d="M4 9h3v1h-3zM8 7h2v1h-2z" fill={SV_ICONS.cloud} />
			)}
			<path
				d="M15 5h1v1h-1zM18 8h1v1h-1zM14 9h1v1h-1z"
				fill={night ? SV_ICONS.star : SV_ICONS.dialSparkle}
			/>
			<path d="M2 11h20v1h-20z" fill={SV_ICONS.dialHorizon} />
			<line
				stroke={SV_ICONS.dialHand}
				strokeWidth="1.4"
				x1="12"
				x2={hx}
				y1="12"
				y2={hy}
			/>
			<path d="M11 11h2v2h-2z" fill={SV_UI.outline} />
		</svg>
	);
}

/**
 * The time the way Stardew's clock shows it: "8:20 am", stepping in
 * ten-minute increments.
 */
export function stardewTime(date: Date): string {
	const hours = date.getHours();
	const minutes = Math.floor(date.getMinutes() / 10) * 10;
	const hour = hours % 12 === 0 ? 12 : hours % 12;
	return `${hour}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
}

/** The "!" quest marker as a small HUD glyph (gold, or red for trouble). */
export function QuestMark({
	size = 11,
	tone,
}: {
	size?: number;
	tone: "attention" | "your-turn";
}) {
	const attention = tone === "attention";
	return (
		<svg
			aria-hidden="true"
			className="shrink-0"
			height={size}
			shapeRendering="crispEdges"
			viewBox="0 0 5 11"
			width={Math.round((size * 5) / 11)}
		>
			<path
				d="M0 0h5v5h-1v2h-3v-2h-1zM0 8h5v3h-5z"
				fill={attention ? SV_UI.redDark : SV_UI.alertLine}
			/>
			<path
				d="M1 1h3v3h-1v2h-1v-2h-1zM1 9h3v1h-3z"
				fill={attention ? SV_UI.red : SV_UI.alert}
			/>
		</svg>
	);
}

/** Stardew's "..." for a busy villager: three static pixel dots. */
export function WorkingDots() {
	return (
		<span aria-hidden="true" className="inline-flex shrink-0 items-end gap-0.5">
			{[0, 1, 2].map((dot) => (
				<span className="size-1 bg-(--sv-ink)" key={dot} />
			))}
		</span>
	);
}

/** First and last hour (local, 24h) the clock box shows as daytime. */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 19;

/**
 * Stardew's clock and date box, adapted to Ryu: the local weekday and day,
 * the dial and the real time, and below them how many villagers are
 * waiting on the user (the number that matters) and how many are working.
 * The dial and the sun or moon follow the printed time; only the village
 * art follows the app's theme.
 */
export function ClockBox({
	compact = false,
	needYouCount,
	showStatus = true,
	workingCount,
}: {
	/** Narrow viewports drop the dial so the box covers less of the world. */
	compact?: boolean;
	needYouCount: number;
	/** The villagers' tally under the clock (off while empty or loading). */
	showStatus?: boolean;
	workingCount: number;
}) {
	const now = useNow();
	const weekday = now.toLocaleDateString(undefined, { weekday: "short" });
	const time = stardewTime(now);
	const hours = now.getHours() + now.getMinutes() / 60;
	const night = hours < DAY_START_HOUR || hours >= DAY_END_HOUR;
	const date = (
		<time dateTime={now.toISOString().slice(0, 10)}>
			{weekday}. {now.getDate()}
		</time>
	);
	const clock = (
		<time className="tabular-nums" dateTime={now.toISOString()}>
			{time}
		</time>
	);
	return (
		<section
			aria-label="Village clock"
			className={cn("pointer-events-auto", HUD_FONT)}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			{compact ? (
				<p className="flex items-center gap-2 text-[16px] leading-none">
					{night ? <MoonIcon /> : <SunIcon />}
					{date}
					{clock}
				</p>
			) : (
				<div className="flex items-stretch">
					<div className="-my-1 -ml-1 flex items-end pr-1">
						<DayDial hours={hours} night={night} />
					</div>
					<div className="flex min-w-[92px] flex-col items-center justify-center gap-1 border-(--sv-slot-shade) border-l-2 pl-2 text-[16px] leading-none">
						<p>{date}</p>
						<p className="flex items-center gap-1">
							{night ? <MoonIcon /> : <SunIcon />}
							<LeafIcon />
						</p>
						<p>{clock}</p>
					</div>
				</div>
			)}
			{showStatus ? (
				<p className="mt-2 flex flex-col gap-1 border-(--sv-slot-shade) border-t-2 pt-2 text-[16px] leading-5">
					{needYouCount > 0 ? (
						<span className="inline-flex items-center gap-2">
							<span className="flex w-4 justify-center">
								<QuestMark size={11} tone="your-turn" />
							</span>
							{needYouCount} need you
						</span>
					) : (
						<span className="text-(--sv-ink-soft)">All caught up</span>
					)}
					<span className="inline-flex items-center gap-2">
						<span className="flex w-4 justify-center">
							<WorkingDots />
						</span>
						{workingCount} working
					</span>
				</p>
			) : null}
		</section>
	);
}

/** The place name, on a parchment card in the same wood frame as the clock. */
export function LocationPlaque({ title }: { title: string }) {
	return (
		<p
			className={cn("pointer-events-none text-[16px] leading-none", HUD_FONT)}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			{title}
		</p>
	);
}

/**
 * The interaction tooltip above the hotbar (polite live region). With
 * nothing to say it stays mounted but empty, so announcements keep working.
 */
export function PromptTooltip({
	children,
	visuallyHidden = false,
}: {
	children: ReactNode;
	/** Announce without showing the plank (e.g. "Loading villagers"). */
	visuallyHidden?: boolean;
}) {
	const empty = visuallyHidden || children === null || children === undefined;
	return (
		<div
			aria-live="polite"
			className={cn(
				"max-w-full text-center text-[16px] leading-5",
				HUD_FONT,
				empty && "sr-only"
			)}
			role="status"
			style={
				empty ? undefined : { ...frameStyle("plank", 2), ...SV_PLANK_TEXT }
			}
		>
			{children}
		</div>
	);
}

/** The controls hint on its own wooden plank (not a live region). */
export function ControlsPlank({ children }: { children: ReactNode }) {
	return (
		<p
			className={cn("text-left text-[16px] leading-5", HUD_FONT)}
			style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
		>
			<span className="sr-only">Controls: </span>
			{children}
		</p>
	);
}

/**
 * What the controls strip leaves behind once closed: a small plank with
 * its "?" key, so the strip can be brought back with the mouse too.
 */
export function ControlsToggle({ onToggle }: { onToggle: () => void }) {
	return (
		<button
			aria-keyshortcuts="?"
			aria-label="Show controls"
			className={cn(
				"pointer-events-auto flex items-center text-[16px] leading-5 outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-px",
				HUD_FONT
			)}
			onClick={onToggle}
			style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
			title="Show controls (?)"
			type="button"
		>
			<PixelKey>?</PixelKey>
		</button>
	);
}

/** Hotbar slot sizes (CSS px): full, and compact for a narrowed stage. */
export const SLOT_SIZE = { compact: 42, full: 54 } as const;
export type SlotSize = keyof typeof SLOT_SIZE;

/** Gap between hotbar slots (CSS px). */
const SLOT_GAP = 2;
/** Width of a page-turn arrow (CSS px). */
const PAGE_TURN_WIDTH = 28;
/** The hotbar's wooden frame, both sides together (CSS px), per size. */
const HOTBAR_CHROME: Record<SlotSize, number> = { compact: 20, full: 30 };
/** Screen pixels per frame pixel for slots and the bar, per size. */
const SLOT_FRAME_SCALE: Record<SlotSize, number> = { compact: 1, full: 2 };
const BAR_FRAME_SCALE: Record<SlotSize, number> = { compact: 2, full: 3 };

/** Fewest villagers a hotbar page holds, however narrow the stage. */
const MIN_PAGE = 4;
const MAX_PAGE = 10;

export interface HotbarLayout {
	/** The controls slot sits in the hotbar (else beside the place name). */
	helpInBar: boolean;
	pageSize: number;
	size: SlotSize;
	/** The hotbar's rendered width in CSS px (for placing the hint). */
	width: number;
}

/** The hotbar's width for a layout and a page of `slots` villagers. */
function barWidth(
	size: SlotSize,
	slots: number,
	helpInBar: boolean,
	paged: boolean
): number {
	const step = SLOT_SIZE[size] + SLOT_GAP;
	const fixed = (helpInBar ? 2 : 1) * step;
	const arrows = paged ? 2 * (PAGE_TURN_WIDTH + SLOT_GAP) : 0;
	return HOTBAR_CHROME[size] + fixed + arrows + slots * step;
}

/**
 * Fits the hotbar to the stage: full-size slots when they all fit (or the
 * stage is wide), compact ones on a narrowed stage, and the controls slot
 * moves up beside the place name when the stage is narrow, so at least
 * four portraits always fit on a page.
 */
export function hotbarLayout(stageWidth: number, agents: number): HotbarLayout {
	const slotsThatFit = (
		size: SlotSize,
		fixedSlots: number,
		arrows: boolean
	) => {
		const available = Math.max(0, stageWidth - 24 - HOTBAR_CHROME[size]);
		const step = SLOT_SIZE[size] + SLOT_GAP;
		const fixed =
			fixedSlots * step + (arrows ? 2 * (PAGE_TURN_WIDTH + SLOT_GAP) : 0);
		return Math.floor((available - fixed) / step);
	};
	const sizes: SlotSize[] = stageWidth >= 900 ? ["full"] : ["full", "compact"];
	for (const size of sizes) {
		if (agents <= MAX_PAGE && slotsThatFit(size, 2, false) >= agents) {
			return {
				helpInBar: true,
				pageSize: MAX_PAGE,
				size,
				width: barWidth(size, agents, true, false),
			};
		}
	}
	const size: SlotSize = stageWidth >= 900 ? "full" : "compact";
	const withHelp = slotsThatFit(size, 2, true);
	const helpInBar = withHelp >= MIN_PAGE;
	const pageSize = Math.min(
		MAX_PAGE,
		Math.max(MIN_PAGE, helpInBar ? withHelp : slotsThatFit(size, 1, true))
	);
	return {
		helpInBar,
		pageSize,
		size,
		width: barWidth(size, Math.min(pageSize, agents), helpInBar, true),
	};
}

/** A hotbar slot; keyboard focus gets the same thick red frame as selection. */
const SLOT_BUTTON =
	"relative flex shrink-0 items-center justify-center outline-none focus-visible:shadow-[inset_0_0_0_3px_var(--sv-red-dark),inset_0_0_0_6px_var(--sv-red)]";

export interface HotbarAgent {
	/**
	 * The act layer: the slot's whole name (the act sentence and "Visit
	 * <name>.", or for an asker its ask and "Answer their ask.").
	 */
	actLabel?: string;
	agentId: string;
	/** The agent's place in the village (picks its outfit). */
	index: number;
	name: string;
	status: VillagerStatus;
}

function MapIcon({ size }: { size: number }) {
	return (
		<svg
			aria-hidden="true"
			height={size}
			shapeRendering="crispEdges"
			viewBox="0 0 10 10"
			width={size}
		>
			<path
				d="M0 1h3v1h1v-1h3v1h3v8h-3v-1h-1v1h-3v-1h-3z"
				fill={SV_UI.woodDark}
			/>
			<path d="M1 2h2v7h-2zM4 2h2v7h-2zM7 3h2v6h-2z" fill={SV_UI.key} />
			<path d="M3 2h1v7h-1zM6 2h1v7h-1z" fill={SV_UI.keyShade} />
			<path d="M1 4h1v1h-1zM4 6h2v1h-2zM8 4h1v1h-1z" fill={SV_UI.green} />
			<path d="M7 6h1v1h-1z" fill={SV_ICONS.dialHand} />
		</svg>
	);
}

/**
 * A chunky 5x7 pixel chevron for the hotbar's page turns, cream with a
 * dark brown edge so it reads on the wooden plank.
 */
function PageArrowIcon({ direction }: { direction: "left" | "right" }) {
	const right =
		"M0 0h2v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-2v-1h1v-1h1v-1h1v-1h-1v-1h-1v-1h-1z";
	const left =
		"M3 0h2v1h-1v1h-1v1h-1v1h1v1h1v1h1v1h-2v-1h-1v-1h-1v-1h-1v-1h1v-1h1v-1h1z";
	const path = direction === "left" ? left : right;
	return (
		<svg
			aria-hidden="true"
			className="shrink-0"
			height="24"
			shapeRendering="crispEdges"
			viewBox="0 0 6 8"
			width="18"
		>
			<path d={path} fill={SV_UI.outline} transform="translate(1 1)" />
			<path d={path} fill={SV_UI.plankInk} />
		</svg>
	);
}

/** A small wooden arrow that turns the hotbar to the previous/next page. */
function PageTurn({
	direction,
	disabled,
	height,
	label,
	onClick,
}: {
	direction: "left" | "right";
	disabled: boolean;
	height: number;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-keyshortcuts={direction === "left" ? "[" : "]"}
			aria-label={label}
			className="flex shrink-0 items-center justify-center outline-none hover:brightness-110 focus-visible:shadow-[inset_0_0_0_2px_var(--sv-focus)] active:translate-y-px disabled:opacity-40 disabled:hover:brightness-100"
			disabled={disabled}
			onClick={onClick}
			style={{ ...frameStyle("plank", 1), height, width: PAGE_TURN_WIDTH }}
			title={`${label} (${direction === "left" ? "[" : "]"})`}
			type="button"
		>
			<PageArrowIcon direction={direction} />
		</button>
	);
}

/**
 * A slot's corner marks sit 2px inside its bevel. The frame is 5 frame
 * pixels deep and its bevel 3, so from the slot's padding box that is
 * `2 - 2 * scale` CSS px (negative: into the frame's flat fill).
 */
function cornerInset(frameScale: number): number {
	return 2 - 2 * frameScale;
}

/** Small corner label on a slot (its key), inside the well past the bevel. */
function SlotKeyLabel({
	children,
	frameScale,
}: {
	children: ReactNode;
	frameScale: number;
}) {
	const inset = cornerInset(frameScale);
	return (
		<span
			aria-hidden="true"
			className="font-(family-name:--sv-font) absolute z-10 font-normal text-[8px] leading-none [font-synthesis:none]"
			style={{ ...SV_TEXT, left: inset, top: inset }}
		>
			{children}
		</span>
	);
}

/**
 * A villager's status on its hotbar slot, in the top-right corner 2px inside
 * the bevel: the "!" quest marker when they are waiting on the user, a "..."
 * while they work, nothing otherwise. Both badges share one 12x14 box.
 */
function SlotStatus({
	size,
	status,
}: {
	size: SlotSize;
	status: VillagerStatus;
}) {
	const working = status === "working";
	if (!(working || needsYou(status))) {
		return null;
	}
	const inset = cornerInset(SLOT_FRAME_SCALE[size]);
	return (
		<span
			aria-hidden="true"
			className="absolute z-10 flex h-3.5 w-3 items-center justify-center gap-px border border-(--sv-outline) bg-(--sv-plank-ink)"
			style={{ right: inset, top: inset }}
		>
			{working ? (
				[0, 1, 2].map((dot) => (
					<span className="size-0.5 shrink-0 bg-(--sv-ink)" key={dot} />
				))
			) : (
				<QuestMark
					size={10}
					tone={status === "attention" ? "attention" : "your-turn"}
				/>
			)}
		</span>
	);
}

/**
 * The controls slot's item: a closed guide book (Stardew's hotbar holds
 * items, so the controls are a book, not a bare "?").
 */
function ControlsIcon({ size }: { size: number }) {
	return (
		<svg
			aria-hidden="true"
			height={size}
			shapeRendering="crispEdges"
			viewBox="0 0 10 10"
			width={size}
		>
			<path d="M1 0h8v10h-8z" fill={SV_UI.woodDark} />
			<path d="M2 1h6v7h-6z" fill={SV_ICONS.leafVein} />
			<path d="M3 1h5v7h-5z" fill={SV_UI.green} />
			<path d="M2 8h7v1h-7z" fill={SV_UI.parchment} />
			<path d="M4 3h3v1h-3zM4 5h2v1h-2z" fill={SV_UI.key} />
		</svg>
	);
}

/** The controls slot: the hotbar's, or the small one by the place name. */
export function HelpButton({
	frameScale = 2,
	open,
	onToggle,
	size,
}: {
	/** Screen pixels per frame pixel. */
	frameScale?: number;
	onToggle: () => void;
	open: boolean;
	/** Slot size in CSS px. */
	size: number;
}) {
	return (
		<button
			aria-keyshortcuts="?"
			aria-label="Controls"
			aria-pressed={open}
			className={cn(SLOT_BUTTON, "pointer-events-auto")}
			onClick={onToggle}
			style={{
				...frameStyle(open ? "slot-pressed" : "slot", frameScale),
				height: size,
				width: size,
			}}
			title="Controls (?)"
			type="button"
		>
			<ControlsIcon size={size >= SLOT_SIZE.full ? 30 : 20} />
			<SlotKeyLabel frameScale={frameScale}>?</SlotKeyLabel>
		</button>
	);
}

/**
 * Which page the hotbar shows, as pips under the slots inside its frame
 * (the text is for screen readers).
 */
function PagePips({ page, pageCount }: { page: number; pageCount: number }) {
	return (
		<p className="mt-1 flex items-center justify-center gap-[3px] leading-none">
			<span className="sr-only">
				Page {page + 1} of {pageCount}
			</span>
			{Array.from({ length: pageCount }, (_, index) => (
				<span
					aria-hidden="true"
					className={cn(
						"block border border-(--sv-wood-dark)",
						index === page
							? "size-2 bg-(--sv-red)"
							: "size-1.5 bg-(--sv-ink-shadow)"
					)}
					// biome-ignore lint/suspicious/noArrayIndexKey: pips are positional.
					key={index}
				/>
			))}
		</p>
	);
}

/**
 * One slot per villager, a page of them at a time (Stardew's hotbar rows):
 * click a slot (or press its number key) to walk over and talk; the wooden
 * arrows (or [ and ]) turn the page and pips under the slots show which
 * page is up. The active slot gets Stardew's red selection frame. The
 * controls and map slots stay put at either end.
 */
export function Hotbar({
	activeId,
	agents,
	helpInBar,
	helpOpen,
	mapOpen,
	onPage,
	onToggleHelp,
	onToggleMap,
	onVisit,
	page,
	pageCount,
	size,
}: {
	activeId: string | null;
	/** The villagers on this page. */
	agents: readonly HotbarAgent[];
	/** Whether the controls slot is in the bar (else it is by the title). */
	helpInBar: boolean;
	helpOpen: boolean;
	mapOpen: boolean;
	onPage: (delta: -1 | 1) => void;
	onToggleHelp: () => void;
	onToggleMap: () => void;
	onVisit: (agentId: string) => void;
	/** Zero-based page shown. */
	page: number;
	pageCount: number;
	size: SlotSize;
}) {
	const paged = pageCount > 1;
	const px = SLOT_SIZE[size];
	const slotStyle = (kind: "slot" | "slot-active" | "slot-pressed") => ({
		...frameStyle(kind, SLOT_FRAME_SCALE[size]),
		height: px,
		width: px,
	});
	return (
		<nav
			aria-label="Villagers"
			className="pointer-events-auto relative max-w-full"
			style={frameStyle("wood", BAR_FRAME_SCALE[size])}
		>
			<div className="flex items-end" style={{ gap: SLOT_GAP }}>
				{helpInBar ? (
					<HelpButton
						frameScale={SLOT_FRAME_SCALE[size]}
						onToggle={onToggleHelp}
						open={helpOpen}
						size={px}
					/>
				) : null}
				{paged ? (
					<PageTurn
						direction="left"
						disabled={page === 0}
						height={px}
						label="Previous villagers"
						onClick={() => onPage(-1)}
					/>
				) : null}
				<ul
					className="flex min-w-0 overflow-x-auto px-px [scrollbar-color:var(--sv-slot-shade)_transparent] [scrollbar-width:thin]"
					style={{ gap: SLOT_GAP }}
				>
					{agents.map((agent, index) => {
						const active = agent.agentId === activeId;
						return (
							<li className="shrink-0" key={agent.agentId}>
								<button
									aria-current={active ? "true" : undefined}
									aria-keyshortcuts={
										index < 10 ? String((index + 1) % 10) : undefined
									}
									aria-label={
										agent.actLabel ??
										`Visit ${agent.name}${villagerStatusSuffix(agent.status)}`
									}
									className={cn(SLOT_BUTTON, "group block")}
									data-act-agent={agent.actLabel ? agent.agentId : undefined}
									onClick={() => onVisit(agent.agentId)}
									style={slotStyle(active ? "slot-active" : "slot")}
									title={agent.name}
									type="button"
								>
									<span className="absolute inset-0 flex items-center justify-center transition-transform group-hover:-translate-y-[2px]">
										<PixelPortrait
											agentId={agent.agentId}
											lookIndex={agent.index}
											scale={2}
										/>
									</span>
									{index < 10 ? (
										<SlotKeyLabel frameScale={SLOT_FRAME_SCALE[size]}>
											{(index + 1) % 10}
										</SlotKeyLabel>
									) : null}
									<SlotStatus size={size} status={agent.status} />
								</button>
							</li>
						);
					})}
				</ul>
				{paged ? (
					<PageTurn
						direction="right"
						disabled={page >= pageCount - 1}
						height={px}
						label="Next villagers"
						onClick={() => onPage(1)}
					/>
				) : null}
				<button
					aria-keyshortcuts="M"
					aria-label="Village map"
					aria-pressed={mapOpen}
					className={SLOT_BUTTON}
					onClick={onToggleMap}
					style={slotStyle(mapOpen ? "slot-pressed" : "slot")}
					title="Map (M)"
					type="button"
				>
					<MapIcon size={size === "full" ? 30 : 20} />
					<SlotKeyLabel frameScale={SLOT_FRAME_SCALE[size]}>M</SlotKeyLabel>
				</button>
			</div>
			{paged ? <PagePips page={page} pageCount={pageCount} /> : null}
		</nav>
	);
}

/** Empty slots shown while the villagers load. */
const PLACEHOLDER_SLOTS = 6;

/**
 * The hotbar while the villagers load: the same wooden bar with empty
 * wells, so the HUD keeps its shape instead of flashing a loading line.
 */
export function HotbarPlaceholder({ size }: { size: SlotSize }) {
	const px = SLOT_SIZE[size];
	return (
		<div
			aria-hidden="true"
			className="max-w-full"
			data-testid="world-2d-hotbar-placeholder"
			style={frameStyle("wood", BAR_FRAME_SCALE[size])}
		>
			<div className="flex" style={{ gap: SLOT_GAP }}>
				{Array.from({ length: PLACEHOLDER_SLOTS }, (_, index) => (
					<span
						className="block shrink-0"
						// biome-ignore lint/suspicious/noArrayIndexKey: placeholder wells are positional.
						key={index}
						style={{
							...frameStyle("slot", SLOT_FRAME_SCALE[size]),
							height: px,
							width: px,
						}}
					/>
				))}
			</div>
		</div>
	);
}

/**
 * The village with nobody in it: a notice on the square explaining that
 * agents move in here, and a way to start a conversation (no prompt is
 * sent; the host's new-thread flow takes over).
 */
export function EmptyVillage({ onStart }: { onStart: () => void }) {
	return (
		<section
			aria-labelledby="world-2d-empty-title"
			className={cn(
				"pointer-events-auto absolute top-1/2 left-1/2 flex w-[min(360px,calc(100%-24px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-2",
				HUD_FONT
			)}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<h2
				className="font-(family-name:--sv-font) font-normal text-[16px] leading-6 [font-synthesis:none]"
				id="world-2d-empty-title"
			>
				No villagers yet
			</h2>
			<p className="text-(--sv-ink-soft) text-[16px] leading-6">
				Every agent you create moves into a cottage on this street, with a
				hotbar slot to visit them from anywhere.
			</p>
			<button
				className="mt-2 inline-flex h-8 items-center self-start text-[16px] leading-none outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-px"
				onClick={onStart}
				style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
				type="button"
			>
				Start a conversation
			</button>
		</section>
	);
}

/** Pixels per tile on the map. */
const MAP_TILE = 4;
/** Widest the map canvas may draw (CSS px). */
const MAP_MAX_WIDTH = 384;
/** Largest zoom of the map's pixels. */
const MAP_MAX_ZOOM = 6;

/**
 * The paved square on the map: a lit curb along its top, then stones laid
 * in running bond (half a tile offset each row) in two tones over the
 * mortar, so it reads as paving rather than a flat band.
 */
function drawMapPlaza(
	context: CanvasRenderingContext2D,
	pixel: PixelScene,
	village: VillageLayout,
	width: number
): void {
	const t = MAP_TILE;
	const top = village.plaza.top * t;
	const rows = (village.plaza.bottom - village.plaza.top + 1) * t;
	context.fillStyle = pixel.cobble.gap;
	context.fillRect(0, top, width * t, rows);
	const half = t / 2;
	for (let row = 0; row * half < rows; row++) {
		const y = top + row * half;
		const offset = row % 2 === 0 ? 0 : -half;
		for (let x = offset, n = 0; x < width * t; x += t, n++) {
			context.fillStyle =
				(n + row) % 3 === 0 ? pixel.cobble.stones[2] : pixel.cobble.stones[0];
			context.fillRect(Math.max(0, x), y, t - 1 + Math.min(0, x), half - 1);
		}
	}
	context.fillStyle = pixel.cobble.curb[0];
	context.fillRect(0, top, width * t, 1);
}

/**
 * A flat pixel map of the village with villagers and the player, under a
 * plank with the place's name and Stardew's close "X". Each cottage names
 * its villager on hover or focus, and clicking one walks over to talk.
 */
export function VillageMap({
	layout,
	maxWidth = MAP_MAX_WIDTH,
	nearbyId,
	onClose,
	onVisit,
	pixel,
	player,
	pond,
	roofs,
	statuses,
	title,
	village,
}: {
	layout: WorldLayout;
	/** Widest the map canvas may draw here (CSS px). */
	maxWidth?: number;
	nearbyId: string | null;
	onClose: () => void;
	onVisit: (agentId: string) => void;
	pixel: PixelScene;
	pond: TileRect | null;
	player: WorldPoint;
	roofs: ReadonlyMap<string, string>;
	statuses: ReadonlyMap<string, VillagerStatus>;
	/** The place's name, on the plank above the map. */
	title: string;
	village: VillageLayout;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	// The largest whole-pixel zoom that fits the space it is given.
	const scale = Math.min(
		MAP_MAX_ZOOM,
		Math.max(
			1,
			Math.floor(Math.min(maxWidth, MAP_MAX_WIDTH) / (layout.width * MAP_TILE))
		)
	);
	useEffect(() => {
		const context = ref.current?.getContext("2d");
		if (!context) {
			return;
		}
		const t = MAP_TILE;
		context.imageSmoothingEnabled = false;
		context.fillStyle = pixel.indoor ? pixel.grass[0] : pixel.grass[1];
		context.fillRect(0, 0, layout.width * t, layout.height * t);
		context.fillStyle = pixel.dirt.fill;
		for (const key of village.paths) {
			const [x = 0, y = 0] = key.split(",").map(Number);
			context.fillRect(x * t, y * t, t, t);
		}
		drawMapPlaza(context, pixel, village, layout.width);
		if (pond) {
			context.fillStyle = pixel.water.fill;
			context.fillRect(
				pond.x * t + 1,
				pond.y * t + 1,
				pond.w * t - 2,
				pond.h * t - 2
			);
		}
		for (const tree of village.trees) {
			if (insidePond(pond, tree.x, tree.y)) {
				continue;
			}
			context.fillStyle = pixel.indoor
				? SV_MAP.indoorTree
				: pixel.tree.oak.dark;
			context.fillRect(tree.x * t, tree.y * t + 1, t, t - 1);
			context.fillStyle = pixel.indoor
				? SV_MAP.indoorTreeLight
				: pixel.tree.oak.mid;
			context.fillRect(tree.x * t + 1, tree.y * t, t - 2, t - 1);
		}
		for (const house of village.houses) {
			context.fillStyle = SV_MAP.edge;
			context.fillRect(house.x * t, house.y * t, house.w * t, house.h * t);
			context.fillStyle = roofs.get(house.agentId) ?? SV_MAP.roof;
			context.fillRect(
				house.x * t + 1,
				house.y * t + 1,
				house.w * t - 2,
				house.h * t - 3
			);
		}
		for (const entity of layout.entities) {
			const near = entity.agentId === nearbyId;
			const status = statuses.get(entity.agentId) ?? "idle";
			context.fillStyle = SV_MAP.edge;
			context.fillRect(
				entity.x * t - (near ? 1 : 0),
				entity.y * t - (near ? 1 : 0),
				t + (near ? 2 : 0),
				t + (near ? 2 : 0)
			);
			let fill: string = SV_MAP.idle;
			if (needsYou(status)) {
				fill = SV_MAP.alert;
			} else if (status === "working") {
				fill = SV_MAP.working;
			}
			context.fillStyle = fill;
			context.fillRect(entity.x * t + 1, entity.y * t + 1, t - 2, t - 2);
		}
		context.fillStyle = SV_MAP.playerRim;
		context.fillRect(player.x * t - 1, player.y * t - 1, t + 2, t + 2);
		context.fillStyle = SV_MAP.player;
		context.fillRect(player.x * t, player.y * t, t, t);
	}, [layout, nearbyId, pixel, player, pond, roofs, statuses, village]);
	const working = layout.entities.filter(
		(entity) => entity.status === "working"
	).length;
	const names = new Map(
		layout.entities.map((entity) => [entity.agentId, entity.name])
	);
	const zoom = MAP_TILE * scale;
	const legend = (color: string, label: string) => (
		<span className="inline-flex h-5 items-center gap-2">
			<span
				aria-hidden="true"
				className="block size-2.5 shrink-0 -translate-y-px border border-(--sv-outline)"
				style={{ backgroundColor: color }}
			/>
			{label}
		</span>
	);
	return (
		<div className="pointer-events-auto flex flex-col items-stretch gap-2">
			<div className="flex items-center justify-between gap-2">
				<span aria-hidden="true" className="size-8 shrink-0" />
				<h2
					className={cn("px-1 text-[16px] leading-5", HUD_FONT)}
					style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
				>
					{title}
				</h2>
				<CloseButton
					keyShortcut="Escape"
					label="Close map"
					onClick={onClose}
					title="Close map (Esc)"
				/>
			</div>
			<figure style={frameStyle("wood")}>
				<div
					className="relative mx-auto"
					style={{
						height: layout.height * zoom,
						width: layout.width * zoom,
					}}
				>
					<canvas
						aria-label={`Village map: ${layout.entities.length} villagers, ${working} working`}
						className="block size-full [image-rendering:pixelated]"
						height={layout.height * MAP_TILE}
						ref={ref}
						role="img"
						width={layout.width * MAP_TILE}
					/>
					{village.houses.map((house) => {
						const name = names.get(house.agentId) ?? "Villager";
						const status = statuses.get(house.agentId) ?? "idle";
						return (
							<button
								aria-label={`Visit ${name}${villagerStatusSuffix(status)}`}
								className="group absolute outline-none hover:shadow-[inset_0_0_0_2px_var(--sv-plank-ink)] focus-visible:shadow-[inset_0_0_0_2px_var(--sv-focus)]"
								key={house.agentId}
								onClick={() => onVisit(house.agentId)}
								style={{
									height: house.h * zoom,
									left: house.x * zoom,
									top: house.y * zoom,
									width: house.w * zoom,
								}}
								type="button"
							>
								<span
									aria-hidden="true"
									className={cn(
										"absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap text-[16px] leading-5 group-hover:block group-focus-visible:block",
										HUD_FONT
									)}
									style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
								>
									{name}
								</span>
							</button>
						);
					})}
				</div>
				<figcaption
					className={cn(
						"mt-2 flex flex-wrap items-center gap-x-4 px-1 text-[16px] leading-5",
						HUD_FONT
					)}
					style={SV_TEXT}
				>
					{legend(SV_MAP.player, "You")}
					{legend(SV_MAP.alert, "Needs you")}
					{legend(SV_MAP.working, "Working")}
				</figcaption>
			</figure>
		</div>
	);
}
