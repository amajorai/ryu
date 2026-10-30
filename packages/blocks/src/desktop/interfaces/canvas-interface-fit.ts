import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	boardPieces,
	minimapClearance,
	openingFloor,
	SAFE_INSETS,
	sameCamera,
} from "./canvas-interface-constants.ts";
import type { CanvasStateScope } from "./canvas-interface-scope.ts";
import {
	type CanvasCamera,
	type CanvasRect,
	cardRect,
	contentBounds,
	fitCameraClear,
	fitFrames,
	openingCamera,
	rectInView,
	revealRect,
	unionRects,
} from "./canvas-model.ts";

/** Fitting and revealing: the opening fit, docking refits and drop commits. */
export function useCanvasFit(scope: CanvasStateScope) {
	const {
		activeThreadId,
		autoCameraRef,
		cameraRef,
		createdId,
		layout,
		layoutRef,
		livePositionRef,
		loading,
		minimapShownRef,
		moveCamera,
		moveCameraAuto,
		overrides,
		pendingDrop,
		raise,
		rootWidth,
		setCameraNow,
		setPendingDrop,
		setSelectedId,
		threadView,
		updatePositions,
		viewport,
		viewportRefSize,
	} = scope;
	const frameFit = useMemo(
		() => fitFrames(layout, overrides),
		[layout, overrides]
	);
	const frameFitRef = useRef(frameFit);
	useEffect(() => {
		frameFitRef.current = frameFit;
	}, [frameFit]);
	const content = useMemo(
		() => contentBounds(layout, overrides),
		[layout, overrides]
	);
	const contentRef = useRef(content);
	useEffect(() => {
		contentRef.current = content;
	}, [content]);
	/** Frames and stickies, which fits keep clear of the minimap. */
	const piecesRef = useRef<CanvasRect[]>([]);
	useEffect(() => {
		piecesRef.current = boardPieces(layout, overrides);
	}, [layout, overrides]);

	/** Fit a board centred in the view, clear of the minimap only when it would cover a sticky. */
	const boardCamera = useCallback(
		(
			rect: CanvasRect,
			pieces: readonly CanvasRect[],
			floor?: number
		): CanvasCamera => {
			const size = viewportRefSize.current;
			const clearance = minimapClearance(minimapShownRef.current, size, pieces);
			return floor === undefined
				? fitCameraClear(rect, size, SAFE_INSETS, clearance)
				: openingCamera(rect, size, SAFE_INSETS, floor, clearance);
		},
		[]
	);

	const fitView = useCallback(
		(animated = true) => {
			if (viewportRefSize.current.width <= 0) {
				return;
			}
			moveCamera(boardCamera(contentRef.current, piecesRef.current), animated);
		},
		[boardCamera, moveCamera]
	);

	const threadOpen = threadView !== null;

	// First fit, once the viewport has a size and the snapshot has settled.
	const fittedRef = useRef(false);
	useEffect(() => {
		if (fittedRef.current || loading || viewport.width <= 0 || rootWidth <= 0) {
			return;
		}
		fittedRef.current = true;
		const opening = boardCamera(
			contentRef.current,
			boardPieces(layoutRef.current, overrides),
			openingFloor(viewport.width, contentRef.current.width)
		);
		autoCameraRef.current = opening;
		setCameraNow(opening);
	}, [loading, viewport, rootWidth, overrides, boardCamera, setCameraNow]);

	// Docking a thread narrows the canvas and refits it; closing the thread
	// puts the view back where it was, unless the viewer has moved it since.
	const dockRef = useRef<{ before: CanvasCamera } | null>(null);
	const refitOnWidenRef = useRef(false);
	const wasOpenRef = useRef(false);
	useEffect(() => {
		if (threadOpen) {
			wasOpenRef.current = true;
			if (!dockRef.current && fittedRef.current) {
				dockRef.current = { before: cameraRef.current };
				autoCameraRef.current = cameraRef.current;
			}
			return;
		}
		// Only a thread that was open and has now closed puts the view back.
		if (!wasOpenRef.current) {
			return;
		}
		wasOpenRef.current = false;
		const docked = dockRef.current;
		dockRef.current = null;
		const auto = autoCameraRef.current;
		const untouched = auto !== null && sameCamera(cameraRef.current, auto);
		if (!untouched) {
			return;
		}
		if (docked) {
			moveCameraAuto(docked.before);
		} else {
			// Opened with a thread already docked: refit once the canvas widens.
			refitOnWidenRef.current = true;
		}
	}, [threadOpen, moveCameraAuto]);

	// When a thread opens, keep its sticky in view, with its whole frame when
	// that fits at the current zoom. Docking the panel never zooms the board
	// out (tldraw and FigJam keep the zoom when a panel opens): the board runs
	// under the panel's edge and only pans as far as the open sticky needs.
	const revealedRef = useRef("");
	const seenWidthRef = useRef(0);
	useEffect(() => {
		const widened =
			seenWidthRef.current > 0 && viewport.width > seenWidthRef.current;
		seenWidthRef.current = viewport.width;
		if (widened && refitOnWidenRef.current && fittedRef.current) {
			refitOnWidenRef.current = false;
			moveCameraAuto(
				boardCamera(
					contentRef.current,
					piecesRef.current,
					openingFloor(viewport.width, contentRef.current.width)
				)
			);
			return;
		}
		if (!(activeThreadId && fittedRef.current) || viewport.width <= 0) {
			return;
		}
		const key = `${activeThreadId}:${viewport.width}`;
		if (revealedRef.current === key) {
			return;
		}
		revealedRef.current = key;
		const point = livePositionRef.current(activeThreadId);
		if (!point) {
			return;
		}
		const fit = frameFitRef.current;
		const card = cardRect(point);
		const frameId = layoutRef.current.cards.find(
			(item) => item.id === activeThreadId
		)?.frameId;
		const frame =
			frameId && !fit.loose.has(activeThreadId)
				? fit.rects.get(frameId)
				: undefined;
		const current = cameraRef.current;
		const withFrame = frame ? unionRects([frame, card]) : card;
		const fits =
			withFrame.width * current.zoom <=
				viewport.width - SAFE_INSETS.left - SAFE_INSETS.right &&
			withFrame.height * current.zoom <=
				viewport.height - SAFE_INSETS.top - SAFE_INSETS.bottom;
		const focus = fits ? withFrame : card;
		if (!rectInView(current, focus, viewport, SAFE_INSETS)) {
			moveCameraAuto(revealRect(current, focus, viewport, 72));
		}
	}, [activeThreadId, viewport, boardCamera, moveCameraAuto]);

	// Once the host creates the thread, keep its drop spot for good.
	useEffect(() => {
		if (!(pendingDrop && createdId)) {
			return;
		}
		const target = pendingDrop.arrange;
		const world = {
			x: Math.round(pendingDrop.world.x),
			y: Math.round(pendingDrop.world.y),
		};
		setPendingDrop(null);
		updatePositions((previous) => ({
			...previous,
			[target]: { ...previous[target], [createdId]: world },
		}));
		setSelectedId(createdId);
		raise(createdId);
	}, [pendingDrop, createdId, updatePositions, raise]);
	return {
		frameFit,
		content,
		contentRef,
		piecesRef,
		boardCamera,
		fitView,
		threadOpen,
	};
}
