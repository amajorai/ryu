import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion, type Transition } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	CARD_FLIGHT,
	CARD_HOP,
	CARD_INSTANT,
	type CardMotion,
	cardFlight,
	cardHop,
	cardStagger,
	useCardFlights,
	useCardMove,
} from "./card-motion.ts";
import { CardFace } from "./card-table-face.tsx";
import { HAND_HINT_ID } from "./card-table-hand-extras.tsx";
import {
	type CardPose,
	exposedWidth,
	type HandLayout,
	handPose,
	jitter,
	plural,
	type StageSize,
	type TableGeometry,
} from "./card-table-model.ts";
import { CARD_STOCK } from "./card-table-palette.ts";
import { CardBack } from "./card-table-pieces.tsx";
import { CardVerdictsContext, threadReading } from "./card-table-rows.tsx";
import { agentById } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

// The face and the hand's surroundings live in their own modules; these
// re-exports keep the hand's import path for them stable.
export { CardFace, messageLines } from "./card-table-face.tsx";
export {
	EmptyHand,
	HAND_HINT_ID,
	HandLabel,
	type HandLabelPlacement,
	HeldCardsList,
} from "./card-table-hand-extras.tsx";

/** A dealt card leaves the dealer this small, as if from a deck across the felt. */
const DEALER_SCALE = 0.55;
/** A played card's copy fades out over the end of its flight. */
const PLAYED_FADE: Transition = { delay: 0.28, duration: 0.24, ease: "easeIn" };

/** Where a played card was when it left the hand, so it can fly to the drawer. */
export interface CardFlight {
	from: CardPose;
	thread: InterfaceThread;
	to: { x: number; y: number };
}

/**
 * A copy of a played card that lifts out of the hand and slides toward the
 * drawer's edge on an arc as the drawer opens, then fades: the card is carried to where
 * its conversation appears. Decorative; skipped when motion is reduced.
 */
export function PlayedCardFlight({
	flight,
	geometry,
	now,
	onDone,
	snapshot,
}: {
	flight: CardFlight;
	geometry: TableGeometry;
	now: number;
	onDone: () => void;
	snapshot: InterfaceSnapshot;
}) {
	const { height, width } = geometry.card;
	// One flight per copy: the arc is made once so a re-render cannot bend it.
	const [transition] = useState<Transition>(() => ({
		...cardFlight(),
		opacity: PLAYED_FADE,
	}));
	return (
		<motion.div
			animate={{
				opacity: 0,
				rotate: 5,
				scale: 0.86,
				x: flight.to.x,
				y: flight.to.y,
			}}
			aria-hidden="true"
			className="pointer-events-none absolute top-0 left-0 z-50"
			data-testid="card-table-flight"
			initial={{
				opacity: 1,
				rotate: flight.from.rotate,
				scale: flight.from.scale,
				x: flight.from.x,
				y: flight.from.y,
			}}
			onAnimationComplete={onDone}
			style={{ height, transformOrigin: "50% 135%", width }}
			transition={transition}
		>
			<CardFace
				active
				exposed={width}
				height={height}
				last
				now={now}
				snapshot={snapshot}
				thread={flight.thread}
				width={width}
			/>
		</motion.div>
	);
}

/**
 * Your hand: every thread waiting on you, dealt as a fan of playing cards at
 * the bottom of the table. Hovering or focusing a card lifts it and parts its
 * neighbours; clicking it, or Enter, plays it (opens the thread). The hand is
 * one tab stop; arrow keys, Home and End move along it.
 */
