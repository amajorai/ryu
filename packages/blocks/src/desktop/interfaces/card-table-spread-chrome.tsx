import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { ChevronLeft, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useContext } from "react";
import {
	type Deck,
	deckGrid,
	LABEL_GAP,
	LABEL_HEIGHT,
	MAX_STACK_EDGES,
	SPREAD_HEADING,
	STACK_EDGE,
} from "./card-table-decks.ts";
import type { StageSize } from "./card-table-model.ts";
import { CardBack } from "./card-table-pieces.tsx";
import {
	DeckAvatar,
	DeckTitle,
	dealLabel,
	SpreadActsContext,
	useDeckAct,
} from "./card-table-spread-deck-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

// The Cards layout's chrome round the cards: the bar over an open deck, the
// loading skeleton and the empty page.

const SKELETON_DECKS = ["deck-1", "deck-2", "deck-3", "deck-4", "deck-5"];
/** The bar over an open deck sits this far below the stage's top. */
const BAR_TOP = 16;
export const SPREAD_HINT_ID = "card-table-spread-hint";

/**
 * The bar over an open deck: back to all the decks, who the deck belongs to
 * with its count and strongest signal, and its Deal.
 */
export function FanBar({
	deck,
	gutter,
	keysHint,
	now,
	onDeal,
	onGather,
}: {
	deck: Deck;
	gutter: number;
	/** The key hints show only while Escape gathers (no thread open). */
	keysHint: boolean;
	now: number;
	onDeal: (agentId?: string) => void;
	onGather: () => void;
}) {
	const reduceMotion = useReducedMotion();
	const acts = useContext(SpreadActsContext);
	const act = useDeckAct(deck);
	return (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			className="pointer-events-auto absolute inset-x-0 z-30 flex items-center gap-3"
			data-testid="card-table-fan-bar"
			exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.12 } }}
			initial={reduceMotion ? false : { opacity: 0, y: -6 }}
			style={{
				height: SPREAD_HEADING,
				paddingInline: gutter,
				top: BAR_TOP,
			}}
			transition={reduceMotion ? { duration: 0 } : { duration: 0.2 }}
		>
			<div className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) px-2 text-(--gk-ink) shadow-(--gk-lip)">
				<Button
					aria-keyshortcuts="Escape"
					className="text-(--gk-ink-muted) hover:bg-(--gk-plate-sunk) hover:text-(--gk-ink)"
					onClick={onGather}
					size="sm"
					title="Gather the deck (Esc)"
					type="button"
					variant="ghost"
				>
					<ChevronLeft aria-hidden="true" data-icon="inline-start" />
					<span className="max-sm:sr-only">All decks</span>
				</Button>
				<span
					aria-hidden="true"
					className="h-6 w-0.5 shrink-0 bg-(--gk-plate-sunk)"
				/>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<DeckAvatar deck={deck} />
					<DeckTitle as="h2" deck={deck} now={now} />
					{act && acts ? (
						<div
							className="min-w-0 max-sm:hidden [&_[data-act-status]>span]:truncate [&_[data-act-status]]:flex-nowrap"
							data-deck-status=""
						>
							{acts.status(act.agentId)}
						</div>
					) : null}
				</div>
				<p className="sr-only" id={SPREAD_HINT_ID}>
					Arrow keys move between cards, Enter opens the thread, and Escape
					gathers the deck.
				</p>
				{keysHint ? (
					<p
						aria-hidden="true"
						className="flex shrink-0 items-center gap-1.5 font-semibold text-(--gk-ink-muted) text-[12px] max-lg:hidden"
					>
						<Kbd>←</Kbd>
						<Kbd>→</Kbd>
						<span>choose</span>
						<Kbd className="ms-1">↵</Kbd>
						<span>open</span>
						<Kbd className="ms-1">Esc</Kbd>
						<span>gather</span>
					</p>
				) : null}
				<Button
					onClick={() => onDeal(deck.agent?.id)}
					size="sm"
					title={dealLabel(deck)}
					type="button"
					variant="outline"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					Deal
				</Button>
			</div>
		</motion.div>
	);
}

export function SpreadSkeleton({ stage }: { stage: StageSize }) {
	const grid = deckGrid(SKELETON_DECKS.length, stage);
	return (
		<div aria-hidden="true" className="absolute inset-0">
			{SKELETON_DECKS.map((key, index) => {
				const pile = grid.piles[index];
				if (!pile) {
					return null;
				}
				return (
					<div
						className="absolute"
						key={key}
						style={{ left: pile.x, top: pile.y, width: pile.width }}
					>
						<Skeleton
							radius="panel"
							style={{ height: pile.height + STACK_EDGE * MAX_STACK_EDGES }}
						/>
						<div
							className="flex items-center gap-2"
							style={{ height: LABEL_HEIGHT, marginTop: LABEL_GAP }}
						>
							<Skeleton className="ms-[5px] size-7" radius="pill" />
							<div className="flex flex-1 flex-col gap-1.5">
								<Skeleton className="h-2.5 w-16" radius="pill" />
								<Skeleton className="h-2 w-10" radius="pill" />
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}

export function SpreadEmpty({ onDeal }: { onDeal: () => void }) {
	return (
		<Empty className="h-full" data-testid="card-table-spread-empty">
			<EmptyHeader>
				<EmptyMedia>
					<span aria-hidden="true" className="relative block h-14 w-11">
						<CardBack className="absolute inset-0 -rotate-6 rounded-md" />
						<span className="absolute inset-0 rotate-3 rounded-md border border-border bg-card shadow-sm" />
					</span>
				</EmptyMedia>
				<EmptyTitle>No decks yet</EmptyTitle>
				<EmptyDescription>
					Each agent gets a deck of its threads, the ones waiting on you on top.
					Deal a thread to start one.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onDeal} type="button">
					<Plus aria-hidden="true" data-icon="inline-start" />
					Deal a thread
				</Button>
			</EmptyContent>
		</Empty>
	);
}
