import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";

/**
 * Escape inside a text field belongs to the field, except in the play slip
 * while it is empty: there it closes the slip.
 */
export function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	const editable =
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !==
			null;
	if (!editable) {
		return true;
	}
	return (
		target instanceof HTMLTextAreaElement &&
		target.closest("[data-arcade-composer]") !== null &&
		target.value.trim() === ""
	);
}

/**
 * Escape steps back through the floor's layers, from inside the floor or
 * from the page body.
 */
export function useArcadeEscape(
	rootRef: RefObject<HTMLDivElement | null>,
	stepBack: () => boolean
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
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.target !== document.body
			) {
				return;
			}
			if (stepBackRef.current()) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, []);
	return onRootKeyDown;
}
