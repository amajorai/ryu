import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";

/** Escape inside a text field belongs to the field. */
function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	return (
		!target.isContentEditable &&
		target.closest("input, textarea, select, [contenteditable='true']") === null
	);
}

/**
 * Escape steps back through the workers' sheet, from the root and from the
 * document body; returns the root's key handler.
 */
export function useWorkersEscape(
	stepBack: () => boolean,
	stageRef: RefObject<HTMLDivElement | null>
) {
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!escapeIsFree(event.target)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};
	useEffect(() => {
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.target !== document.body
			) {
				return;
			}
			// A host page shown over the workers keeps its own Escape.
			if (isInterfaceCovered(stageRef.current)) {
				return;
			}
			if (stepBackRef.current()) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [stageRef]);
	return onRootKeyDown;
}
