import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { CircleAlert, MessageSquare, Pin } from "lucide-react";
import { type FocusEvent, type MouseEvent, memo } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasCardModel,
} from "./canvas-model.ts";
import { compactAge } from "./interface-renderer.ts";

/**
 * Stickies are neutral cards on the frame's flat fill, as FigJam draws them
 * over a section: no border, a hairline ring that only shows where a theme's
 * shadow cannot (dark themes), and a faint shadow at rest. Status lives in the
 * frame label, the dot, and the live-run line, never in a full-card wash, so
 * themes whose primary and success are both green still read apart.
 */
const SURFACE =
	"bg-card text-card-foreground ring-1 ring-foreground/[0.07] dark:ring-foreground/10";

/**
 * Compact-face title size: about 13px on screen at every compact zoom,
 * between 17 and 28 world pixels so it always fits three lines on the sticky.
 */
const COMPACT_TITLE = {
	fontSize: "clamp(17px, calc(13px * var(--canvas-scale, 1)), 28px)",
} as const;
/**
 * Compact-face meta (the age, the footer): about 10.5px on screen, up to 26
 * world pixels, so it still reads at about 10.5px on screen at 40% zoom.
 */
const COMPACT_META = {
	fontSize: "clamp(11px, calc(10.5px * var(--canvas-scale, 1)), 26px)",
} as const;

/**
 * Status hue lives in the dot / icon; every label and line of text on a sticky
 * is the theme's foreground at a fixed strength, which clears WCAG AA over all
 * five tints in the shipped light and dark themes (muted-foreground does not).
 */
const TEXT_BODY = "text-foreground/80";
const TEXT_META = "text-foreground/65";

function cardLabel(card: CanvasCardModel, open: boolean): string {
	const title = card.thread.title.trim() || "Untitled thread";
	const who = card.agents.map((agent) => agent.name).join(", ");
	return [
		title,
		THREAD_STATUS_LABELS[card.status],
		who ? `with ${who}` : "no agent",
		open ? "open" : null,
	]
		.filter(Boolean)
		.join(", ");
}

/**
 * The selection outline: a 2px primary ring just outside the sticky, sized by
 * `--canvas-scale` (1 / zoom, set on the world layer) so it keeps the same
 * on-screen weight at every zoom. Stickies are not resizable, so there are no
 * corner grips promising a resize.
 */
function SelectionOutline() {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-[calc(-4px*var(--canvas-scale,1))] rounded-[calc(var(--radius-md)+4px*var(--canvas-scale,1))] border-[length:calc(2px*var(--canvas-scale,1))] border-primary"
			data-testid="canvas-selection"
		/>
	);
}

/**
 * A live run: a static 2px rule along the sticky's bottom edge. The card's
 * rounded corners clip it, so it reads as the edge itself turning to the
 * success tone; the status dot is what moves (it pulses), not the card.
 */
function WorkingTrack() {
	return (
		<span
			aria-hidden="true"
			className="absolute inset-x-0 bottom-0 h-0.5 bg-success/60"
			data-testid="canvas-working-track"
		/>
	);
}

/**
 * The top-row label. In the status view the frame around the sticky already
 * names the status, so the row leads with the project or team instead. With
 * neither, only the age shows: a "No project" on half the board is noise,
 * and the empty slot keeps titles on one baseline across the row. Only a
 * failed run, which that frame does not spell out, is said again. In the
 * agent view the row carries the status mark and its name.
 */
function TopLabel({
	card,
	showGroup,
}: {
	card: CanvasCardModel;
	showGroup: boolean;
}) {
	const { status } = card;
	if (status === "attention") {
		return (
			<span className="flex min-w-0 items-center gap-1.5 font-medium text-destructive">
				<CircleAlert aria-hidden="true" className="size-3 shrink-0" />
				<span className="truncate">Last run failed</span>
			</span>
		);
	}
	if (showGroup) {
		return card.group ? (
			<span className={cn("min-w-0 truncate font-medium", TEXT_BODY)}>
				{card.group.name}
			</span>
		) : null;
	}
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<BoardStatusDot status={status} />
			<span className="truncate font-medium text-foreground/80">
				{THREAD_STATUS_LABELS[status]}
			</span>
		</span>
	);
}

