import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { CSSProperties } from "react";
import {
	CardFooter,
	CardIndex,
	CardStatusMarks,
} from "./card-table-face-marks.tsx";
import {
	type CardFaceMetrics,
	cardFaceMetrics,
	cardRank,
} from "./card-table-model.ts";
import { CARD_STOCK } from "./card-table-palette.ts";
import { useThreadReading } from "./card-table-rows.tsx";
import { agentById } from "./interface-renderer.ts";

/** Under this much showing face, a card drops the "+2" after the agent's name. */
const AGE_MIN_EXPOSED = 100;
/** Cards shorter than this have no room for the last message. */
const MESSAGE_MIN_HEIGHT = 150;
/**
 * A message line, the room the title, footer and far index take, and the
 * most message lines, for a regular card and for a large (picked-up) one.
 */
const FACE_ROOM = {
	large: {
		farIndex: 52,
		footer: 30,
		line: 18,
		maxLines: 6,
		title: 72,
	},
	regular: {
		farIndex: 40,
		footer: 24,
		line: 14,
		maxLines: 4,
		title: 58,
	},
} as const;

type MessageLines = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const LINE_COUNTS: readonly MessageLines[] = [1, 2, 3, 4, 5, 6];
const MESSAGE_CLAMP: Record<Exclude<MessageLines, 0>, string> = {
	1: "line-clamp-1",
	2: "line-clamp-2",
	3: "line-clamp-3",
	4: "line-clamp-4",
	5: "line-clamp-5",
	6: "line-clamp-6",
};

/**
 * How many lines of the last message fit under a three-line title, clear of
 * the footer and the far corner index: a taller card shows more of it, and a
 * card with no room for a whole line shows none (rather than a line the far
 * index would sit on).
 */
export function messageLines({
	farIndex,
	footed,
	height,
	large = false,
	titleTop,
}: {
	farIndex: boolean;
	footed: boolean;
	height: number;
	large?: boolean;
	titleTop: number;
}): MessageLines {
	const face = large ? FACE_ROOM.large : FACE_ROOM.regular;
	const room =
		height -
		titleTop -
		face.title -
		(footed ? face.footer : 8) -
		(farIndex ? face.farIndex : 0);
	const lines = Math.floor(room / face.line);
	if (lines < 1) {
		return 0;
	}
	return LINE_COUNTS[Math.min(face.maxLines, lines) - 1] ?? 1;
}

type TitleLines = 3 | 4 | 5;
const TITLE_CLAMP: Record<TitleLines, string> = {
	3: "line-clamp-3",
	4: "line-clamp-4",
	5: "line-clamp-5",
};
/** The title's size: smaller on a small card, larger on a picked-up one. */
function titleSize({ large, small }: CardFaceMetrics): string {
	if (small) {
		return "text-xs leading-[15px]";
	}
	return large
		? "text-base leading-[22px] tracking-[-0.01em]"
		: "text-sm leading-[18px] tracking-[-0.005em]";
}

/** The card's edge: the card in play rings in primary; a failed run in red. */
function cardBorder(active: boolean, failed: boolean): string {
	if (active) {
		return "border-primary ring-2 ring-primary/35";
	}
	return failed ? "border-destructive/60" : "border-border";
}

/**
 * One thread's card face. The corner index carries the lead agent's initial
 * over the status suit, with the agent's name and the age beside them; the
 * title and the last message start under the index at one clean left edge;
 * a footer marks a failed run or the card in play. Everything lays out inside
 * `exposed`, the strip of the card that shows past the card dealt over it, so
 * no line is ever cut by a neighbour.
 */
