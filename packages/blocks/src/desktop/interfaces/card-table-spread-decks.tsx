import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import { motion } from "motion/react";
import {
	type Dispatch,
	type KeyboardEvent,
	type MouseEvent,
	type RefObject,
	type SetStateAction,
	useContext,
} from "react";
import { CARD_HOP, CARD_INSTANT } from "./card-motion.ts";
import {
	ACT_STATUS_ROOM,
	type Deck,
	type DeckGrid,
	type DockLayout,
	LABEL_GAP,
	LABEL_HEIGHT,
	MAX_STACK_EDGES,
	pileBounds,
	STACK_EDGE,
} from "./card-table-decks.ts";
import {
	DeckAvatar,
	DeckTitle,
	dealLabel,
	deckLabel,
	SpreadActsContext,
	useDeckAct,
} from "./card-table-spread-deck-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

// The decks' own buttons and labels in the Cards layout: at rest in a grid,
// or docked in a row along the bottom while one deck is fanned out.

/** Narrower resting cards leave their label no room for a Deal button. */
const LABEL_DEAL_MIN = 148;

/** A deck at rest: its pile (a button that fans it) and its label. */
function RestingDeck({
	card,
	deck,
	deckRefs,
	now,
	onDeal,
	onFan,
	onFocusDeck,
	onHover,
	tabbable,
}: {
	card: { height: number; width: number };
	deck: Deck;
	deckRefs: RefObject<Map<string, HTMLButtonElement>>;
	now: number;
	onDeal: (agentId?: string) => void;
	onFan: (deckId: string, fromKeyboard: boolean) => void;
	onFocusDeck: (deckId: string) => void;
	onHover: (deckId: string | null) => void;
	tabbable: boolean;
}) {
	const acts = useContext(SpreadActsContext);
	const act = useDeckAct(deck);
	const answer = act ? (acts?.answer(act.agentId) ?? null) : null;
	const empty = deck.threads.length === 0;
	const fullHeight = card.height + MAX_STACK_EDGES * STACK_EDGE;
	const pileHeight = pileBounds(
		{ height: card.height, width: card.width, x: 0, y: 0 },
		deck.threads.length
	).height;
	return (
		<>
			<button
				aria-expanded={empty ? undefined : false}
				aria-label={
					empty && !act
						? dealLabel(deck)
						: deckLabel(deck, act, empty ? "Deal a thread" : "Fan out the deck")
				}
				className="group/deck relative block w-full cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				data-act-agent={act?.agentId}
				data-deck={deck.id}
				onBlur={() => onHover(null)}
				onClick={(event: MouseEvent<HTMLButtonElement>) => {
					if (empty) {
						onDeal(deck.agent?.id);
						return;
					}
					onFan(deck.id, event.detail === 0);
				}}
				onFocus={() => {
					onFocusDeck(deck.id);
					onHover(deck.id);
				}}
				onPointerEnter={() => onHover(deck.id)}
				onPointerLeave={() => onHover(null)}
				ref={(element: HTMLButtonElement | null) => {
					if (element) {
						deckRefs.current.set(deck.id, element);
					} else {
						deckRefs.current.delete(deck.id);
					}
				}}
				style={{ height: pileHeight }}
				tabIndex={tabbable ? 0 : -1}
				type="button"
			>
				{empty ? (
					<span className="flex size-full flex-col items-center justify-center gap-2 rounded-xl border-(--gk-plate)/55 border-[3px] border-dashed bg-(--gk-edge)/20 text-(--gk-plate) transition-colors duration-150 group-hover/deck:bg-(--gk-edge)/35">
						<Plus aria-hidden="true" className="size-5" strokeWidth={3} />
						<span className="gk-display text-[14px]">Deal a thread</span>
					</span>
				) : null}
			</button>
			<div
				className="flex items-center gap-2 rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) ps-0.5 pe-2 shadow-[0_2px_0_var(--gk-edge)]"
				style={{
					height: LABEL_HEIGHT,
					marginTop: LABEL_GAP + fullHeight - pileHeight,
				}}
			>
				<div className="relative flex min-w-0 flex-1 items-center gap-2">
					<DeckAvatar deck={deck} />
					<DeckTitle as="h3" deck={deck} now={now} />
					{answer && act ? (
						// A pointer shortcut: an asking deck's label opens the ask.
						// The keyboard's way there is the status line's Answer.
						<button
							aria-label={`${act.ariaLabel} Answer their ask.`}
							className="absolute inset-0 cursor-pointer rounded-xl"
							data-deck-answer={act.agentId}
							onClick={(event) =>
								// Focus comes back to the pile, the deck's Tab stop.
								answer(deckRefs.current.get(deck.id) ?? event.currentTarget)
							}
							tabIndex={-1}
							type="button"
						/>
					) : null}
				</div>
				{empty || card.width < LABEL_DEAL_MIN ? null : (
					<Button
						aria-label={dealLabel(deck)}
						className="-me-1 text-(--gk-ink-muted) hover:bg-(--gk-plate-sunk) hover:text-(--gk-ink)"
						onClick={() => onDeal(deck.agent?.id)}
						size="icon-sm"
						tabIndex={-1}
						title={dealLabel(deck)}
						type="button"
						variant="ghost"
					>
						<Plus aria-hidden="true" />
					</Button>
				)}
			</div>
			{act && acts ? (
				<div
					className="mt-1.5 flex min-w-0 text-(--gk-ink) [&_[data-act-status]>span]:max-w-full [&_[data-act-status]>span]:truncate [&_[data-act-status]]:w-full [&_[data-act-status]]:min-w-0"
					data-deck-status=""
					style={{ minHeight: ACT_STATUS_ROOM - 6 }}
				>
					{acts.status(act.agentId)}
				</div>
			) : null}
		</>
	);
}

