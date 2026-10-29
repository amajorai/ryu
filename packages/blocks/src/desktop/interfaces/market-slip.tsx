import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import { lookIndex, type MarketOrder, orderTitle } from "./market-model.ts";
import { PIN_INK, SLIP_SHADOW } from "./market-palette.ts";

/** Two-digit slip numbers read like a ticket roll: No. 04. */
export function slipNumber(order: MarketOrder): string {
	return `No. ${String(order.number).padStart(2, "0")}`;
}

/** Height of the ticket stub above the perforation, in pixels. */
const STUB_HEIGHT = 36;
const NOTCH_RADIUS = 5;
const TOOTH_DEPTH = 4;
const TEETH = 18;

/**
 * The slip's paper outline: a punched notch either side of the stub's
 * perforation and a torn, zigzag foot. Widths are relative, so the same
 * outline fits a slip of any width.
 */
function slipOutline(): string {
	const points: string[] = ["0 0"];
	const notch = (side: "left" | "right") => {
		const steps = [-90, -60, -30, 0, 30, 60, 90];
		const angles = side === "left" ? steps : [...steps].reverse();
		for (const angle of angles) {
			const radians = (angle * Math.PI) / 180;
			const inset = (NOTCH_RADIUS * Math.cos(radians)).toFixed(2);
			const y = (STUB_HEIGHT + NOTCH_RADIUS * Math.sin(radians)).toFixed(2);
			points.push(
				side === "left" ? `${inset}px ${y}px` : `calc(100% - ${inset}px) ${y}px`
			);
		}
	};
	notch("left");
	for (let index = 0; index <= TEETH * 2; index += 1) {
		const x = ((index / (TEETH * 2)) * 100).toFixed(3);
		const y = index % 2 === 0 ? `calc(100% - ${TOOTH_DEPTH}px)` : "100%";
		points.push(`${x}% ${y}`);
	}
	notch("right");
	points.push("100% 0");
	return `polygon(${points.join(", ")})`;
}

const SLIP_OUTLINE = slipOutline();

/** Each slip hangs a touch off true, as pinned paper does. */
const TILTS = [-0.4, 0.3, -0.15, 0.4, -0.3];

function slipFrameStyle(seed: string, still: boolean): CSSProperties {
	return {
		"--slip-lift": SLIP_SHADOW.lift,
		"--slip-rest": SLIP_SHADOW.rest,
		rotate: still ? undefined : `${TILTS[lookIndex(seed, TILTS.length)]}deg`,
	} as CSSProperties;
}

/** The pin head's colour: the status, as the board's section dots use it. */
export const STATUS_FILL: Record<ThreadStatus, string> = {
	attention: "fill-destructive",
	quiet: "fill-muted-foreground/60",
	waiting: "fill-muted-foreground",
	working: "fill-success",
	"your-turn": "fill-primary",
};

export const STATUS_BG: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-muted-foreground/60",
	waiting: "bg-muted-foreground",
	working: "bg-success",
	"your-turn": "bg-primary",
};

/** A push pin through the slip's stub: a round head and its cast shadow. */
function PushPin({ status }: { status: ThreadStatus }) {
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute top-1.5 left-1/2 z-10 -translate-x-1/2 overflow-visible"
			focusable="false"
			height={18}
			viewBox="0 0 18 18"
			width={18}
		>
			{/* The stem's shadow falls down and to the right of the head. */}
			<path
				d="M9 9 L14 15"
				stroke={PIN_INK.shadow}
				strokeLinecap="round"
				strokeWidth={1.5}
			/>
			<ellipse cx={11} cy={11} fill={PIN_INK.shadow} rx={5.5} ry={4.5} />
			<circle className={STATUS_FILL[status]} cx={9} cy={8} r={5.5} />
			<circle cx={7.25} cy={6.25} fill={PIN_INK.shine} r={1.75} />
		</svg>
	);
}

/** The paper itself: clipped to the slip's outline, shadowed on the cork. */
function Paper({
	children,
	className,
	seed,
	still,
}: {
	children: ReactNode;
	className?: string;
	seed: string;
	still: boolean;
}) {
	return (
		<div
			className={cn(
				"relative h-full [filter:var(--slip-rest)] motion-safe:transition-[filter] motion-safe:duration-150 has-[button:hover]:[filter:var(--slip-lift)]",
				className
			)}
			style={slipFrameStyle(seed, still)}
		>
			<div
				className="relative flex h-full flex-col bg-card text-card-foreground"
				style={{ clipPath: SLIP_OUTLINE, paddingBottom: TOOTH_DEPTH }}
			>
				{children}
			</div>
		</div>
	);
}

/** The ticket stub's dashed tear line, between the punched notches. */
function Perforation() {
	return (
		<span
			aria-hidden="true"
			className="absolute inset-x-2 border-foreground/20 border-t border-dashed"
			style={{ top: STUB_HEIGHT }}
		/>
	);
}

/**
 * One conversation as a paper order slip pinned to the board: a numbered
 * stub, the title and last line, and who is serving it. Serve's target
 * stretches over the whole slip.
 */