/**
 * The full face, on three type steps (13px title, 12px body, 11px meta) and
 * fixed rows: a one-line title and a three-line preview, so titles, previews
 * and footers share baselines across a row of stickies.
 */
function FullFace({
	age,
	card,
	preview,
	showGroup,
	title,
}: {
	age: string;
	card: CanvasCardModel;
	preview: string | undefined;
	showGroup: boolean;
	title: string;
}) {
	const { thread } = card;
	return (
		<>
			<span className="relative flex h-4 items-center gap-2 text-xs leading-none">
				<TopLabel card={card} showGroup={showGroup} />
				<span
					className={cn(
						"ms-auto flex shrink-0 items-center gap-1.5 tabular-nums",
						TEXT_META
					)}
				>
					{thread.pinned ? (
						<Pin aria-hidden="true" className="size-3" strokeWidth={2} />
					) : null}
					{age}
				</span>
			</span>
			<span className="relative mt-2 truncate font-semibold text-foreground text-sm leading-5 tracking-[-0.006em]">
				{title}
			</span>
			{preview ? (
				<span
					className={cn(
						"relative mt-1 line-clamp-3 text-[13px] leading-[19px]",
						TEXT_BODY
					)}
				>
					{thread.lastMessageRole === "user" ? (
						<span className="font-medium text-foreground">You: </span>
					) : null}
					{preview}
				</span>
			) : (
				<span
					className={cn("relative mt-1 text-[13px] leading-[19px]", TEXT_META)}
				>
					No messages yet
				</span>
			)}
			<span className="relative mt-auto flex h-5 items-center gap-2 text-xs leading-none">
				<span className="flex min-w-0 flex-1 items-center gap-1.5">
					{card.agents.length > 0 ? (
						<>
							<span className="flex shrink-0 -space-x-1.5">
								{card.agents.slice(0, 3).map((agent) => (
									<BoardAvatar
										agent={agent}
										className="ring-2 ring-card"
										key={agent.id}
										name={agent.name}
										size={20}
									/>
								))}
							</span>
							<span className={cn("truncate", TEXT_BODY)}>
								{card.agents.map((agent) => agent.name).join(", ")}
							</span>
						</>
					) : (
						<span className={TEXT_META}>No agent</span>
					)}
				</span>
				<span
					aria-hidden="true"
					className={cn(
						"flex shrink-0 items-center gap-1 tabular-nums",
						TEXT_META
					)}
				>
					<MessageSquare className="size-3" strokeWidth={2} />
					{thread.messageCount}
				</span>
			</span>
		</>
	);
}

/**
 * The compact face for low zoom (a docked thread, a phone, an overview): the
 * status mark and age on top, the title large enough to read, then who it is
 * with (by name: avatars would say it twice).
 */
function CompactFace({
	age,
	card,
	tiny,
}: {
	age: string;
	card: CanvasCardModel;
	/** Far out (below 50%): drop the footer and give the title three lines. */
	tiny: boolean;
}) {
	const { thread, status } = card;
	const title = thread.title.trim() || "Untitled thread";
	return (
		<>
			<span className="relative flex h-7 items-center gap-2">
				{status === "attention" ? (
					<CircleAlert
						aria-hidden="true"
						className="size-5 shrink-0 text-destructive"
					/>
				) : (
					<BoardStatusDot className="size-3" status={status} />
				)}
				<span
					className={cn("font-medium tabular-nums leading-none", TEXT_META)}
					style={COMPACT_META}
				>
					{age}
				</span>
				{thread.pinned ? (
					<Pin aria-hidden="true" className="size-4 text-foreground/75" />
				) : null}
			</span>
			<span
				className={cn(
					"relative font-semibold text-foreground tracking-[-0.01em]",
					"line-clamp-3",
					tiny ? "leading-[1.1]" : "leading-[1.15]"
				)}
				style={COMPACT_TITLE}
			>
				{title}
			</span>
			{tiny ? null : (
				<span
					className={cn(
						"relative mt-auto flex items-center gap-2 leading-none",
						TEXT_META
					)}
					style={COMPACT_META}
				>
					<span className="min-w-0 flex-1 truncate">
						{card.agents.map((agent) => agent.name).join(", ") || "No agent"}
					</span>
					<span className="flex shrink-0 items-center gap-1 tabular-nums">
						<MessageSquare aria-hidden="true" className="size-[1em]" />
						{thread.messageCount}
					</span>
				</span>
			)}
		</>
	);
}