/** A deck moved aside while another is fanned: a small pile and its name. */
function DockedDeck({
	deck,
	deckRefs,
	dock,
	dockCardHeight,
	fanned,
	onFan,
	onFocusDeck,
	onGather,
	tabbable,
}: {
	deck: Deck;
	deckRefs: RefObject<Map<string, HTMLButtonElement>>;
	dock: DockLayout;
	dockCardHeight: number;
	fanned: boolean;
	onFan: (deckId: string, fromKeyboard: boolean) => void;
	onFocusDeck: (deckId: string) => void;
	onGather: () => void;
	tabbable: boolean;
}) {
	const reduceMotion = useReducedMotion();
	const act = useDeckAct(deck);
	const empty = deck.threads.length === 0;
	// With acts the live and failure marks come from the act.
	const working = act ? act.act === "working" : deck.working;
	const failed = act
		? act.blockers.some(
				(blocker) =>
					blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
			)
		: deck.attention > 0;
	let label = deckLabel(deck, act, "Fan out the deck");
	if (fanned) {
		label = `${deck.name}: fanned out. Gather the deck`;
	} else if (empty) {
		label = `${deck.name}: no cards`;
	}
	return (
		<button
			aria-disabled={empty && !fanned ? true : undefined}
			aria-expanded={empty ? undefined : fanned}
			aria-label={label}
			className={cn(
				"group/deck flex w-full cursor-pointer flex-col items-center rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
				empty && !fanned && "cursor-default"
			)}
			data-act-agent={act?.agentId}
			data-deck={deck.id}
			onClick={(event: MouseEvent<HTMLButtonElement>) => {
				if (fanned) {
					onGather();
				} else if (!empty) {
					onFan(deck.id, event.detail === 0);
				}
			}}
			onFocus={() => onFocusDeck(deck.id)}
			ref={(element: HTMLButtonElement | null) => {
				if (element) {
					deckRefs.current.set(deck.id, element);
				} else {
					deckRefs.current.delete(deck.id);
				}
			}}
			tabIndex={tabbable ? 0 : -1}
			type="button"
		>
			<span
				className="relative block transition-transform duration-150 group-hover/deck:-translate-y-0.5 motion-reduce:transition-none"
				style={{ height: dockCardHeight, width: dock.card.width }}
			>
				{fanned || empty ? (
					<span className="absolute inset-0 rounded-md border border-border border-dashed group-hover/deck:border-foreground/30" />
				) : null}
				{working && !fanned ? (
					<span
						aria-hidden="true"
						className="absolute -top-1 -right-1 z-10 grid size-2.5 place-items-center"
						data-live-marker=""
					>
						{reduceMotion ? null : (
							<span className="absolute inset-0 animate-ping rounded-full bg-success/60 [animation-duration:2s]" />
						)}
						<span className="relative size-2 rounded-full bg-success ring-2 ring-background" />
					</span>
				) : null}
				{failed && !fanned && !working ? (
					<span
						aria-hidden="true"
						className="absolute -top-1 -right-1 z-10 size-2 rounded-full bg-destructive ring-2 ring-background"
					/>
				) : null}
			</span>
			{dock.named ? (
				<span
					className={cn(
						"mt-2 block max-w-full truncate px-1 text-xs leading-4 transition-colors",
						fanned
							? "font-medium text-foreground"
							: "text-muted-foreground group-hover/deck:text-foreground"
					)}
				>
					{deck.name}
				</span>
			) : null}
		</button>
	);
}

