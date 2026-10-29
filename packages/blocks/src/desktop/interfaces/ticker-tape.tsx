import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { motion, useAnimationFrame, useMotionValue } from "motion/react";
import { useRef, useState } from "react";
import { compactAge } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	formatChange,
	spokenAge,
	type TickerQuote,
	type TickerTapeItem,
} from "./ticker-model.ts";
import {
	DIRECTION_TEXT,
	DirectionGlyph,
	SYMBOL_TEXT,
} from "./ticker-parts.tsx";

/** Tape speed in CSS pixels per second: slow enough to read in passing. */
const TAPE_SPEED = 40;
/** Fewer entries than this fit on screen without scrolling. */
const MIN_ROLLING_ITEMS = 3;

function TapeEntry({
	copy,
	item,
	now,
	onOpen,
	quote,
}: {
	/** The duplicate half of the loop: hidden from assistive tech and focus. */
	copy: boolean;
	item: TickerTapeItem;
	now: number;
	onOpen: (threadId: string) => void;
	quote: TickerQuote | undefined;
}) {
	const age = compactAge(item.updatedAt, now);
	const speaker = item.role === "user" ? "You" : quote?.agent.name;
	return (
		<li className="flex shrink-0 items-center">
			<button
				aria-label={
					copy
						? undefined
						: [item.title, quote?.agent.name, spokenAge(age)]
								.filter(Boolean)
								.join(", ")
				}
				className="group flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-[13px] outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				data-thread-id={copy ? undefined : item.threadId}
				onClick={() => onOpen(item.threadId)}
				tabIndex={copy ? -1 : undefined}
				type="button"
			>
				<span className={SYMBOL_TEXT}>{item.symbol ?? "—"}</span>
				{quote ? (
					<span
						className={cn(
							"inline-flex items-center gap-1 tabular-nums",
							DIRECTION_TEXT[quote.direction]
						)}
					>
						<DirectionGlyph className="size-2" direction={quote.direction} />
						{formatChange(quote.change)}
					</span>
				) : null}
				<span className="max-w-[28ch] truncate text-foreground">
					{item.title}
				</span>
				<span className="max-w-[32ch] truncate text-muted-foreground">
					{speaker ? `${speaker}: ` : null}
					{item.message}
				</span>
				<span className="text-muted-foreground tabular-nums">{age}</span>
			</button>
		</li>
	);
}

/**
 * The scrolling tape along the top: the newest message in each thread, led by
 * the speaking agent's symbol and day move. It scrolls slowly, stops
 * under the pointer, and holds still (scrollable by hand) for keyboard focus
 * or when the user prefers reduced motion.
 */
export function TickerTape({
	items,
	loading,
	now,
	onOpen,
	quotes,
}: {
	items: TickerTapeItem[];
	loading: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	quotes: Map<string, TickerQuote>;
}) {
	const reduceMotion = useReducedMotion();
	const [hovering, setHovering] = useState(false);
	const [focused, setFocused] = useState(false);
	const trackRef = useRef<HTMLDivElement>(null);
	const offset = useMotionValue(0);
	const rolling =
		!(reduceMotion || focused || loading) && items.length >= MIN_ROLLING_ITEMS;

	useAnimationFrame((_, delta) => {
		if (!rolling || hovering) {
			return;
		}
		const loop = (trackRef.current?.scrollWidth ?? 0) / 2;
		if (loop <= 0) {
			return;
		}
		let next = offset.get() - (TAPE_SPEED * delta) / 1000;
		if (next <= -loop) {
			next += loop;
		}
		offset.set(next);
	});

	let body = (
		<p className="px-4 text-muted-foreground text-xs">No messages yet</p>
	);
	if (loading) {
		body = (
			<div aria-hidden="true" className="flex items-center gap-6 px-4">
				<Skeleton className="h-3 w-40" radius="dense" />
				<Skeleton className="h-3 w-56" radius="dense" />
				<Skeleton className="h-3 w-48" radius="dense" />
			</div>
		);
	} else if (items.length > 0) {
		body = (
			<div
				className={cn(
					"relative h-full min-w-0 flex-1",
					rolling
						? "mask-[linear-gradient(to_right,transparent,black_32px,black_calc(100%-56px),transparent)] overflow-hidden"
						: "overflow-x-auto [scrollbar-width:none]"
				)}
				data-hovering={hovering ? "true" : undefined}
				onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) {
						setFocused(false);
					}
				}}
				onFocus={() => {
					offset.set(0);
					setFocused(true);
				}}
				onPointerEnter={() => setHovering(true)}
				onPointerLeave={() => setHovering(false)}
				role="presentation"
			>
				<motion.div
					className="flex h-full w-max items-center ps-2"
					ref={trackRef}
					style={{ x: rolling ? offset : 0 }}
				>
					<ul
						aria-label="Latest messages"
						className="flex items-center gap-4 pe-4"
					>
						{items.map((item) => (
							<TapeEntry
								copy={false}
								item={item}
								key={item.id}
								now={now}
								onOpen={onOpen}
								quote={item.agentId ? quotes.get(item.agentId) : undefined}
							/>
						))}
					</ul>
					{rolling ? (
						<ul aria-hidden="true" className="flex items-center gap-4 pe-4">
							{items.map((item) => (
								<TapeEntry
									copy
									item={item}
									key={item.id}
									now={now}
									onOpen={onOpen}
									quote={item.agentId ? quotes.get(item.agentId) : undefined}
								/>
							))}
						</ul>
					) : null}
				</motion.div>
			</div>
		);
	}

	return (
		<section
			aria-label="Message tape"
			className="flex h-11 shrink-0 items-center border-border border-b"
			data-rolling={rolling ? "true" : "false"}
			data-testid="ticker-tape"
		>
			<span className="flex h-full w-20 shrink-0 items-center border-border border-e px-4 text-[13px] text-muted-foreground">
				{hovering && rolling ? "Paused" : "Latest"}
			</span>
			{body}
		</section>
	);
}