export function CardFace({
	active,
	exposed,
	height,
	labelled = false,
	last,
	now,
	snapshot,
	thread,
	width,
}: {
	active: boolean;
	exposed: number;
	height: number;
	/** Say the card's suit in words in its footer (no legend nearby). */
	labelled?: boolean;
	/** The top card of the fan shows whole, including its far corner index. */
	last: boolean;
	now: number;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
	width: number;
}) {
	const agent = agentById(snapshot, thread.agentIds[0]);
	const extra = thread.agentIds.length - 1;
	const title = thread.title.trim() || "Untitled thread";
	const metrics = cardFaceMetrics(width);
	const { large, small } = metrics;
	const narrow = exposed < AGE_MIN_EXPOSED;
	const reading = useThreadReading(thread, now);
	// With acts an ask's card says what it asks ("Run deploy.sh?").
	const message = reading.head ?? thread.lastMessage?.trim();
	const { status } = reading;
	const footed =
		active ||
		labelled ||
		(reading.viaActs ? reading.verdictLabel !== null : status === "attention");
	// A small card has no room for a far corner index under its text.
	const farIndex = last && !small;
	const lines =
		!small && message && height >= MESSAGE_MIN_HEIGHT
			? messageLines({
					farIndex,
					footed,
					height,
					large,
					titleTop: metrics.titleTop,
				})
			: 0;
	const showMessage = lines > 0;
	let titleLines: TitleLines = 5;
	if (showMessage) {
		titleLines = 3;
	} else if (small && footed) {
		titleLines = 3;
	} else if (small) {
		titleLines = 4;
	}
	const row = { height: metrics.glyph };
	const rank = cardRank(agent?.name);
	return (
		<span
			className={cn(
				"relative flex size-full overflow-hidden rounded-xl border bg-card text-left text-card-foreground shadow-[0_14px_28px_-14px] shadow-black/50 transition-[box-shadow,border-color] duration-200 group-hover/card:shadow-[0_22px_36px_-16px] group-focus-visible/card:border-ring",
				cardBorder(active, status === "attention")
			)}
			style={CARD_STOCK as CSSProperties}
		>
			<CardStatusMarks exposed={exposed} metrics={metrics} status={status} />
			<CardIndex metrics={metrics} rank={rank} status={status} />
			{farIndex ? (
				<CardIndex flipped metrics={metrics} rank={rank} status={status} />
			) : null}
			<span
				className="flex h-full min-h-0 min-w-0 flex-col"
				style={{ paddingTop: metrics.indexInset, width: exposed }}
			>
				<span
					className={cn(
						"flex shrink-0 flex-col pe-2 leading-none",
						large ? "text-xs" : "text-[11px]"
					)}
					data-card-meta=""
					style={{
						gap: metrics.gap,
						paddingInlineEnd: metrics.small ? 22 : 28,
						paddingInlineStart: metrics.gutter,
					}}
				>
					<span
						className="flex items-center truncate font-medium text-foreground/80"
						style={row}
					>
						<span className="truncate">
							{agent?.name ?? "No agent"}
							{extra > 0 && !narrow ? ` +${extra}` : ""}
						</span>
					</span>
					<span
						className="flex items-center text-muted-foreground tabular-nums"
						style={row}
					>
						{reading.age}
					</span>
				</span>
				<span
					className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden"
					style={{
						paddingInline: metrics.textInset,
						paddingTop:
							metrics.titleTop -
							(metrics.indexInset + metrics.glyph * 2 + metrics.gap),
					}}
				>
					<span
						className={cn(
							"wrap-break-word text-pretty font-heading font-medium text-foreground",
							titleSize(metrics),
							TITLE_CLAMP[titleLines]
						)}
						data-card-title=""
					>
						{title}
					</span>
					{showMessage ? (
						<span
							className={cn(
								"text-muted-foreground",
								large
									? "text-[13px] leading-[18px]"
									: "text-[11px] leading-[14px]",
								lines === 0 ? undefined : MESSAGE_CLAMP[lines]
							)}
						>
							{message}
						</span>
					) : null}
				</span>
				<CardFooter
					active={active}
					labelled={labelled}
					large={large}
					last={farIndex}
					reading={reading}
					small={small}
				/>
			</span>
		</span>
	);
}
