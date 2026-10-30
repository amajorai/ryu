import { type KeyboardEvent, useEffect } from "react";
import { isBoardTarget, isTypingTarget } from "./canvas-hooks.ts";
import type { CanvasPointerScope } from "./canvas-interface-scope.ts";
import { cardRect, NUDGE, NUDGE_LARGE, revealRect } from "./canvas-model.ts";

/** Keyboard handling. */
export function useCanvasKeyboard(scope: CanvasPointerScope) {
	const {
		arrange,
		cameraRef,
		cardsById,
		composer,
		fitView,
		livePosition,
		loading,
		moveCamera,
		openComposerCentered,
		openThread,
		port,
		resetZoom,
		selectedId,
		setCameraNow,
		setComposer,
		setSelectedId,
		setSpaceHeld,
		setTool,
		startGlide,
		threadView,
		updatePositions,
		viewport,
		viewportRef,
		zoomBy,
		zoomToSelection,
	} = scope;
	// Keyboard.
	const nudge = (id: string, dx: number, dy: number) => {
		const point = livePosition(id);
		if (!point) {
			return;
		}
		const next = { x: point.x + dx, y: point.y + dy };
		startGlide(id);
		updatePositions((previous) => ({
			...previous,
			[arrange]: { ...previous[arrange], [id]: next },
		}));
		const revealed = revealRect(
			cameraRef.current,
			cardRect(next),
			viewport,
			48
		);
		if (revealed !== cameraRef.current) {
			setCameraNow(revealed);
		}
	};

	const onEscape = () => {
		if (composer) {
			setComposer(null);
			return true;
		}
		if (threadView) {
			port.closeThread();
			return true;
		}
		if (selectedId) {
			setSelectedId(null);
			viewportRef.current?.focus({ preventScroll: true });
			return true;
		}
		return false;
	};

	const onArrow = (key: string, shift: boolean) => {
		const step = shift ? NUDGE_LARGE : NUDGE;
		const dx = (key === "ArrowRight" ? 1 : 0) - (key === "ArrowLeft" ? 1 : 0);
		const dy = (key === "ArrowDown" ? 1 : 0) - (key === "ArrowUp" ? 1 : 0);
		if (selectedId && cardsById.has(selectedId)) {
			nudge(selectedId, dx * step, dy * step);
			return;
		}
		const pan = shift ? 240 : 64;
		moveCamera(
			{
				x: cameraRef.current.x - dx * pan,
				y: cameraRef.current.y - dy * pan,
				zoom: cameraRef.current.zoom,
			},
			false
		);
	};

	const onShortcut = (
		event: KeyboardEvent<HTMLElement>,
		onBoard: boolean
	): boolean => {
		const modifier = event.ctrlKey || event.metaKey;
		if (event.code === "Digit1" && event.shiftKey && !modifier) {
			fitView();
			return true;
		}
		if (event.code === "Digit2" && event.shiftKey && !modifier) {
			zoomToSelection();
			return true;
		}
		if (
			(event.code === "Digit0" && (event.shiftKey || modifier)) ||
			(modifier && event.key === "0")
		) {
			resetZoom();
			return true;
		}
		if (onBoard && (event.key === "+" || event.key === "=")) {
			zoomBy(1);
			return true;
		}
		if (onBoard && (event.key === "-" || event.key === "_")) {
			zoomBy(-1);
			return true;
		}
		if (modifier || event.altKey) {
			return false;
		}
		const key = event.key.toLowerCase();
		if (key === "v") {
			setTool("select");
			return true;
		}
		if (key === "h") {
			setTool("hand");
			return true;
		}
		if (key === "n" && !loading) {
			openComposerCentered();
			return true;
		}
		return false;
	};

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (isTypingTarget(event.target)) {
			return;
		}
		if (event.key === "Escape") {
			if (onEscape()) {
				event.preventDefault();
			}
			return;
		}
		// Space, Enter, the arrows and +/- drive the board only when the board
		// (or a sticky) has focus; on a focused chrome button they keep their
		// native meaning, so Space and Enter still press it.
		const onBoard = isBoardTarget(event.target);
		if (event.key === " ") {
			if (!onBoard) {
				return;
			}
			event.preventDefault();
			if (!event.repeat) {
				setSpaceHeld(true);
			}
			return;
		}
		if (event.key === "Enter") {
			if (onBoard && selectedId && cardsById.has(selectedId)) {
				event.preventDefault();
				openThread(selectedId);
			}
			return;
		}
		if (event.key.startsWith("Arrow")) {
			if (onBoard) {
				event.preventDefault();
				onArrow(event.key, event.shiftKey);
			}
			return;
		}
		if (onShortcut(event, onBoard)) {
			event.preventDefault();
		}
	};

	const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== " ") {
			return;
		}
		setSpaceHeld(false);
		// Only the board's own Space is swallowed: a chrome button presses on keyup.
		if (isBoardTarget(event.target)) {
			event.preventDefault();
		}
	};

	// Space+drag must not stick when focus leaves mid-press (alt-tab, etc.).
	useEffect(() => {
		const release = () => setSpaceHeld(false);
		const onVisibility = () => {
			if (document.visibilityState !== "visible") {
				release();
			}
		};
		window.addEventListener("blur", release);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("blur", release);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);
	return {
		onKeyDown,
		onKeyUp,
	};
}
