import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type RefObject,
	useLayoutEffect,
	useRef,
} from "react";
import {
	CARD_FLIGHT,
	CARD_HOP,
	CARD_INSTANT,
	type CardMotion,
	cardHop,
	cardStagger,
	useCardFlights,
	useCardMove,
} from "./card-motion.ts";
import {
	type Deck,
	type DeckGrid,
	type DockLayout,
	type FanLayout,
	fanPose,
	MAX_DECK_CARDS,
} from "./card-table-decks.ts";
import { CardFace } from "./card-table-face.tsx";
import {
	type CardPose,
	cardRank,
	jitter,
	type StageSize,
} from "./card-table-model.ts";
import { CARD_STOCK } from "./card-table-palette.ts";
import { CardBack, SUIT_TONE, SuitGlyph } from "./card-table-pieces.tsx";
import { useThreadReading } from "./card-table-rows.tsx";
import { SPREAD_HINT_ID } from "./card-table-spread-chrome.tsx";
import type { SpreadActions } from "./card-table-spread-deck-parts.tsx";
import { FanMoreCard } from "./card-table-spread-more.tsx";
import {
	type CardPlacement,
	placeCard,
	type Zone,
	zoneOf,
} from "./card-table-spread-place.ts";
import { agentById } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

// The Cards layout's cards. Every card stays mounted while its deck rests,
// fans out or docks, so a move is just a new pose: a card going into or out of
// the fan arcs across the page and turns over in flight (`card-motion.ts`),
// while a deck sliding between its pile and the dock moves as one pile.

/** Dealt cards leave a spot at the bottom of the page this small. */
const DEALER_SCALE = 0.6;
const DEALER_GAP = 12;

/**
 * A docked deck's top card: too small for words, so only its corner index,
 * the lead agent's initial over the status suit, large in the middle.
 */
