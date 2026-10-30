import { useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence } from "motion/react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	type RefObject,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	ACT_STATUS_ROOM,
	buildDecks,
	type Deck,
	deckGrid,
	deckSummary,
	dockLayout,
	fanLayout,
	gridMove,
	LABEL_GAP,
	LABEL_HEIGHT,
	MAX_DECK_CARDS,
	MAX_STACK_EDGES,
	STACK_EDGE,
	stageGutter,
} from "./card-table-decks.ts";
import { useCardTableLook } from "./card-table-look.tsx";
import type { StageSize } from "./card-table-model.ts";
import { FELT_INSET, spreadFelt } from "./card-table-palette.ts";
import { SpreadCards } from "./card-table-spread-card.tsx";
import {
	FanBar,
	SpreadEmpty,
	SpreadSkeleton,
} from "./card-table-spread-chrome.tsx";
import {
	type SpreadActions,
	type SpreadActs,
	SpreadActsContext,
} from "./card-table-spread-deck-parts.tsx";
import { SpreadDecks } from "./card-table-spread-decks.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";

// The decks' pieces, the cards and the chrome live in their own modules;
// these re-exports keep the Cards layout's import path for them stable.
export { SPREAD_HINT_ID } from "./card-table-spread-chrome.tsx";
export type {
	SpreadActions,
	SpreadActs,
} from "./card-table-spread-deck-parts.tsx";

/** Laid out at this size until the stage is measured (and in static renders). */
const DEFAULT_STAGE: StageSize = { height: 760, width: 1180 };
const ARROW_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"]);

/**
 * The stage's inner size (scrollbar excluded), measured before paint.
 * `measured` turns true once the layout effect has run, so cards first mount
 * (and deal in) at their real places, never from the default size.
 */
