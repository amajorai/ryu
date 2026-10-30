import { useEffect } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import { isEditable } from "./passport-interface-dom.ts";
import type { PassportNavigation } from "./passport-navigation.ts";

/** The passport's keyboard: Escape closes, the paging keys turn the pages. */
export function usePassportKeys({
	anySheet,
	closePanel,
	goToSpread,
	next,
	panelOpen,
	previous,
	rootRef,
	setSheet,
	spreads,
	turnable,
}: {
	anySheet: boolean;
	closePanel: () => void;
	goToSpread: PassportNavigation["goToSpread"];
	next: PassportNavigation["next"];
	panelOpen: boolean;
	previous: PassportNavigation["previous"];
	rootRef: { current: HTMLElement | null };
	setSheet: (sheet: null) => void;
	spreads: readonly unknown[];
	turnable: boolean;
}): void {
	// Escape files the open record (or drops the application), else closes
	// the booklet or the map, from anywhere in the passport except inside the
	// host's conversation, which owns its keys.
	useEffect(() => {
		if (!anySheet) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			const element = event.target instanceof Node ? event.target : null;
			const inside =
				element === document.body ||
				(element !== null && rootRef.current?.contains(element));
			const inThread =
				element instanceof Element && element.closest("[data-passport-thread]");
			if (!inside || inThread || isEditable(event.target)) {
				return;
			}
			event.preventDefault();
			if (panelOpen) {
				closePanel();
			} else {
				setSheet(null);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [anySheet, closePanel, panelOpen]);
	useEffect(() => {
		if (!turnable) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.altKey ||
				event.metaKey ||
				event.ctrlKey ||
				isEditable(event.target) ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			const element = event.target instanceof Element ? event.target : null;
			const onBody = event.target === document.body;
			const inside =
				onBody || (element !== null && rootRef.current?.contains(element));
			if (!inside || element?.closest("[data-passport-thread]")) {
				return;
			}
			const onPages =
				onBody ||
				(element?.closest("[data-passport-booklet], [data-passport-pages]") ??
					null) !== null;
			const paging: Record<string, () => void> = {
				End: () => goToSpread(spreads.length - 1),
				Home: () => goToSpread(0),
				PageDown: next,
				PageUp: previous,
			};
			const arrows: Record<string, () => void> = {
				ArrowLeft: previous,
				ArrowRight: next,
			};
			const action =
				paging[event.key] ?? (onPages ? arrows[event.key] : undefined);
			if (action) {
				event.preventDefault();
				action();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [goToSpread, next, previous, spreads.length, turnable]);
}