export function CardTableHand({
	activeThreadId,
	cardRefs,
	cards,
	cursorId,
	geometry,
	held,
	layout,
	now,
	onCursor,
	onPlay,
	onTuck,
	snapshot,
	stage,
	tucked = 0,
}: {
	activeThreadId: string | null;
	cardRefs: RefObject<Map<string, HTMLButtonElement>>;
	cards: InterfaceThread[];
	cursorId: string | null;
	geometry: TableGeometry;
	held: number;
	layout: HandLayout;
	now: number;
	onCursor: (threadId: string) => void;
	onPlay: (threadId: string, pose: CardPose) => void;
	/**
	 * A phone's hand tucks into a compact fan: `onTuck(true)` opens it,
	 * `onTuck(false)` tucks it again. Leave out where the hand never tucks.
	 */
	onTuck?: (open: boolean) => void;
	snapshot: InterfaceSnapshot;
	stage: StageSize;
	/** How far the tucked fan sits below its open place (px); 0 is open. */
	tucked?: number;
}) {
	const reduceMotion = useReducedMotion();
	const verdicts = useContext(CardVerdictsContext);
	const [hovered, setHovered] = useState<string | null>(null);
	// Each card's slot as last drawn, read during render to tell a card being
	// dealt (never drawn) from one hopping to a new slot from one staying put.
	const previous = useRef(new Map<string, number>());
	// The stage settles after the hand mounts; a card still being dealt keeps
	// flying to its new place instead of cutting its deal short with a hop.
	const flights = useCardFlights();
	useLayoutEffect(() => {
		previous.current = new Map(
			cards.map((thread, index) => [thread.id, index])
		);
	});
	const stagger = cardStagger(
		cards.filter((thread) => !previous.current.has(thread.id)).length
	);
	let dealt = 0;
	const motionFor = (thread: InterfaceThread, index: number): CardMotion => {
		const slot = previous.current.get(thread.id);
		if (reduceMotion) {
			return { delay: 0, transition: CARD_INSTANT };
		}
		if (slot === undefined) {
			const delay = dealt * stagger;
			dealt += 1;
			return flights.fly(thread.id, delay);
		}
		const flying = flights.flying(thread.id);
		if (flying) {
			return flying;
		}
		return { delay: 0, transition: slot === index ? CARD_HOP : cardHop() };
	};

	const hoveredIndex = cards.findIndex((thread) => thread.id === hovered);
	const activeIndex = cards.findIndex((thread) => thread.id === activeThreadId);
	let lifted: number | null = null;
	if (hoveredIndex !== -1) {
		lifted = hoveredIndex;
	} else if (activeIndex !== -1) {
		lifted = activeIndex;
	}
	const tabStop = cards.some((thread) => thread.id === cursorId)
		? cursorId
		: (cards[0]?.id ?? null);
	const { height, width } = geometry.card;

	const focusCard = (index: number) => {
		const next = cards[Math.min(cards.length - 1, Math.max(0, index))];
		if (next) {
			onCursor(next.id);
			cardRefs.current.get(next.id)?.focus();
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		const index = cards.findIndex((thread) => thread.id === tabStop);
		const moves: Record<string, number> = {
			ArrowDown: index + 1,
			ArrowLeft: index - 1,
			ArrowRight: index + 1,
			ArrowUp: index - 1,
			End: cards.length - 1,
			Home: 0,
		};
		if (event.key === "Escape" && onTuck && tucked === 0) {
			event.preventDefault();
			event.stopPropagation();
			onTuck(false);
			return;
		}
		const target = moves[event.key];
		if (target === undefined) {
			return;
		}
		event.preventDefault();
		focusCard(target);
	};

	return (
		<ul
			aria-describedby={HAND_HINT_ID}
			aria-label={`Your hand: ${plural(cards.length, "card")}${held > 0 ? `, ${held} more held back` : ""}`}
			className="pointer-events-none absolute inset-0 z-20"
			data-hand-tucked={tucked > 0 ? "" : undefined}
			data-testid="card-table-hand"
			onBlur={(event) => {
				// Leaving the hand (a tap on the room) tucks it again.
				const next = event.relatedTarget;
				if (
					onTuck &&
					tucked === 0 &&
					!(next instanceof Node && event.currentTarget.contains(next))
				) {
					onTuck(false);
				}
			}}
			onKeyDown={onKeyDown}
		>
			<AnimatePresence>
				{cards.map((thread, index) => {
					const pose = handPose({
						count: cards.length,
						geometry,
						index,
						lifted,
						spread: layout.spread,
						stage,
					});
					const reading = threadReading(thread, now, verdicts);
					const agent = agentById(snapshot, thread.agentIds[0]);
					const title = thread.title.trim() || "Untitled thread";
					const isActive = thread.id === activeThreadId;
					const isNew = !previous.current.has(thread.id);
					const { delay, transition } = motionFor(thread, index);
					return (
						<HandCard
							faceDown={isNew && !reduceMotion}
							flipDelay={delay}
							from={
								isNew && !reduceMotion
									? {
											rotate: jitter(thread.id, 3) * 24,
											scale: DEALER_SCALE,
											x: geometry.dealer.x - width / 2,
											y: geometry.dealer.y - height / 2,
										}
									: null
							}
							height={height}
							key={thread.id}
							reduceMotion={reduceMotion}
							target={{ ...pose, y: pose.y + tucked }}
							transition={transition}
							width={width}
						>
							<button
								aria-current={isActive ? "true" : undefined}
								aria-label={`${title}. ${reading.label}, ${[agent?.name ?? "no agent", reading.age].filter(Boolean).join(", ")}. Play card`}
								className="group/card block size-full cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
								data-card={thread.id}
								onBlur={() =>
									setHovered((current) =>
										current === thread.id ? null : current
									)
								}
								onClick={() => {
									onCursor(thread.id);
									if (tucked > 0 && onTuck) {
										// A tucked fan opens first; the next tap plays.
										onTuck(true);
										return;
									}
									onPlay(
										thread.id,
										handPose({
											count: cards.length,
											geometry,
											index,
											lifted: index,
											spread: layout.spread,
											stage,
										})
									);
								}}
								onFocus={(event) => {
									onCursor(thread.id);
									setHovered(thread.id);
									// Keyboard focus opens a tucked fan (a tap opens it on click).
									if (
										tucked > 0 &&
										onTuck &&
										event.currentTarget.matches(":focus-visible")
									) {
										onTuck(true);
									}
								}}
								onPointerEnter={() => setHovered(thread.id)}
								onPointerLeave={() =>
									setHovered((current) =>
										current === thread.id ? null : current
									)
								}
								ref={(element: HTMLButtonElement | null) => {
									if (element) {
										cardRefs.current.set(thread.id, element);
									} else {
										cardRefs.current.delete(thread.id);
									}
								}}
								tabIndex={thread.id === tabStop ? 0 : -1}
								type="button"
							>
								<CardFace
									active={isActive}
									exposed={exposedWidth(index, cards.length, layout, width)}
									height={height}
									last={index === cards.length - 1}
									now={now}
									snapshot={snapshot}
									thread={thread}
									width={width}
								/>
							</button>
						</HandCard>
					);
				})}
			</AnimatePresence>
		</ul>
	);
}

/**
 * One card of the hand: a frame that moves with the shared card motion and a
 * 3D body whose face is the card's button and whose back shows while a dealt
 * card is still turning over in flight. A card leaving the hand lifts and fades.
 */
function HandCard({
	children,
	faceDown,
	flipDelay,
	from,
	height,
	reduceMotion,
	target,
	transition,
	width,
}: {
	children: ReactNode;
	/** The side it mounts on: a card dealt from the dealer mounts face down. */
	faceDown: boolean;
	flipDelay: number;
	/** Where a dealt card mounts (the dealer); null mounts it in place. */
	from: Omit<CardPose, "z"> | null;
	height: number;
	reduceMotion: boolean;
	target: CardPose;
	transition: Transition;
	width: number;
}) {
	const frame = useCardMove<HTMLLIElement>(target, transition);
	const initial = from ?? target;
	return (
		<motion.li
			className="pointer-events-auto absolute top-0 left-0"
			exit={
				reduceMotion
					? { opacity: 0, transition: { duration: 0 } }
					: {
							opacity: 0,
							scale: 0.9,
							transition: { duration: 0.2 },
							y: target.y - 40,
						}
			}
			initial={{
				opacity: 1,
				rotate: initial.rotate,
				scale: initial.scale,
				x: initial.x,
				y: initial.y,
			}}
			ref={frame}
			style={{
				height,
				transformOrigin: "50% 135%",
				width,
				zIndex: target.z,
			}}
		>
			<div className="perspective-[1200px] size-full">
				<motion.div
					animate={{ rotateY: 0 }}
					className="transform-3d relative size-full"
					initial={{ rotateY: faceDown ? 180 : 0 }}
					transition={
						reduceMotion ? CARD_INSTANT : { ...CARD_FLIGHT, delay: flipDelay }
					}
				>
					<div className="backface-hidden size-full">{children}</div>
					<CardBack
						className="backface-hidden absolute inset-0 size-full rotate-y-180 rounded-xl border-8 shadow-[0_1px_0_var(--border),0_3px_5px_-1px] shadow-black/45"
						// The card's own stock round the pattern, as on the spread's backs.
						style={{ borderColor: CARD_STOCK["--card"] }}
					/>
				</motion.div>
			</div>
		</motion.li>
	);
}