function useStage(ref: RefObject<HTMLDivElement | null>): {
	measured: boolean;
	size: StageSize;
} {
	const [size, setSize] = useState<StageSize>(DEFAULT_STAGE);
	const [measured, setMeasured] = useState(false);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setMeasured(true);
		const measure = () => {
			const width = element.clientWidth;
			const height = element.clientHeight;
			if (width > 0 && height > 0) {
				setSize((current) =>
					current.width === width && current.height === height
						? current
						: { height, width }
				);
			}
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return { measured, size };
}

/** The deck that holds a thread, if any. */
function deckOf(decks: Deck[], threadId: string | null): string | null {
	if (!threadId) {
		return null;
	}
	return (
		decks.find((deck) => deck.threads.some((thread) => thread.id === threadId))
			?.id ?? null
	);
}

/**
 * The Cards layout: no table, the decks on the page. Each agent is a deck of
 * its conversations, the most urgent on top and face up; conversations with
 * no agent are the Unassigned deck. Opening a deck fans its cards out face up
 * while the other decks move aside into a row along the bottom; Escape or a
 * click on the empty page gathers it back. Playing a card opens the host's
 * conversation in the drawer, and a deck's Deal starts a thread with its
 * agent.
 */
export function CardTableSpread({
	actions,
	acts,
	isEmpty,
	loading,
	panelOpen,
}: {
	actions: SpreadActions;
	/** With the act layer: decks read their agents' acts. */
	acts?: SpreadActs;
	isEmpty: boolean;
	loading: boolean;
	panelOpen: boolean;
}) {
	const { activeThreadId, now, onDeal, snapshot } = actions;
	const baize = spreadFelt(useCardTableLook().felt);
	const tl = useLiteralMessages();
	const stageRef = useRef<HTMLDivElement>(null);
	const deckRefs = useRef(new Map<string, HTMLButtonElement>());
	const cardRefs = useRef(new Map<string, HTMLButtonElement>());
	const focusAfter = useRef<"card" | "deck" | null>(null);
	const { measured, size: stage } = useStage(stageRef);
	const decks = useMemo(() => buildDecks(snapshot), [snapshot]);
	const [fannedId, setFannedId] = useState<string | null>(() =>
		deckOf(buildDecks(snapshot), activeThreadId)
	);
	const [deckCursor, setDeckCursor] = useState<string | null>(null);
	const [cardCursor, setCardCursor] = useState<string | null>(activeThreadId);
	const [hoveredDeck, setHoveredDeck] = useState<string | null>(null);
	const [hoveredCard, setHoveredCard] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");

	const fannedIndex = decks.findIndex((deck) => deck.id === fannedId);
	const fanned = fannedIndex === -1 ? undefined : decks[fannedIndex];
	const grid = deckGrid(decks.length, stage, acts ? ACT_STATUS_ROOM : 0);
	const { card } = grid;
	const gutter = stageGutter(stage);
	const dock = dockLayout(decks.length, stage);
	const fan = fanned
		? fanLayout({
				card,
				count: Math.min(fanned.threads.length, MAX_DECK_CARDS),
				dockTop: dock.top,
				stage,
			})
		: null;
	const fanCards = fanned && fan ? fanned.threads.slice(0, fan.shown) : [];
	const liftedIndex = fanCards.findIndex((thread) => thread.id === hoveredCard);
	const contentHeight = fanned ? stage.height : grid.contentHeight;
	const deckTabStop = decks.some((deck) => deck.id === deckCursor)
		? deckCursor
		: (fanned?.id ?? decks[0]?.id ?? null);
	const cardTabStop = fanCards.some((thread) => thread.id === cardCursor)
		? cardCursor
		: (fanCards[0]?.id ?? null);

	const fanOut = (deckId: string, fromKeyboard: boolean) => {
		const deck = decks.find((item) => item.id === deckId);
		if (!deck || deck.threads.length === 0) {
			return;
		}
		focusAfter.current = fromKeyboard ? "card" : null;
		setFannedId(deckId);
		setDeckCursor(deckId);
		setCardCursor(deck.threads[0]?.id ?? null);
		setHoveredDeck(null);
		setHoveredCard(null);
		const act = deck.agent ? acts?.act(deck.agent.id) : undefined;
		setAnnouncement(
			act
				? tl("{deckName}'s deck fanned out", { deckName: deck.name })
				: tl("{deckName}'s deck fanned out: {deckSummary}", {
						deckName: deck.name,
						deckSummary: deckSummary(deck),
					})
		);
		stageRef.current?.scrollTo?.({ top: 0 });
	};
	const gather = () => {
		if (!fanned) {
			return;
		}
		const active = document.activeElement;
		focusAfter.current =
			active === document.body || stageRef.current?.contains(active)
				? "deck"
				: null;
		setDeckCursor(fanned.id);
		setFannedId(null);
		setHoveredCard(null);
		setAnnouncement(
			tl("{deckName}'s deck gathered", { deckName: fanned.name })
		);
	};

	// After a fan or gather, focus follows the cards: into the fan when it was
	// opened from the keyboard, back to the deck when it gathers.
	useLayoutEffect(() => {
		const intent = focusAfter.current;
		if (intent === null) {
			return;
		}
		focusAfter.current = null;
		if (intent === "card" && fanned && cardTabStop) {
			cardRefs.current.get(cardTabStop)?.focus({ preventScroll: true });
		} else if (intent === "deck" && !fanned && deckTabStop) {
			deckRefs.current.get(deckTabStop)?.focus({ preventScroll: true });
		}
	}, [cardTabStop, deckTabStop, fanned]);

	// When the drawer closes it takes its focus with it; put focus back on the
	// card in play (or its deck) instead of dropping it to <body>.
	const wasOpen = useRef(panelOpen);
	useLayoutEffect(() => {
		const closed = wasOpen.current && !panelOpen;
		wasOpen.current = panelOpen;
		if (!closed) {
			return;
		}
		const active = document.activeElement;
		if (
			active &&
			active !== document.body &&
			!active.closest("[data-card-table-drawer]")
		) {
			return;
		}
		const target =
			(cardTabStop && fanned ? cardRefs.current.get(cardTabStop) : undefined) ??
			(deckTabStop ? deckRefs.current.get(deckTabStop) : undefined);
		target?.focus({ preventScroll: true });
	}, [panelOpen, cardTabStop, deckTabStop, fanned]);

	const focusDeckAt = (index: number) => {
		const deck = decks[index];
		if (deck) {
			setDeckCursor(deck.id);
			deckRefs.current.get(deck.id)?.focus();
		}
	};
	const focusCardAt = (index: number) => {
		const thread = fanCards[index];
		if (thread) {
			setCardCursor(thread.id);
			cardRefs.current.get(thread.id)?.focus();
		}
	};

	const onDecksKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		const index = decks.findIndex((deck) => deck.id === deckTabStop);
		const perRow = fanned ? decks.length : grid.perRow;
		const target = gridMove(event.key, index, decks.length, perRow);
		if (target === undefined) {
			return;
		}
		event.preventDefault();
		focusDeckAt(target);
	};
	const onCardsKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey || !fan) {
			return;
		}
		const index = fanCards.findIndex((thread) => thread.id === cardTabStop);
		// One row: up and down step along it too.
		let key = event.key;
		if (key === "ArrowUp") {
			key = "ArrowLeft";
		} else if (key === "ArrowDown") {
			key = "ArrowRight";
		}
		const target = gridMove(key, index, fanCards.length, fanCards.length);
		if (target === undefined) {
			return;
		}
		event.preventDefault();
		focusCardAt(target);
	};
	const onStageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			fanned &&
			!panelOpen &&
			!event.defaultPrevented
		) {
			event.preventDefault();
			gather();
		}
	};
	const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
		const target = event.target;
		if (
			target === event.currentTarget ||
			(target instanceof HTMLElement && target.dataset.surface !== undefined)
		) {
			gather();
		}
	};

	// Keys with nothing focused (after a click on the page) still reach the
	// decks: arrows pick up the decks or the fan, Escape gathers.
	const onDocumentKeyDown = useEffectEvent(
		(event: globalThis.KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.target !== document.body ||
				isInterfaceCovered(stageRef.current)
			) {
				return;
			}
			if (event.key === "Escape" && fanned && !panelOpen) {
				event.preventDefault();
				gather();
				return;
			}
			if (!ARROW_KEYS.has(event.key) || loading) {
				return;
			}
			const target = fanned
				? cardTabStop && cardRefs.current.get(cardTabStop)
				: deckTabStop && deckRefs.current.get(deckTabStop);
			if (target) {
				event.preventDefault();
				target.focus();
			}
		}
	);
	useEffect(() => {
		const listener = (event: globalThis.KeyboardEvent) =>
			onDocumentKeyDown(event);
		document.addEventListener("keydown", listener);
		return () => document.removeEventListener("keydown", listener);
	}, []);

	const restBottom = grid.piles.reduce(
		(bottom, pile) => Math.max(bottom, pile.y + pile.height),
		0
	);
	const hintFits =
		!fanned &&
		grid.contentHeight <= stage.height &&
		stage.height -
			(restBottom + MAX_STACK_EDGES * STACK_EDGE + LABEL_GAP + LABEL_HEIGHT) >=
			64;
	const showDecks = !(loading || isEmpty);

	return (
		<SpreadActsContext.Provider value={acts ?? null}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the bare page gathers the open deck; Escape does the same from the keyboard */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled in onKeyDown */}
			<div
				aria-busy={loading}
				className={cn(
					"relative min-h-0 flex-1 overflow-x-hidden rounded-[24px] [background:var(--ct-felt)] dark:[background:var(--ct-felt-dark)]",
					fanned ? "overflow-y-hidden" : "overflow-y-auto"
				)}
				data-fanned={fanned ? fanned.id : undefined}
				data-testid="card-table-spread"
				onClick={onStageClick}
				onKeyDown={onStageKeyDown}
				ref={stageRef}
				style={
					{
						"--ct-felt": baize.light,
						"--ct-felt-dark": baize.dark,
						boxShadow: FELT_INSET,
					} as CSSProperties
				}
			>
				<div
					className="relative w-full"
					data-surface=""
					style={{ height: contentHeight }}
				>
					{loading ? <SpreadSkeleton stage={stage} /> : null}
					{isEmpty ? <SpreadEmpty onDeal={() => onDeal()} /> : null}
					<AnimatePresence>
						{fanned ? (
							<FanBar
								deck={fanned}
								gutter={gutter}
								key={fanned.id}
								keysHint={!panelOpen}
								now={now}
								onDeal={onDeal}
								onGather={gather}
							/>
						) : null}
					</AnimatePresence>
					{showDecks ? (
						<SpreadCards
							actions={actions}
							card={card}
							cardRefs={cardRefs}
							cardTabStop={cardTabStop}
							decks={decks}
							dock={dock}
							fan={fan}
							fanned={fanned}
							grid={grid}
							hoveredDeck={hoveredDeck}
							// Remounted once measured, so the deal-in starts from real places.
							key={measured ? "measured" : "default"}
							lifted={liftedIndex === -1 ? null : liftedIndex}
							onCursor={setCardCursor}
							onHoverCard={(threadId, hovered) =>
								setHoveredCard((current) => {
									if (hovered) {
										return threadId;
									}
									return current === threadId ? null : current;
								})
							}
							onKeyDown={onCardsKeyDown}
							stage={stage}
						/>
					) : null}
					{showDecks ? (
						<SpreadDecks
							card={card}
							deckRefs={deckRefs}
							decks={decks}
							deckTabStop={deckTabStop}
							dock={dock}
							fanned={fanned}
							grid={grid}
							now={now}
							onDeal={onDeal}
							onFan={fanOut}
							onFocusDeck={setDeckCursor}
							onGather={gather}
							onHoverDeck={setHoveredDeck}
							onKeyDown={onDecksKeyDown}
						/>
					) : null}
				</div>
				{showDecks && hintFits ? (
					<p
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 bottom-4 mx-auto flex w-max items-center justify-center gap-1.5 rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-3 py-1 font-semibold text-(--gk-ink-muted) text-[12px] shadow-[0_2px_0_var(--gk-edge)]"
						data-testid="card-table-spread-keys"
					>
						<Kbd>←</Kbd>
						<Kbd>→</Kbd>
						<span>choose a deck</span>
						<Kbd className="ms-1">↵</Kbd>
						<span>fan it out</span>
					</p>
				) : null}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>
			</div>
		</SpreadActsContext.Provider>
	);
}
