import { useCallback } from "react";
import {
	boardPieces,
	openingFloor,
	placeDropGhost,
	SAFE_INSETS,
	stickyRects,
} from "./canvas-interface-constants.ts";
import type { CanvasFitScope } from "./canvas-interface-scope.ts";
import { MINIMAP_HEIGHT, MINIMAP_WIDTH } from "./canvas-minimap.tsx";
import {
	buildCanvasLayout,
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasArrange,
	type CanvasPoint,
	COMPACT_ZOOM,
	cardRect,
	contentBounds,
	fitCameraInsets,
	overridesForThreads,
	placeClearSticky,
	rectInView,
	revealRect,
	screenToWorld,
	stepZoom,
	unionRects,
	visibleWorldRect,
	zoomAt,
} from "./canvas-model.ts";

/** Thread, composer, zoom and layout actions. */
export function useCanvasActions(scope: CanvasFitScope) {
	const {
		arrange,
		boardCamera,
		cameraRef,
		composer,
		contentRef,
		layout,
		livePosition,
		minimapShownRef,
		moveCamera,
		overrides,
		piecesRef,
		port,
		portrait,
		positions,
		raise,
		selectedId,
		setArrange,
		setComposer,
		setPendingDrop,
		setSelectedId,
		snapshot,
		startGlide,
		updatePositions,
		viewportRef,
		viewportRefSize,
	} = scope;
	const openThread = useCallback(
		(id: string) => {
			setSelectedId(id);
			raise(id);
			port.openThread(id);
		},
		[port, raise]
	);

	/**
	 * Open the new sticky at a drop spot, moving the board only if the spot is
	 * hidden: zoom out just enough to show the board and the new sticky
	 * together while the stickies keep their full face, else pan the least
	 * distance that shows the new sticky whole.
	 */
	const showComposer = useCallback(
		(drop: CanvasPoint, agentId: string | undefined) => {
			setComposer({ agentId, world: drop });
			const current = cameraRef.current;
			const size = viewportRefSize.current;
			const note = cardRect(drop);
			if (rectInView(current, note, size, SAFE_INSETS)) {
				return;
			}
			const together = boardCamera(unionRects([contentRef.current, note]), [
				...piecesRef.current,
				note,
			]);
			const readable =
				together.zoom >= COMPACT_ZOOM && together.zoom <= current.zoom + 0.001;
			moveCamera(readable ? together : revealRect(current, note, size, 32));
		},
		[boardCamera, moveCamera]
	);

	/**
	 * Open the composer at a screen point. The drop ghost is centred on the
	 * pointer (sliding a short way only to clear a sticky under it); the
	 * composer goes on whichever side of it has room. The board only moves when
	 * the ghost would sit partly under the chrome or off the view.
	 */
	const openComposerAt = useCallback(
		(screen: CanvasPoint) => {
			const current = cameraRef.current;
			const size = viewportRefSize.current;
			const world = screenToWorld(current, screen);
			const frame =
				arrange === "agent"
					? layout.frames.find(
							(item) =>
								item.agent &&
								world.x >= item.rect.x &&
								world.x <= item.rect.x + item.rect.width &&
								world.y >= item.rect.y &&
								world.y <= item.rect.y + item.rect.height
						)
					: undefined;
			const zoom = current.zoom;
			const desired = {
				x: world.x - CARD_WIDTH / 2,
				y: world.y - CARD_HEIGHT / 2,
			};
			const obstacles = stickyRects(layout, overrides);
			if (minimapShownRef.current) {
				const corner = screenToWorld(current, {
					x: size.width - 16 - MINIMAP_WIDTH,
					y: size.height - 16 - MINIMAP_HEIGHT,
				});
				obstacles.push({
					height: MINIMAP_HEIGHT / zoom,
					width: MINIMAP_WIDTH / zoom,
					...corner,
				});
			}
			const drop = placeDropGhost(desired, obstacles, zoom);
			showComposer(drop, frame?.agent?.id);
		},
		[arrange, layout, overrides, showComposer]
	);
	/**
	 * "N" or the dock's button: a new sticky in the free canvas nearest the
	 * view's centre, never on top of a frame or a sticky.
	 */
	const openComposerCentered = useCallback(() => {
		const current = cameraRef.current;
		const size = viewportRefSize.current;
		const zoom = current.zoom;
		const view = visibleWorldRect(current, size);
		const within = {
			height: view.height - (SAFE_INSETS.top + SAFE_INSETS.bottom) / zoom,
			width: view.width - (SAFE_INSETS.left + SAFE_INSETS.right) / zoom,
			x: view.x + SAFE_INSETS.left / zoom,
			y: view.y + SAFE_INSETS.top / zoom,
		};
		const obstacles = boardPieces(layout, overrides);
		if (minimapShownRef.current) {
			const corner = screenToWorld(current, {
				x: size.width - 16 - MINIMAP_WIDTH,
				y: size.height - 16 - MINIMAP_HEIGHT,
			});
			obstacles.push({
				height: MINIMAP_HEIGHT / zoom,
				width: MINIMAP_WIDTH / zoom,
				...corner,
			});
		}
		const drop = placeClearSticky(
			screenToWorld(current, { x: size.width / 2, y: size.height / 2 }),
			obstacles,
			within,
			contentBounds(layout, overrides),
			zoom
		);
		showComposer(drop, undefined);
	}, [layout, overrides, showComposer]);

	const submitComposer = (input: { agentId?: string; prompt: string }) => {
		if (!composer) {
			return;
		}
		setPendingDrop({
			arrange,
			known: new Set(snapshot.threads.map((thread) => thread.id)),
			world: composer.world,
		});
		setComposer(null);
		port.startThread(
			input.agentId
				? { agentId: input.agentId, prompt: input.prompt }
				: { prompt: input.prompt }
		);
	};
	const closeComposer = () => {
		setComposer(null);
		viewportRef.current?.focus({ preventScroll: true });
	};

	const zoomBy = useCallback(
		(direction: -1 | 1) => {
			const size = viewportRefSize.current;
			moveCamera(
				zoomAt(
					cameraRef.current,
					{ x: size.width / 2, y: size.height / 2 },
					stepZoom(cameraRef.current.zoom, direction)
				)
			);
		},
		[moveCamera]
	);
	const resetZoom = useCallback(() => {
		const size = viewportRefSize.current;
		moveCamera(
			zoomAt(cameraRef.current, { x: size.width / 2, y: size.height / 2 }, 1)
		);
	}, [moveCamera]);
	/** Shift+2: bring the selected sticky up to 100% (less if the view is small). */
	const zoomToSelection = () => {
		const point = selectedId ? livePosition(selectedId) : undefined;
		if (!point || viewportRefSize.current.width <= 0) {
			return;
		}
		moveCamera(
			fitCameraInsets(cardRect(point), viewportRefSize.current, SAFE_INSETS, {
				margin: 48,
				maxZoom: 1,
			})
		);
	};
	const resetLayout = () => {
		updatePositions((previous) => ({ ...previous, [arrange]: {} }));
		startGlide();
		if (viewportRefSize.current.width > 0) {
			const home = buildCanvasLayout(snapshot, arrange, {}, { portrait });
			moveCamera(
				boardCamera(
					home.bounds,
					boardPieces(home, {}),
					openingFloor(viewportRefSize.current.width, home.bounds.width)
				)
			);
		}
	};
	const changeArrange = (next: CanvasArrange) => {
		if (next === arrange) {
			return;
		}
		setArrange(next);
		startGlide();
		if (viewportRefSize.current.width > 0) {
			const nextOverrides = overridesForThreads(
				positions[next],
				snapshot.threads
			);
			const nextLayout = buildCanvasLayout(snapshot, next, nextOverrides, {
				portrait,
			});
			const nextContent = contentBounds(nextLayout, nextOverrides);
			moveCamera(
				boardCamera(
					nextContent,
					boardPieces(nextLayout, nextOverrides),
					openingFloor(viewportRefSize.current.width, nextContent.width)
				)
			);
		}
	};
	return {
		openThread,
		openComposerAt,
		openComposerCentered,
		submitComposer,
		closeComposer,
		zoomBy,
		resetZoom,
		zoomToSelection,
		resetLayout,
		changeArrange,
	};
}
