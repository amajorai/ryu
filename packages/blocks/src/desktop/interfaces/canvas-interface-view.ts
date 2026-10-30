import { useMemo } from "react";
import {
	DOCK_MIN_WIDTH,
	MINIMAP_MIN_WIDTH,
	TINY_ZOOM,
} from "./canvas-interface-constants.ts";
import type { CanvasPointerScope } from "./canvas-interface-scope.ts";
import type { MinimapCard } from "./canvas-minimap.tsx";
import {
	type CanvasRect,
	COMPACT_ZOOM,
	cardPosition,
	cardRect,
	fitFrames,
	gridSpacing,
	offscreenCards,
	revealRect,
	visibleWorldRect,
	worldToScreen,
} from "./canvas-model.ts";

/** Derived render data. */
export function useCanvasView(scope: CanvasPointerScope) {
	const {
		activeThreadId,
		camera,
		cameraRef,
		cardsById,
		composer,
		drag,
		frameFit,
		layout,
		loading,
		minimapShown,
		moveCamera,
		overrides,
		raised,
		rootSize,
		selectedId,
		spaceHeld,
		threadOpen,
		tool,
		viewport,
	} = scope;
	// Derived render data.
	const zIndexOf = (id: string) => raised.indexOf(id) + 1;
	const minimapCards = useMemo<MinimapCard[]>(
		() =>
			layout.cards.map((card) => ({
				id: card.id,
				rect: cardRect(
					drag?.id === card.id ? drag.point : cardPosition(card, overrides)
				),
				selected: card.id === selectedId,
				status: card.status,
			})),
		[layout, overrides, drag, selectedId]
	);
	const offscreen = useMemo(
		() =>
			minimapShown || viewport.width <= 0
				? undefined
				: offscreenCards(
						minimapCards.map((card) => card.rect),
						visibleWorldRect(camera, viewport)
					),
		[minimapShown, minimapCards, camera, viewport]
	);
	const minimapFrames = useMemo(() => [...frameFit.rects.values()], [frameFit]);
	/** Stickies out of their frame now, counting one being dragged out. */
	const movedByFrame = useMemo(() => {
		const loose = drag
			? fitFrames(layout, { ...overrides, [drag.id]: drag.point }).loose
			: frameFit.loose;
		const counts = new Map<string, number>();
		for (const card of layout.cards) {
			if (loose.has(card.id)) {
				counts.set(card.frameId, (counts.get(card.frameId) ?? 0) + 1);
			}
		}
		return counts;
	}, [drag, frameFit, layout, overrides]);

	const empty = !loading && layout.cards.length === 0;
	const grid = gridSpacing(camera.zoom);
	const overlay = rootSize.width > 0 && rootSize.width < DOCK_MIN_WIDTH;
	const activeCard = activeThreadId ? cardsById.get(activeThreadId) : undefined;
	const composerScreen = composer
		? worldToScreen(camera, composer.world)
		: undefined;
	const canPan = tool === "hand" || spaceHeld;
	const compact = camera.zoom < COMPACT_ZOOM;
	const tiny = camera.zoom < TINY_ZOOM;
	// A covering (not docked) thread takes the canvas out of the tab order.
	const covered = overlay && threadOpen;
	const selectedCard = selectedId ? cardsById.get(selectedId) : undefined;
	const showEdgeHints = !(loading || empty || composer);
	const phoneDock = viewport.width < MINIMAP_MIN_WIDTH;
	const revealOffscreen = (rect: CanvasRect) =>
		moveCamera(revealRect(cameraRef.current, rect, viewport, 80));
	const selectable = selectedCard !== undefined && !(loading || empty);
	return {
		zIndexOf,
		minimapCards,
		offscreen,
		minimapFrames,
		movedByFrame,
		empty,
		grid,
		overlay,
		activeCard,
		composerScreen,
		canPan,
		compact,
		tiny,
		covered,
		selectedCard,
		showEdgeHints,
		phoneDock,
		revealOffscreen,
		selectable,
	};
}
