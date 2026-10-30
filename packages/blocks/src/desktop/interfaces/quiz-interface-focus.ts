import {
	type Dispatch,
	type KeyboardEvent,
	type RefObject,
	type SetStateAction,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import { focusTile, revealTile, type TileHandlers } from "./quiz-board.tsx";
import type { FocusTarget, Overlay } from "./quiz-interface-state.ts";
import {
	isBoardKey,
	moveOnBoard,
	type QuizBoard,
	tileAt,
	tilePosition,
} from "./quiz-model.ts";

/** Escape inside a text field belongs to the field. */
function isEditable(target: EventTarget): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/** Move focus with whatever just opened or closed, so it never drops to <body>. */
export function useQuizFocusMove({
	activeThreadId,
	answerRef,
	boothHeadingRef,
	finalFieldRef,
	focusRef,
	panelOpen,
	restoreRef,
	rootRef,
	tabStopId,
}: {
	activeThreadId: string | null;
	answerRef: RefObject<HTMLButtonElement | null>;
	boothHeadingRef: RefObject<HTMLHeadingElement | null>;
	finalFieldRef: RefObject<HTMLTextAreaElement | null>;
	focusRef: RefObject<FocusTarget | null>;
	panelOpen: boolean;
	restoreRef: RefObject<HTMLElement | null>;
	rootRef: RefObject<HTMLDivElement | null>;
	tabStopId: string | null;
}) {
	// Move focus with whatever just opened or closed, so it never drops to <body>.
	useLayoutEffect(() => {
		const target = focusRef.current;
		if (!target) {
			return;
		}
		if (target.kind === "booth" && !panelOpen) {
			return; // Wait for the host to open the thread.
		}
		focusRef.current = null;
		if (target.kind === "answer") {
			answerRef.current?.focus();
		} else if (target.kind === "final") {
			finalFieldRef.current?.focus();
		} else if (target.kind === "booth") {
			boothHeadingRef.current?.focus();
			// Keep the clue being answered in sight beside the booth.
			if (activeThreadId) {
				revealTile(rootRef.current, activeThreadId);
			}
		} else if (
			!(target.kind === "tile" && focusTile(rootRef.current, target.threadId))
		) {
			const opener = restoreRef.current;
			restoreRef.current = null;
			if (opener?.isConnected) {
				opener.focus();
			} else if (tabStopId) {
				focusTile(rootRef.current, tabStopId);
			}
		}
	});
}

/**
 * Escape steps back: out of a card, then out of the answer booth. Returns
 * the root's keydown handler.
 */
export function useQuizEscape({
	backToBoard,
	closeBooth,
	overlay,
	panelOpen,
	rootRef,
}: {
	backToBoard: () => void;
	closeBooth: () => void;
	overlay: Overlay | null;
	panelOpen: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
}) {
	const stepBack = () => {
		if (overlay) {
			backToBoard();
			return true;
		}
		if (panelOpen) {
			closeBooth();
			return true;
		}
		return false;
	};
	const escapeRef = useRef(stepBack);
	escapeRef.current = stepBack;

	// Escape with focus nowhere (after clicking plain text) still steps back.
	const steppable = overlay !== null || panelOpen;
	useEffect(() => {
		if (!steppable) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body &&
				escapeRef.current()
			) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [steppable, rootRef]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape" || event.defaultPrevented) {
			return;
		}
		const inField = isEditable(event.target);
		// In the final question, Escape leaves the card even from the text field.
		if (inField && overlay?.kind !== "final") {
			return;
		}
		if (stepBack()) {
			event.preventDefault();
		}
	};
	return onRootKeyDown;
}

/** The board's tile handlers: roving focus and arrow-key moves. */
export function quizTileHandlers({
	board,
	pick,
	rootRef,
	setRovingId,
	withActs,
}: {
	board: QuizBoard;
	pick: (threadId: string) => void;
	rootRef: RefObject<HTMLDivElement | null>;
	setRovingId: Dispatch<SetStateAction<string | null>>;
	withActs: boolean;
}): TileHandlers {
	return {
		clueFirst: withActs,
		onFocusTile: setRovingId,
		onKeyDown: (event, threadId) => {
			// In the studio the stage already moved focus, in reading order.
			if (event.defaultPrevented) {
				return;
			}
			const toBoardEdge = event.ctrlKey || event.metaKey;
			const edgeKey = event.key === "Home" || event.key === "End";
			if (event.altKey || (toBoardEdge && !edgeKey) || !isBoardKey(event.key)) {
				return;
			}
			const from = tilePosition(board, threadId);
			if (!from) {
				return;
			}
			event.preventDefault();
			const to = moveOnBoard(board, from, event.key, toBoardEdge);
			const next = tileAt(board, to);
			if (next) {
				setRovingId(next.thread.id);
				focusTile(rootRef.current, next.thread.id);
			}
		},
		onPick: pick,
	};
}
