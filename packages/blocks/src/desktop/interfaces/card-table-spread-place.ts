import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import {
	type Deck,
	type DeckGrid,
	type DockLayout,
	dockPose,
	type FanLayout,
	fanPose,
	pilePose,
} from "./card-table-decks.ts";
import type { CardPose } from "./card-table-model.ts";

// Where each card of the Cards layout sits, and which zone that is.

/** Where a card sits: its deck's pile, the open fan, or the dock. */
export type Zone = "pile" | "fan" | "dock";

export interface CardPlacement {
	/** How much of the face shows past the next card in the fan. */
	exposed: number;
	faceUp: boolean;
	/** In the open fan: a real, focusable button. */
	interactive: boolean;
	/** The card shows whole, far corner index included. */
	last: boolean;
	/** In the dock: a small face with only the rank and suit. */
	mini: boolean;
	pose: CardPose;
	/** The card's size in that place. */
	size: { height: number; width: number };
	visible: boolean;
}

/**
 * Where one card is: in its deck's pile at rest, face up in the fan when its
 * deck is open, or face down in the dock when another deck is.
 */
export function placeCard({
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
}: {
	card: { height: number; width: number };
	deck: Deck;
	deckIndex: number;
	dock: DockLayout;
	fan: FanLayout | null;
	fannedId: string | null;
	grid: DeckGrid;
	hoveredDeck: string | null;
	index: number;
	/** The fanned card under the pointer or focus. */
	lifted: number | null;
	thread: InterfaceThread;
}): CardPlacement {
	const count = deck.threads.length;
	if (fannedId === null || fan === null) {
		const pile = grid.piles[deckIndex] ?? {
			height: card.height,
			width: card.width,
			x: 0,
			y: 0,
		};
		const { visible, ...pose } = pilePose({
			count,
			id: thread.id,
			index,
			lifted: hoveredDeck === deck.id,
			pile,
		});
		return {
			exposed: card.width,
			faceUp: index === 0,
			interactive: false,
			last: true,
			mini: false,
			pose,
			size: card,
			visible,
		};
	}
	if (deck.id === fannedId) {
		if (index >= fan.shown) {
			// Past what the fan deals: tucked under the "more" card.
			const pose = fanPose({ fan, index: fan.shown, lifted: null });
			return {
				exposed: fan.card.width,
				faceUp: false,
				interactive: false,
				last: true,
				mini: false,
				pose: { ...pose, z: 90 },
				size: fan.card,
				visible: false,
			};
		}
		const whole =
			!fan.overlapped ||
			lifted === index ||
			(index === fan.shown - 1 && fan.more === 0);
		return {
			exposed: whole ? fan.card.width : fan.exposed,
			faceUp: true,
			interactive: true,
			last: whole,
			mini: false,
			pose: fanPose({ fan, index, lifted }),
			size: fan.card,
			visible: true,
		};
	}
	const center = dock.centers[deckIndex] ?? { x: 0, y: 0 };
	const { visible, ...pose } = dockPose({
		center,
		dock,
		id: thread.id,
		index,
	});
	return {
		exposed: dock.card.width,
		faceUp: index === 0,
		interactive: false,
		last: true,
		mini: true,
		pose,
		size: dock.card,
		visible,
	};
}

/** Which zone a placed card is in. */
export function zoneOf(deck: Deck, fannedId: string | null): Zone {
	if (fannedId === null) {
		return "pile";
	}
	return deck.id === fannedId ? "fan" : "dock";
}