/**
 * The decks' list: each deck's pile button and label at rest, or its small
 * docked pile while another deck is fanned. The decks slide between the two
 * with the cards' hop, so a deck and its cards land together.
 */
export function SpreadDecks({
	card,
	deckRefs,
	deckTabStop,
	decks,
	dock,
	fanned,
	grid,
	now,
	onDeal,
	onFan,
	onFocusDeck,
	onGather,
	onHoverDeck,
	onKeyDown,
}: {
	card: { height: number; width: number };
	deckRefs: RefObject<Map<string, HTMLButtonElement>>;
	deckTabStop: string | null;
	decks: Deck[];
	dock: DockLayout;
	fanned: Deck | undefined;
	grid: DeckGrid;
	now: number;
	onDeal: (agentId?: string) => void;
	onFan: (deckId: string, fromKeyboard: boolean) => void;
	onFocusDeck: (deckId: string) => void;
	onGather: () => void;
	onHoverDeck: Dispatch<SetStateAction<string | null>>;
	onKeyDown: (event: KeyboardEvent<HTMLUListElement>) => void;
}) {
	const reduceMotion = useReducedMotion();
	const transition = reduceMotion ? CARD_INSTANT : CARD_HOP;
	const dockCardHeight = dock.card.height;
	return (
		<ul
			aria-label="Decks"
			className="pointer-events-none absolute inset-0 z-30"
			data-testid="card-table-decks"
			onKeyDown={onKeyDown}
		>
			{decks.map((deck, deckIndex) => {
				const tabbable = deck.id === deckTabStop;
				if (fanned) {
					const center = dock.centers[deckIndex] ?? { x: 0, y: 0 };
					return (
						<motion.li
							animate={{
								x: center.x - dock.slotWidth / 2,
								y: center.y - dockCardHeight / 2,
							}}
							className="pointer-events-auto absolute top-0 left-0"
							data-deck-place="dock"
							initial={false}
							key={deck.id}
							style={{ width: dock.slotWidth }}
							transition={transition}
						>
							<DockedDeck
								deck={deck}
								deckRefs={deckRefs}
								dock={dock}
								dockCardHeight={dockCardHeight}
								fanned={deck.id === fanned.id}
								onFan={onFan}
								onFocusDeck={onFocusDeck}
								onGather={onGather}
								tabbable={tabbable}
							/>
						</motion.li>
					);
				}
				const pile = grid.piles[deckIndex] ?? {
					height: card.height,
					width: card.width,
					x: 0,
					y: 0,
				};
				return (
					<motion.li
						animate={{ x: pile.x, y: pile.y }}
						className="pointer-events-auto absolute top-0 left-0"
						data-deck-place="rest"
						initial={false}
						key={deck.id}
						style={{ width: card.width }}
						transition={transition}
					>
						<RestingDeck
							card={card}
							deck={deck}
							deckRefs={deckRefs}
							now={now}
							onDeal={onDeal}
							onFan={onFan}
							onFocusDeck={onFocusDeck}
							onHover={(deckId) =>
								onHoverDeck((current) =>
									deckId === null && current !== deck.id ? current : deckId
								)
							}
							tabbable={tabbable}
						/>
					</motion.li>
				);
			})}
		</ul>
	);
}