export interface CanvasCardProps {
	card: CanvasCardModel;
	/** Zoomed out: show the compact face (status, big title, avatar). */
	compact: boolean;
	dragging: boolean;
	/** Glide to a new position (layout reset) instead of jumping. */
	gliding: boolean;
	/** Dragged out of its frame: drawn lifted above the board. */
	loose: boolean;
	now: number;
	onBlurCard: (id: string, event: FocusEvent<HTMLButtonElement>) => void;
	onFocusCard: (id: string, event: FocusEvent<HTMLButtonElement>) => void;
	onOpenCard: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
	onSelectCard: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
	open: boolean;
	selected: boolean;
	/**
	 * Lead with the thread's project or team instead of its status, where the
	 * frame around the card already says the status.
	 */
	showGroup: boolean;
	/** Far out: the compact face without its footer, title on three lines. */
	tiny?: boolean;
	x: number;
	y: number;
	z: number;
}

/**
 * One thread as a sticky note. Positioned by a transform in world units; the
 * world layer above scales it, so a move never re-lays out the page.
 */
export const CanvasCard = memo(function CanvasCardImpl({
	card,
	compact,
	dragging,
	gliding,
	loose,
	now,
	onBlurCard,
	onFocusCard,
	onOpenCard,
	onSelectCard,
	open,
	selected,
	showGroup,
	tiny = false,
	x,
	y,
	z,
}: CanvasCardProps) {
	const { thread, status } = card;
	const title = thread.title.trim() || "Untitled thread";
	const preview = thread.lastMessage?.trim();
	const age = compactAge(thread.updatedAt, now);
	return (
		<button
			aria-label={cardLabel(card, open)}
			className={cn(
				"group/card absolute top-0 left-0 cursor-default touch-none select-none text-left outline-none",
				gliding &&
					"motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.2,0,0,1)]",
				dragging && "cursor-grabbing"
			)}
			data-canvas-card={card.id}
			data-loose={loose ? "true" : undefined}
			data-selected={selected ? "true" : undefined}
			data-status={status}
			data-testid="canvas-card"
			onBlur={(event) => onBlurCard(card.id, event)}
			onClick={(event) => onSelectCard(card.id, event)}
			onDoubleClick={(event) => onOpenCard(card.id, event)}
			onFocus={(event) => onFocusCard(card.id, event)}
			style={{
				height: CARD_HEIGHT,
				transform: `translate3d(${x}px, ${y}px, 0)`,
				width: CARD_WIDTH,
				zIndex: dragging ? 9999 : z,
			}}
			type="button"
		>
			<span
				className={cn(
					"relative flex size-full flex-col overflow-hidden rounded-md",
					SURFACE,
					compact ? "gap-2 p-4" : "p-3",
					"transition-[box-shadow,transform] duration-150 ease-out",
					loose
						? "shadow-foreground/10 shadow-lg"
						: "shadow-foreground/5 shadow-xs group-hover/card:shadow-foreground/10 group-hover/card:shadow-sm",
					// The selection outline already marks a focused, selected sticky.
					!selected &&
						"group-focus-visible/card:ring-2 group-focus-visible/card:ring-ring",
					dragging &&
						"shadow-foreground/15 shadow-xl motion-safe:-rotate-1 motion-safe:scale-[1.02]"
				)}
			>
				{open ? (
					<span
						aria-hidden="true"
						className="absolute inset-0 bg-primary/5"
						data-testid="canvas-open-fill"
					/>
				) : null}
				{compact ? (
					<CompactFace age={age} card={card} tiny={tiny} />
				) : (
					<FullFace
						age={age}
						card={card}
						preview={preview}
						showGroup={showGroup}
						title={title}
					/>
				)}
				{status === "working" ? <WorkingTrack /> : null}
			</span>
			{selected && !dragging ? <SelectionOutline /> : null}
		</button>
	);
});
