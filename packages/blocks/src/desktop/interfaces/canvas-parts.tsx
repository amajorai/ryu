import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Plus,
} from "lucide-react";
import {
	CARD_GAP,
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasArrange,
	type CanvasEdge,
	type CanvasOffscreen,
	type CanvasRect,
	type CanvasSummary,
	FRAME_LABEL,
	FRAME_PADDING,
} from "./canvas-model.ts";

const ARRANGE_OPTIONS: { label: string; value: CanvasArrange }[] = [
	{ label: "Status", value: "status" },
	{ label: "Agent", value: "agent" },
];

function isArrange(value: unknown): value is CanvasArrange {
	return ARRANGE_OPTIONS.some((option) => option.value === value);
}

/**
 * The top-left panel, as in tldraw: the canvas name, how many threads it holds
 * (and how many need attention), and how the stickies are filed.
 */
export function CanvasHeader({
	arrange,
	loading,
	onArrange,
	summary,
}: {
	arrange: CanvasArrange;
	loading: boolean;
	onArrange: (arrange: CanvasArrange) => void;
	summary: CanvasSummary;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="pointer-events-auto flex h-10 max-w-full items-center gap-3 rounded-xl border border-border bg-card ps-3 pe-0.75 text-card-foreground shadow-foreground/5 shadow-sm">
			<div className="flex min-w-0 items-baseline gap-2 text-sm leading-none">
				<h1 className="shrink-0 text-foreground">
					{/* An inner span: the global heading rule caps h1-h6 at 500. */}
					<span className="font-semibold">Canvas</span>
				</h1>
				{loading ? (
					<Skeleton className="h-3 w-16 self-center" />
				) : (
					<p className="truncate text-[13px] text-foreground/60 tabular-nums">
						{`${summary.threads} ${summary.threads === 1 ? "thread" : "threads"}`}
						{summary.attention > 0 ? (
							<span className="max-sm:hidden">
								{tl(
									" · {attention, plural, one {{attentionCount} needs} other {{attentionCount} need}} attention",
									{
										attention: summary.attention,
										attentionCount: String(summary.attention),
									}
								)}
							</span>
						) : null}
					</p>
				)}
			</div>
			<span aria-hidden="true" className="h-5 w-px bg-border" />
			<ToggleGroup
				appearance="segmented"
				aria-label="Arrange by"
				className="bg-muted"
				multiple={false}
				onValueChange={(values: unknown[]) => {
					const [value] = values;
					if (isArrange(value)) {
						onArrange(value);
					}
				}}
				// Not 0: a zero-spacing group squares its items' inner corners.
				spacing={0.5}
				value={[arrange]}
			>
				{ARRANGE_OPTIONS.map((option) => (
					<ToggleGroupItem
						className="rounded-md px-2.5 font-medium text-foreground/65 hover:text-foreground aria-pressed:shadow-xs"
						density="segmented"
						key={option.value}
						value={option.value}
					>
						{option.label}
					</ToggleGroupItem>
				))}
			</ToggleGroup>
		</div>
	);
}

const SKELETON_FRAMES = [
	{ cards: 1, id: "frame-a", left: "6%", top: "14%" },
	{ cards: 3, id: "frame-b", left: "calc(6% + 328px)", top: "14%" },
	{ cards: 2, id: "frame-c", left: "6%", top: "calc(14% + 268px)" },
] as const;
const SKELETON_CARDS = ["card-1", "card-2", "card-3"] as const;

/**
 * Frames and stickies holding their places while the first snapshot loads,
 * drawn at the real sticky size and frame geometry so nothing jumps when the
 * board arrives.
 */
