import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/**
 * The Warehouse renderer's small hooks and key rule: the stage's measured
 * size, the floor clock, and when Escape belongs to the panel. Split out of
 * `warehouse-interface.tsx`.
 */

/** Stages move with time (packing, then shipped), so the clock ticks. */
const CLOCK_MS = 30_000;

/** Escape inside a text field belongs to the field unless the field is empty. */
export function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	if (target.closest("[data-testid='warehouse-thread']")) {
		return false;
	}
	const field = target.closest("input:not([type='radio']), textarea, select");
	if (target.isContentEditable) {
		return false;
	}
	if (
		field instanceof HTMLTextAreaElement ||
		field instanceof HTMLInputElement
	) {
		return field.value.trim() === "";
	}
	return field === null;
}

/** The element's size, kept current; zero until measured. */
export function useElementSize(ref: RefObject<HTMLElement | null>) {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () =>
			setSize((current) =>
				current.width === element.clientWidth &&
				current.height === element.clientHeight
					? current
					: { height: element.clientHeight, width: element.clientWidth }
			);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/** Where focus returns after Create order closes. */
export const CREATE_TARGET = "create";

/**
 * A view change asked for by the keyboard moves focus with it: into the
 * panel heading when a panel opens, and back to whatever opened it (the
 * order's row, or Create order) when the panel closes again.
 */
export function useViewFocus({
	headingRef,
	moveFocus,
	returnTo,
	rootRef,
	viewKey,
}: {
	headingRef: RefObject<HTMLHeadingElement | null>;
	moveFocus: RefObject<boolean>;
	returnTo: RefObject<string | null>;
	rootRef: RefObject<HTMLDivElement | null>;
	viewKey: string;
}) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable; it runs when the view changes.
	useLayoutEffect(() => {
		if (!moveFocus.current) {
			return;
		}
		moveFocus.current = false;
		if (!viewKey.startsWith("list")) {
			headingRef.current?.focus();
			return;
		}
		const root = rootRef.current;
		const target = returnTo.current;
		const row =
			target && target !== CREATE_TARGET
				? root?.querySelector<HTMLElement>(
						`[data-order-row="${CSS.escape(target)}"]`
					)
				: null;
		(
			row ??
			// The HUD's one primary action; its aria-label is translated copy.
			root?.querySelector<HTMLElement>("button.gk-action")
		)?.focus();
	}, [viewKey]);
}

export function useClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}
