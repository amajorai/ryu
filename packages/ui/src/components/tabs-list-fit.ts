import type { HorizontalOverflowState } from "@ryu/ui/components/edge-scroller.tsx";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
} from "react";
import {
	measureTabLayoutSize,
	resolveVisibleTabKeys,
	sameKeys,
	type TabItem,
} from "./tabs-layout.ts";
import { type TabsValue, useSafeLayoutEffect } from "./tabs-root.tsx";

interface TabsScrollRevealOptions {
	activeValue: TabsValue | undefined;
	isScrollable: boolean;
	itemKeysSignature: string;
	listRef: RefObject<HTMLDivElement | null>;
	overflowState: HorizontalOverflowState;
}

/** Keeps the selected tab of a scrollable row in view. */
function useTabsScrollReveal({
	activeValue,
	isScrollable,
	itemKeysSignature,
	listRef,
	overflowState,
}: TabsScrollRevealOptions) {
	const revealTab = useCallback(
		(tab: HTMLElement | null) => {
			const list = listRef.current;
			if (!(isScrollable && list && tab)) {
				return;
			}
			const listBounds = list.getBoundingClientRect();
			const tabBounds = tab.getBoundingClientRect();
			const max = Math.max(0, list.scrollWidth - list.clientWidth);
			const rtl = getComputedStyle(list).direction === "rtl";
			const fromLeft = Math.max(
				0,
				Math.min(max, rtl ? max + list.scrollLeft : list.scrollLeft)
			);
			const left = listBounds.left + (fromLeft > 1 ? 36 : 0);
			const right = listBounds.right - (fromLeft < max - 1 ? 36 : 0);
			const delta =
				tabBounds.left < left
					? tabBounds.left - left
					: tabBounds.right > right
						? tabBounds.right - right
						: 0;
			if (delta === 0) {
				return;
			}
			const reduceMotion =
				globalThis.window !== undefined &&
				window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
			list.scrollBy({
				left: delta,
				behavior: reduceMotion ? "auto" : "smooth",
			});
		},
		[isScrollable]
	);
	useSafeLayoutEffect(() => {
		if (!isScrollable) {
			return;
		}
		overflowState.measure();
		revealTab(
			listRef.current?.querySelector<HTMLElement>(
				'[role="tab"][aria-selected="true"]'
			) ?? null
		);
	}, [
		activeValue,
		isScrollable,
		itemKeysSignature,
		overflowState.measure,
		revealTab,
	]);
	return revealTab;
}

interface TabsListFitOptions {
	activeKey: string | null;
	displayedKeys: string[];
	fullRowMeasureSignatureRef: RefObject<string | null>;
	hiddenKeys: Set<string>;
	itemKeysSignature: string;
	items: TabItem[];
	listRef: RefObject<HTMLDivElement | null>;
	measureVersion: number;
	normalizedOrder: string[];
	orientation: "horizontal" | "vertical";
	setMeasureVersion: Dispatch<SetStateAction<number>>;
	setPromotedKey: Dispatch<SetStateAction<string | null>>;
	setVisibleKeys: Dispatch<SetStateAction<string[] | null>>;
	showMoreMenu: boolean;
	widthsRef: RefObject<Map<string, number>>;
}

/** Measures the managed triggers and fits as many as the row holds. */
function useTabsListFit({
	activeKey,
	displayedKeys,
	fullRowMeasureSignatureRef,
	hiddenKeys,
	itemKeysSignature,
	items,
	listRef,
	measureVersion,
	normalizedOrder,
	orientation,
	setMeasureVersion,
	setPromotedKey,
	setVisibleKeys,
	showMoreMenu,
	widthsRef,
}: TabsListFitOptions) {
	useSafeLayoutEffect(() => {
		const list = listRef.current;
		if (!list || items.length === 0) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			for (const trigger of list.querySelectorAll<HTMLElement>(
				"[data-tabs-managed-trigger]"
			)) {
				const key = trigger.getAttribute("data-tabs-managed-key");
				if (!key) {
					continue;
				}
				widthsRef.current.set(
					key,
					measureTabLayoutSize(trigger, orientation === "vertical")
				);
			}
			// A tab that was not rendered in this frame and has never been measured
			// (one added after mount, e.g. README/API arriving with a detail payload,
			// measured by a frame scheduled before the item-change reset rendered it) has
			// no width to fit with. Fitting it on a guess can overflow it into the
			// More menu, where it is never rendered and so never re-measured. Render
			// the full row for one frame instead; that frame measures every tab.
			// Once per tab set, so a trigger that never reaches the DOM falls back
			// to the guess instead of re-rendering every frame.
			if (
				fullRowMeasureSignatureRef.current !== itemKeysSignature &&
				normalizedOrder.some(
					(key) => !(hiddenKeys.has(key) || widthsRef.current.has(key))
				)
			) {
				fullRowMeasureSignatureRef.current = itemKeysSignature;
				setVisibleKeys(null);
				setPromotedKey(null);
				setMeasureVersion((version) => version + 1);
				return;
			}
			const nextResolution = resolveVisibleTabKeys(list, {
				activeKey,
				hiddenKeys,
				orientation,
				order: normalizedOrder,
				reserveMore: showMoreMenu,
				widths: widthsRef.current,
			});
			setVisibleKeys((current) =>
				sameKeys(current, nextResolution.keys) ? current : nextResolution.keys
			);
			setPromotedKey((current) =>
				current === nextResolution.promotedKey
					? current
					: nextResolution.promotedKey
			);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [
		activeKey,
		hiddenKeys,
		items.length,
		itemKeysSignature,
		measureVersion,
		normalizedOrder,
		orientation,
		showMoreMenu,
	]);

	useEffect(() => {
		const list = listRef.current;
		if (!list || globalThis.ResizeObserver === undefined) {
			return;
		}
		const observer = new ResizeObserver(() => {
			setMeasureVersion((version) => version + 1);
		});
		observer.observe(list);
		for (const trigger of list.querySelectorAll<HTMLElement>(
			"[data-tabs-managed-trigger]"
		)) {
			observer.observe(trigger);
		}
		const moreTrigger = list.querySelector<HTMLElement>(
			"[data-tabs-more-trigger]"
		);
		if (moreTrigger) {
			observer.observe(moreTrigger);
		}
		return () => observer.disconnect();
	}, [displayedKeys, items.length]);
}

export { useTabsListFit, useTabsScrollReveal };
