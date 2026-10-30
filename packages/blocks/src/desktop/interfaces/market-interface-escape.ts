import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";

/**
 * Escape inside a text field belongs to the field, except in the order
 * composer while it is empty: there it closes the shop.
 */
function escapeIsFree(target: EventTarget | null): boolean {
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
		target.closest("[data-market-composer]") !== null &&
		target.value.trim() === ""
	);
}

/**
 * Escape steps back (see `stepBack`) from the root or, when nothing holds
 * focus, from the document.
 */
export function useMarketEscape(
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