export function CanvasSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading canvas"
			className="absolute inset-0 overflow-hidden"
			data-testid="canvas-skeleton"
			role="status"
		>
			{SKELETON_FRAMES.map((frame) => (
				<div
					className="absolute flex flex-col"
					key={frame.id}
					style={{ left: frame.left, top: frame.top }}
				>
					<div className="flex items-center" style={{ height: FRAME_LABEL }}>
						<Skeleton className="h-3.5 w-24 rounded-sm" />
					</div>
					<div
						className="flex rounded-lg bg-foreground/[0.035]"
						style={{ gap: CARD_GAP, padding: FRAME_PADDING }}
					>
						{SKELETON_CARDS.slice(0, frame.cards).map((card) => (
							<Skeleton
								className="shrink-0 rounded-md"
								key={card}
								style={{ height: CARD_HEIGHT, width: CARD_WIDTH }}
							/>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * Nothing to arrange yet: one dashed sticky outline on the grid saying how to
 * add the first, with the button that does it.
 */
export function CanvasEmpty({
	hasAgents,
	onNewThread,
}: {
	hasAgents: boolean;
	onNewThread: () => void;
}) {
	return (
		<div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
			<section
				aria-labelledby="canvas-empty-title"
				className="pointer-events-auto flex min-h-40 w-full max-w-72 flex-col items-start justify-between gap-4 rounded-md border border-foreground/25 border-dashed bg-background p-4"
				data-testid="canvas-empty"
			>
				<div className="flex flex-col gap-1.5">
					<h2
						className="text-foreground text-sm leading-snug"
						id="canvas-empty-title"
					>
						<span className="font-semibold">Nothing on the canvas yet</span>
					</h2>
					<p className="text-foreground/70 text-xs leading-[18px]">
						{hasAgents
							? "Double-click anywhere to add a thread."
							: "Add an agent, or start a thread and let Ryu pick who answers."}
					</p>
				</div>
				<Button onClick={onNewThread} size="sm" type="button" variant="outline">
					<Plus aria-hidden="true" data-icon="inline-start" />
					New thread
				</Button>
			</section>
		</div>
	);
}

const EDGE_HINTS: {
	className: string;
	edge: CanvasEdge;
	Icon: typeof ChevronRight;
	words: string;
}[] = [
	{
		className: "top-1/2 right-3 -translate-y-1/2 flex-row-reverse",
		edge: "right",
		Icon: ChevronRight,
		words: "to the right",
	},
	{
		className: "top-1/2 left-3 -translate-y-1/2",
		edge: "left",
		Icon: ChevronLeft,
		words: "to the left",
	},
	{
		className: "top-[72px] left-1/2 -translate-x-1/2",
		edge: "top",
		Icon: ChevronUp,
		words: "above",
	},
	{
		// Drawn in the dock's row (see `inline`), never over the stickies.
		className: "",
		edge: "bottom",
		Icon: ChevronDown,
		words: "below",
	},
];

/**
 * Without a minimap, small pills say how many stickies lie past each side;
 * pressing one glides to the nearest of them. They sit in the dock's row
 * (`inline`), so they never land on a sticky; on a phone, where the dock has
 * no room beside it, all but "below" float at their edge.
 */
export function CanvasEdgeHints({
	edges,
	inline = false,
	offscreen,
	onReveal,
}: {
	edges: readonly CanvasEdge[];
	inline?: boolean;
	offscreen: Record<CanvasEdge, CanvasOffscreen>;
	onReveal: (rect: CanvasRect) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{EDGE_HINTS.map(({ className, edge, Icon, words }) => {
				const { count, nearest } = offscreen[edge];
				if (count === 0 || !nearest || !edges.includes(edge)) {
					return null;
				}
				const label = `${count} ${count === 1 ? "thread" : "threads"} ${words}`;
				return (
					<button
						aria-label={tl("Show {label}", { label })}
						className={cn(
							"pointer-events-auto flex shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-2 font-medium text-foreground/80 text-xs tabular-nums shadow-foreground/5 shadow-sm outline-none transition-colors duration-150",
							"hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40",
							inline
								? cn(
										"h-10 rounded-xl px-3",
										edge === "right" && "flex-row-reverse"
									)
								: cn("absolute h-7", className)
						)}
						data-testid="canvas-edge-hint"
						key={edge}
						onClick={() => onReveal(nearest)}
						title={label}
						type="button"
					>
						<Icon aria-hidden="true" className="size-3.5" />
						{inline ? `${count} ${words}` : count}
					</button>
				);
			})}
		</>
	);
}