export function OrderSlip({
	active,
	hideAge = false,
	homeName,
	now,
	onClose,
	onServe,
	order,
	still,
}: {
	active: boolean;
	/**
	 * With the act layer: no age from `updatedAt` (it moves with renames
	 * and pins, so it is never shown as a time; spec 5.2).
	 */
	hideAge?: boolean;
	/** Where a visiting agent usually works, when it is not this shop. */
	homeName: string | null;
	now: number;
	onClose: () => void;
	onServe: (threadId: string) => void;
	order: MarketOrder;
	/** Reduced motion: slips hang straight. */
	still: boolean;
}) {
	const { thread } = order;
	const tl = useLiteralMessages();
	const title = orderTitle(thread);
	const age = hideAge ? null : compactAge(thread.updatedAt, now);
	const lastLine = thread.lastMessage
		? `${thread.lastMessageRole === "user" ? "You: " : ""}${thread.lastMessage}`
		: "";
	return (
		<article
			aria-current={active ? "true" : undefined}
			aria-label={`${slipNumber(order)}: ${title}`}
			className="relative h-full rounded-[1px] outline-none has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-ring has-[button:focus-visible]:outline-offset-4"
			data-status={order.status}
			data-testid="market-slip"
		>
			<Paper seed={thread.id} still={still}>
				<PushPin status={order.status} />
				{active ? (
					<span
						aria-hidden="true"
						className="absolute inset-y-0 left-0 w-0.5 bg-primary"
					/>
				) : null}
				<header
					className="flex shrink-0 items-center justify-between gap-2 px-3"
					style={{ height: STUB_HEIGHT }}
				>
					<p className="flex items-baseline gap-1 text-foreground tabular-nums">
						<span className="font-medium text-[12px] text-muted-foreground uppercase tracking-wide">
							No.
						</span>
						<span className="font-semibold text-[15px]">
							{String(order.number).padStart(2, "0")}
						</span>
					</p>
					{active ? (
						<p className="flex items-center gap-1.5 font-medium text-[13px] text-primary">
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-primary"
							/>
							Serving
						</p>
					) : (
						<p className="text-[13px] text-muted-foreground tabular-nums">
							{age ? <time dateTime={thread.updatedAt}>{age}</time> : null}
						</p>
					)}
				</header>
				<Perforation />
				<div className="flex flex-1 flex-col gap-1 px-3 pt-3">
					<h4 className="line-clamp-2 text-pretty font-medium text-[15px] text-foreground leading-5">
						{title}
					</h4>
					{lastLine ? (
						<p className="line-clamp-2 text-[13px] text-muted-foreground leading-[18px]">
							{lastLine}
						</p>
					) : null}
				</div>
				<footer className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
					<p className="min-w-0 truncate text-[13px]">
						<span className="font-medium text-foreground">
							{order.agent?.name ?? "Unassigned"}
						</span>
						{homeName ? (
							<span className="text-muted-foreground"> · {homeName}</span>
						) : null}
					</p>
					<Button
						aria-label={
							active
								? tl("Stop serving {slipNumber}: {title}", {
										slipNumber: slipNumber(order),
										title,
									})
								: tl("Serve {slipNumber}: {title}", {
										slipNumber: slipNumber(order),
										title,
									})
						}
						className="shrink-0 after:absolute after:inset-0"
						onClick={() => (active ? onClose() : onServe(thread.id))}
						size="sm"
						type="button"
						variant={active ? "secondary" : "outline"}
					>
						{active ? "Close" : "Serve"}
					</Button>
				</footer>
			</Paper>
		</article>
	);
}

/**
 * An empty space on the board, outlined where the next slip will go. It
 * opens the composer; on an empty board it also says what will appear.
 */
export function NewOrderSlot({
	description,
	onOpen,
}: {
	description: string | null;
	onOpen: () => void;
}) {
	return (
		<button
			className="group/slot flex h-full min-h-40 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-[1px] border-2 border-foreground/15 border-dashed px-6 py-5 text-center outline-none transition-colors duration-150 hover:border-foreground/30 hover:bg-background/20 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4 motion-reduce:transition-none"
			data-testid="market-new-slot"
			onClick={onOpen}
			type="button"
		>
			<span className="flex items-center gap-1.5 font-medium text-[15px] text-foreground">
				<Plus aria-hidden="true" className="size-4" />
				Open a new order
			</span>
			{description ? (
				<span className="max-w-64 text-pretty text-[13px] text-foreground/70 leading-relaxed">
					{description}
				</span>
			) : null}
		</button>
	);
}

/** A board section's label: the status's pin colour, name and count. */
export function SectionHeading({
	count,
	status,
}: {
	count: number;
	status: ThreadStatus;
}) {
	return (
		<h3 className="gk-display flex h-6 items-center gap-2 text-[16px] text-foreground">
			<span
				aria-hidden="true"
				className={cn("size-2 rounded-full", STATUS_BG[status])}
			/>
			<span className="font-semibold">{THREAD_STATUS_LABELS[status]}</span>
			<span className="text-foreground/65 tabular-nums">{count}</span>
		</h3>
	);
}