function MiniFace({
	snapshot,
	thread,
}: {
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const { status } = useThreadReading(thread, 0);
	const agent = agentById(snapshot, thread.agentIds[0]);
	return (
		<span
			className={cn(
				"flex size-full flex-col items-center justify-center gap-0.5 rounded-md border bg-card shadow-[0_6px_12px_-8px] shadow-foreground/40",
				status === "attention" ? "border-destructive/60" : "border-border",
				SUIT_TONE[status]
			)}
			style={CARD_STOCK as CSSProperties}
		>
			<span className="font-heading font-semibold text-base leading-none">
				{cardRank(agent?.name)}
			</span>
			<SuitGlyph className="text-xs" status={status} />
		</span>
	);
}

/**
 * One card. The outer element carries its pose; the inner one turns it over
 * (front and back, each hiding its far side), so a deck's face-down cards
 * flip face up as they fan out. Only cards in the open fan are buttons in the
 * tab and reading order; the rest are scenery.
 */
function SpreadCard({
	activeThreadId,
	cardRefs,
	from,
	motion: { delay, transition },
	now,
	onCursor,
	onHover,
	onPlay,
	placement,
	snapshot,
	tabbable,
	thread,
}: {
	activeThreadId: string | null;
	cardRefs: RefObject<Map<string, HTMLButtonElement>>;
	/** Where a dealt card mounts, face down; null mounts it in place. */
	from: (Omit<CardPose, "z"> & { height: number; width: number }) | null;
	motion: CardMotion;
	now: number;
	onCursor: (threadId: string) => void;
	onHover: (threadId: string | null) => void;
	onPlay: (threadId: string) => void;
	placement: CardPlacement;
	snapshot: InterfaceSnapshot;
	tabbable: boolean;
	thread: InterfaceThread;
}) {
	const reduceMotion = useReducedMotion();
	const { exposed, faceUp, interactive, last, mini, pose, size, visible } =
		placement;
	const target = { ...pose, ...size, opacity: visible ? 1 : 0 };
	const frame = useCardMove<HTMLLIElement>(target, transition);
	const initial = from ? { ...from, opacity: target.opacity } : target;
	const reading = useThreadReading(thread, now);
	const agent = agentById(snapshot, thread.agentIds[0]);
	const title = thread.title.trim() || "Untitled thread";
	const active = thread.id === activeThreadId;
	const hidden = !interactive;
	return (
		<motion.li
			aria-hidden={hidden || undefined}
			className={cn(
				"absolute top-0 left-0",
				interactive ? "pointer-events-auto" : "pointer-events-none"
			)}
			data-card-place={interactive ? "fan" : "deck"}
			data-spread-card={thread.id}
			exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
			inert={hidden || undefined}
			initial={{
				height: initial.height,
				opacity: initial.opacity,
				rotate: initial.rotate,
				scale: initial.scale,
				width: initial.width,
				x: initial.x,
				y: initial.y,
			}}
			ref={frame}
			style={{ zIndex: pose.z }}
		>
			<button
				aria-current={active ? "true" : undefined}
				aria-label={`${title}. ${reading.label}, ${[agent?.name ?? "no agent", reading.age].filter(Boolean).join(", ")}. Play card`}
				className="group/card perspective-[1200px] block size-full cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				data-card={thread.id}
				onBlur={() => onHover(null)}
				onClick={() => {
					onCursor(thread.id);
					onPlay(thread.id);
				}}
				onFocus={() => {
					onCursor(thread.id);
					onHover(thread.id);
				}}
				onPointerEnter={() => onHover(thread.id)}
				onPointerLeave={() => onHover(null)}
				ref={(element: HTMLButtonElement | null) => {
					if (element) {
						cardRefs.current.set(thread.id, element);
					} else {
						cardRefs.current.delete(thread.id);
					}
				}}
				tabIndex={tabbable ? 0 : -1}
				type="button"
			>
				<motion.span
					animate={{ rotateY: faceUp ? 0 : 180 }}
					className="transform-3d relative block size-full"
					initial={from && !reduceMotion ? { rotateY: 180 } : false}
					transition={reduceMotion ? CARD_INSTANT : { ...CARD_FLIGHT, delay }}
				>
					<span className="backface-hidden absolute inset-0 block">
						{mini ? (
							<MiniFace snapshot={snapshot} thread={thread} />
						) : (
							<CardFace
								active={active}
								exposed={exposed}
								height={size.height}
								labelled
								last={last}
								now={now}
								snapshot={snapshot}
								thread={thread}
								width={size.width}
							/>
						)}
					</span>
					<span className="backface-hidden absolute inset-0 block rotate-y-180">
						<CardBack
							className={cn(
								"size-full shadow-[0_1px_0_var(--border),0_3px_5px_-1px] shadow-black/45",
								mini ? "rounded-md border-[3px]" : "rounded-xl border-8"
							)}
							// Edges under a face-up card are the card's own colour, so a
							// pile reads as one stack in a dark theme too. The margin is
							// wider than a tilted card under the top one ever shows, so
							// a pile's edges never reveal the pattern.
							style={{ borderColor: CARD_STOCK["--card"] }}
						/>
					</span>
				</motion.span>
			</button>
		</motion.li>
	);
}

/**
 * Every deck's cards in one list, so a card keeps its element as its deck
 * fans out, docks or gathers. Each card's last zone and slot are read during
 * render: a card going into or out of the fan flies (one after another), a
 * deck sliding between its pile and the dock moves as one pile, a card that
 * changes slot hops, and a card never drawn is dealt in face down from the
 * bottom of the page. Remount it (a new `key`) to deal the whole table again.
 */
export function SpreadCards({
	actions,
	card,
	cardRefs,
	cardTabStop,
	decks,
	dock,
	fan,
	fanned,
	grid,
	hoveredDeck,
	lifted,
	onCursor,
	onHoverCard,
	onKeyDown,
	stage,
}: {
	actions: SpreadActions;
	card: { height: number; width: number };
	cardRefs: RefObject<Map<string, HTMLButtonElement>>;
	cardTabStop: string | null;
	decks: Deck[];
	dock: DockLayout;
	fan: FanLayout | null;
	fanned: Deck | undefined;
	grid: DeckGrid;
	hoveredDeck: string | null;
	/** The fanned card under the pointer or focus. */
	lifted: number | null;
	onCursor: (threadId: string) => void;
	onHoverCard: (threadId: string, hovered: boolean) => void;
	onKeyDown: (event: KeyboardEvent<HTMLUListElement>) => void;
	stage: StageSize;
}) {
	const { activeThreadId, now, onOpen, snapshot } = actions;
	const reduceMotion = useReducedMotion();
	const fannedId = fanned?.id ?? null;
	const previous = useRef(new Map<string, { index: number; zone: Zone }>());
	const flights = useCardFlights();

	const placed = decks.flatMap((deck, deckIndex) =>
		deck.threads.slice(0, MAX_DECK_CARDS).map((thread, index) => ({
			index,
			placement: placeCard({
				card,
				deck,
				deckIndex,
				dock,
				fan,
				fannedId,
				grid,
				hoveredDeck,
				index,
				lifted,
				thread,
			}),
			thread,
			zone: zoneOf(deck, fannedId),
		}))
	);
	useLayoutEffect(() => {
		previous.current = new Map(
			placed.map(({ index, thread, zone }) => [thread.id, { index, zone }])
		);
	});

	// A card flies when it is dealt, or goes into or out of the fan.
	const flies = (id: string, zone: Zone) => {
		const was = previous.current.get(id);
		return (
			was === undefined ||
			(was.zone !== zone && (zone === "fan" || was.zone === "fan"))
		);
	};
	const stagger = cardStagger(
		placed.filter(({ thread, zone }) => flies(thread.id, zone)).length
	);
	let flown = 0;
	const motionFor = (id: string, index: number, zone: Zone): CardMotion => {
		if (reduceMotion) {
			return { delay: 0, transition: CARD_INSTANT };
		}
		if (flies(id, zone)) {
			const delay = flown * stagger;
			flown += 1;
			return flights.fly(id, delay);
		}
		const flying = flights.flying(id);
		if (flying) {
			return flying;
		}
		const was = previous.current.get(id);
		return {
			delay: 0,
			transition:
				was?.zone === zone && was.index !== index ? cardHop() : CARD_HOP,
		};
	};

	const dealer = (id: string, size: { height: number; width: number }) => ({
		...size,
		rotate: jitter(id, 3) * 18,
		scale: DEALER_SCALE,
		x: stage.width / 2 - size.width / 2,
		y: stage.height - size.height - DEALER_GAP,
	});
	const moreThreads =
		fanned && fan?.more ? fanned.threads.slice(fan.shown) : [];
	const morePose =
		fan && fan.more > 0
			? fanPose({ fan, index: fan.shown, lifted: null })
			: null;

	return (
		<ul
			aria-describedby={fanned ? SPREAD_HINT_ID : undefined}
			aria-hidden={fanned ? undefined : true}
			aria-label={fanned ? `${fanned.name}'s cards` : undefined}
			className="pointer-events-none absolute inset-0 z-20"
			data-testid="card-table-spread-cards"
			onKeyDown={onKeyDown}
		>
			<AnimatePresence>
				{placed.map(({ index, placement, thread, zone }) => (
					<SpreadCard
						activeThreadId={activeThreadId}
						cardRefs={cardRefs}
						from={
							previous.current.has(thread.id) || reduceMotion
								? null
								: dealer(thread.id, placement.size)
						}
						key={thread.id}
						motion={motionFor(thread.id, index, zone)}
						now={now}
						onCursor={onCursor}
						onHover={(threadId) => onHoverCard(thread.id, threadId !== null)}
						onPlay={onOpen}
						placement={placement}
						snapshot={snapshot}
						tabbable={placement.interactive && thread.id === cardTabStop}
						thread={thread}
					/>
				))}
				{fanned && morePose ? (
					<FanMoreCard
						actions={actions}
						card={fan?.card ?? card}
						deckName={fanned.name}
						key={`more-${fanned.id}`}
						pose={morePose}
						threads={moreThreads}
					/>
				) : null}
			</AnimatePresence>
		</ul>
	);
}
