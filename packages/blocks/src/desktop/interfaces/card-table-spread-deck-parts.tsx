import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Inbox } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { type Deck, deckSummary } from "./card-table-decks.ts";
import type { SeatTone } from "./card-table-model.ts";
import { SeatAvatar } from "./card-table-pieces.tsx";
import { compactAge } from "./interface-renderer.ts";

// The pieces every deck of the Cards layout shows, at rest, docked or open:
// its avatar, its name and detail, its labels, and the act layer they read.

/**
 * The Cards layout's act layer: each agent's deck is named by its act
 * sentence, its avatar wears the act's ring and its label carries the
 * act's status line (`ActStatus`, with its Answer and Details buttons).
 */
export interface SpreadActs {
	act: (agentId: string) => InterfaceAgentAct | undefined;
	/** Opens the ask card for an asking agent; null for any other act. */
	answer: (agentId: string) => ((opener: HTMLElement) => void) | null;
	/** The act's status line (`ActStatus`). */
	status: (agentId: string) => ReactNode;
	/** The avatar's ring from the act (`actSeatTone`). */
	tone: (agentId: string) => SeatTone;
}

export const SpreadActsContext = createContext<SpreadActs | null>(null);

/** A deck's act, with the act layer. */
export function useDeckAct(deck: Deck): InterfaceAgentAct | undefined {
	const acts = useContext(SpreadActsContext);
	return deck.agent ? acts?.act(deck.agent.id) : undefined;
}

/** A deck's pile name: its act sentence with acts, else its summary. */
export function deckLabel(
	deck: Deck,
	act: InterfaceAgentAct | undefined,
	action: string
): string {
	return act
		? `${act.ariaLabel} ${action}.`
		: `${deck.name}: ${deckSummary(deck)}. ${action}`;
}

export interface SpreadActions {
	activeThreadId: string | null;
	now: number;
	/** Starts a thread with the agent, or with nobody for the Unassigned deck. */
	onDeal: (agentId?: string) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}

function deckTone(deck: Deck): SeatTone {
	if (deck.working) {
		return "working";
	}
	if (deck.attention > 0) {
		return "attention";
	}
	return deck.yourTurn > 0 ? "your-turn" : "idle";
}

/**
 * The deck's face: the agent's avatar, with the poker action timer running
 * round it while the agent works (the deck's live marker). The Unassigned
 * deck gets an inbox in a dashed ring.
 */
export function DeckAvatar({ deck }: { deck: Deck }) {
	const acts = useContext(SpreadActsContext);
	if (!deck.agent) {
		return (
			<span
				aria-hidden="true"
				className="grid size-[38px] shrink-0 place-items-center"
			>
				<span className="grid size-7 place-items-center rounded-full border-(--gk-ink-muted) border-2 border-dashed text-(--gk-ink-muted)">
					<Inbox className="size-3.5" strokeWidth={1.75} />
				</span>
			</span>
		);
	}
	const live = deck.threads.find((thread) => thread.running);
	return (
		<SeatAvatar
			agent={deck.agent}
			since={acts ? undefined : live?.updatedAt}
			size={28}
			tone={acts ? acts.tone(deck.agent.id) : deckTone(deck)}
		/>
	);
}

/** The deck's strongest signal: a failure, a live run, or replies for you. */
function deckSignal(deck: Deck): { text: string; tone: string } | null {
	if (deck.attention > 0) {
		return {
			text: `${deck.attention} failed`,
			tone: "font-medium text-status-destructive",
		};
	}
	if (deck.working) {
		return { text: "Working", tone: "font-medium text-status-success" };
	}
	if (deck.yourTurn > 0) {
		return { text: `${deck.yourTurn} for you`, tone: "text-foreground" };
	}
	return null;
}

/**
 * The deck's strongest signal, or how long since its newest card moved, or
 * that it has no cards yet.
 */
function deckDetail(deck: Deck, now: number): { text: string; tone: string } {
	const signal = deckSignal(deck);
	if (signal) {
		return signal;
	}
	const newest = deck.threads.reduce(
		(latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
		""
	);
	return newest
		? { text: `${compactAge(newest, now)} ago`, tone: "" }
		: { text: "No cards yet", tone: "" };
}

/** A deck's name with its card count beside it, then its detail under them. */
export function DeckTitle({
	as: Heading,
	deck,
	now,
}: {
	as: "h2" | "h3";
	deck: Deck;
	now: number;
}) {
	const acts = useContext(SpreadActsContext);
	// With acts the status line under the label says it all.
	const detail = acts ? null : deckDetail(deck, now);
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<Heading className="flex min-w-0 items-baseline gap-1.5 leading-5">
				<span className="gk-display truncate text-(--gk-ink) text-[16px]">
					{deck.name}
				</span>
				<span
					className="shrink-0 font-semibold text-(--gk-ink-muted) text-[12px] tabular-nums"
					data-deck-count=""
				>
					{deck.threads.length}
				</span>
			</Heading>
			{detail ? (
				<p
					className={cn(
						"truncate font-semibold text-(--gk-ink-muted) text-[12px] tabular-nums leading-4",
						detail.tone
					)}
				>
					{detail.text}
				</p>
			) : null}
		</div>
	);
}

export function dealLabel(deck: Deck): string {
	return deck.agent
		? `Deal a thread with ${deck.name}`
		: "Deal a thread with no agent";
}
