import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { type CardFaceMetrics, STATUS_SUIT } from "./card-table-model.ts";
import { SUIT_TONE, SuitGlyph } from "./card-table-pieces.tsx";
import type { ThreadReading } from "./card-table-rows.tsx";

// The marks printed on a thread's card face: the corner index, the status band
// and corner marks, and the footer.

/** The footer's end padding: clear of the far corner index on the last card. */
const FOOTER_END_LAST = 28;
const FOOTER_END = 8;

/**
 * The card's corner index: the lead agent's initial over the status suit, at
 * the size {@link cardFaceMetrics} gives the card. The flipped copy sits in the
 * far corner of the top card.
 */
export function CardIndex({
	flipped = false,
	metrics,
	rank,
	status,
}: {
	flipped?: boolean;
	metrics: CardFaceMetrics;
	rank: string;
	status: ThreadStatus;
}) {
	const glyph = { fontSize: metrics.glyph, height: metrics.glyph };
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute flex flex-col items-center",
				SUIT_TONE[status],
				flipped && "rotate-180"
			)}
			data-card-index={flipped ? "far" : "near"}
			style={{
				gap: metrics.gap,
				width: metrics.indexWidth,
				...(flipped
					? { bottom: metrics.indexInset, insetInlineEnd: metrics.indexInset }
					: { insetInlineStart: metrics.indexInset, top: metrics.indexInset }),
			}}
		>
			<span
				className="flex items-center font-black font-heading leading-none tracking-tight"
				style={{ ...glyph, fontSize: Math.round(metrics.glyph * 1.3) }}
			>
				{rank}
			</span>
			<span
				className="flex items-center"
				style={{ ...glyph, fontSize: Math.round(metrics.glyph * 1.1) }}
			>
				<SuitGlyph status={status} />
			</span>
		</span>
	);
}

/** The card's top edge, painted in its status's tone. */
const BAND_TONE: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-muted-foreground/30",
	waiting: "bg-muted-foreground/45",
	working: "bg-status-success",
	"your-turn": "bg-primary",
};

/** The status corner mark: a stamped dot with its sign, or none. */
const CORNER_MARK: Record<
	ThreadStatus,
	{ className: string; sign: string } | null
> = {
	attention: {
		className: "bg-destructive text-destructive-foreground",
		sign: "×",
	},
	quiet: null,
	waiting: { className: "bg-muted text-muted-foreground", sign: "…" },
	working: { className: "bg-status-success text-background", sign: "…" },
	"your-turn": { className: "bg-primary text-primary-foreground", sign: "!" },
};

/**
 * The card's status at a glance: a band across its top edge, a stamped
 * corner mark at the top of the strip that shows past the next card, and
 * a big faint suit pip low on the face.
 */
export function CardStatusMarks({
	exposed,
	metrics,
	status,
}: {
	exposed: number;
	metrics: CardFaceMetrics;
	status: ThreadStatus;
}) {
	const mark = CORNER_MARK[status];
	const markSize = metrics.small ? 16 : 20;
	const pip = metrics.glyph * (metrics.small ? 2.6 : 3.4);
	return (
		<>
			<span
				aria-hidden="true"
				className={cn("absolute inset-x-0 top-0 h-1", BAND_TONE[status])}
				data-card-band=""
			/>
			{mark ? (
				<span
					aria-hidden="true"
					className={cn(
						"absolute grid place-items-center rounded-full font-black leading-none shadow-[0_1px_0] shadow-black/25",
						mark.className
					)}
					data-card-mark={status}
					style={{
						fontSize: markSize - 6,
						height: markSize,
						left: exposed - markSize - (metrics.small ? 4 : 6),
						top: metrics.indexInset + 2,
						width: markSize,
					}}
				>
					{mark.sign}
				</span>
			) : null}
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute leading-none opacity-[0.13]",
					SUIT_TONE[status]
				)}
				style={{
					bottom: metrics.small ? 6 : 10,
					fontSize: pip,
					left: Math.max(4, exposed - pip * 0.95),
				}}
			>
				{STATUS_SUIT[status]}
			</span>
		</>
	);
}

/** A labelled card's footer words for each suit, short enough for a fan. */
const FOOTER_LABELS: Record<ThreadStatus, string> = {
	attention: "Failed run",
	quiet: "Not started",
	waiting: "Waiting",
	working: "Working",
	"your-turn": "Your turn",
};

const FOOTER_TONE: Record<ThreadStatus, string> = {
	attention: "text-status-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-status-success",
	"your-turn": "text-foreground",
};

/**
 * A card's footer. In the hand it shows only when it adds something past the
 * suit (a failed run, or the card in play), since the table's legend reads
 * the suits. A `labelled` card (the Cards layout, which has no legend) always
 * says its suit in words.
 */
export function CardFooter({
	active,
	labelled,
	large,
	last,
	reading,
	small,
}: {
	active: boolean;
	labelled: boolean;
	large: boolean;
	last: boolean;
	reading: ThreadReading;
	small: boolean;
}) {
	const { status } = reading;
	let label: string;
	let tone: string;
	if (active) {
		label = "In play";
		tone = "text-primary";
	} else if (reading.viaActs && reading.verdictLabel) {
		// The acts name the stop: only a failed run is red.
		label = reading.verdictLabel;
		tone = FOOTER_TONE[status];
	} else if (reading.viaActs && !labelled) {
		return null;
	} else if (status === "attention") {
		label = small ? "Failed" : FOOTER_LABELS.attention;
		tone = "text-status-destructive";
	} else if (labelled) {
		// A quiet thread is "Done" or "Not started", as its reading says.
		label = status === "quiet" ? reading.label : FOOTER_LABELS[status];
		tone = FOOTER_TONE[status];
	} else {
		return null;
	}
	return (
		<span
			className={cn(
				"mt-auto flex min-w-0 shrink-0 items-center gap-1 font-medium leading-4",
				footerSize(small, large),
				tone
			)}
			data-card-footer=""
			style={{
				paddingInlineEnd: last ? FOOTER_END_LAST + (large ? 8 : 0) : FOOTER_END,
				paddingInlineStart: footerInset(small, large),
			}}
		>
			<SuitGlyph className="text-current text-xs" status={status} />
			<span className="truncate">{label}</span>
		</span>
	);
}

/** The footer's text size and bottom padding for the card's size. */
function footerSize(small: boolean, large: boolean): string {
	if (small) {
		return "pb-1.5 text-[11px]";
	}
	return large ? "pb-3 text-xs" : "pb-2 text-[11px]";
}

/** The footer's start padding, in line with the title above it. */
function footerInset(small: boolean, large: boolean): number {
	if (small) {
		return 8;
	}
	return large ? 14 : 10;
}
