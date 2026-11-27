// apps/desktop/src/components/usage-rail/usage-rail-layout.ts
//
// How much room the two side strips give the usage rings, measured from the
// strip itself with a ResizeObserver (never from the window size alone), and
// the one hook both strips read their rings from. The rules the numbers go
// through are the pure functions of `lib/usage-rail/usage-rail-fit.ts`.

import {
	type RefObject,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type UsageBarMode,
	useUsageBarPrefs,
} from "@/src/hooks/useUsageBarPrefs.ts";
import { useUsageRailSources } from "@/src/hooks/useUsageRailSources.ts";
import {
	MAX_RING_PLACES,
	railFreeHeight,
	ringPlaces,
	sidebarUsagePlacement,
} from "@/src/lib/usage-rail/usage-rail-fit.ts";
import type { UsageRailSource } from "@/src/lib/usage-rail/usage-rail-sources.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

/** One ring of the narrow rail and the gap after it (`size-10`, `gap-1`). */
export const RAIL_RING_SLOT = 44;
/** The agents of the narrow rail keep room for three avatars; the rest scroll. */
export const RAIL_MIN_ROSTER_HEIGHT = 132;
/** One ring of the sidebar row and the gap after it (`size-9`, `gap-1`). */
export const SIDEBAR_RING_SLOT = 40;
/** The height of the sidebar row (`h-11`). */
export const SIDEBAR_RING_ROW_HEIGHT = 44;
/** The inline padding of the sidebar row, both sides (`px-2`). */
const SIDEBAR_ROW_PADDING = 16;

export interface UsageRail {
	/** Whether the numbers read as what is left or as what is used. */
	mode: UsageBarMode;
	/** Opens the Usage page. */
	openUsage: () => void;
	sources: UsageRailSource[];
}

/** The rings of the active node, the reading mode and the click action. */
export function useUsageRail(): UsageRail {
	const sources = useUsageRailSources();
	const { mode } = useUsageBarPrefs();
	const openSettings = useSettingsDialog((state) => state.openSettings);
	const openUsage = useCallback(() => openSettings("usage"), [openSettings]);
	return { mode, openUsage, sources };
}

/** Runs `measure` now and after every size change of `element`, once a frame. */
function observeSize(element: Element, measure: () => void): () => void {
	measure();
	if (typeof ResizeObserver === "undefined") {
		return () => undefined;
	}
	let frame = 0;
	// The measure waits for the next frame: a new ring count changes the size
	// this observer watches, and the change must not come back in the same loop.
	const observer = new ResizeObserver(() => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(measure);
	});
	observer.observe(element);
	return () => {
		observer.disconnect();
		cancelAnimationFrame(frame);
	};
}

/**
 * The ring places of the narrow rail: what its list of agents can give up
 * without going under three avatars.
 */
export function useRailRingPlaces(
	rosterRef: RefObject<HTMLElement | null>,
	ringCount: number
): number {
	const [places, setPlaces] = useState(MAX_RING_PLACES);
	const placesRef = useRef(places);
	useLayoutEffect(() => {
		const roster = rosterRef.current;
		if (!roster || ringCount === 0) {
			return;
		}
		return observeSize(roster, () => {
			const next = ringPlaces(
				railFreeHeight({
					minRoster: RAIL_MIN_ROSTER_HEIGHT,
					renderedPlaces: Math.min(ringCount, placesRef.current),
					rosterHeight: roster.clientHeight,
					slot: RAIL_RING_SLOT,
				}),
				RAIL_RING_SLOT
			);
			placesRef.current = next;
			setPlaces(next);
		});
	}, [ringCount, rosterRef]);
	return places;
}

/** The ring places of the sidebar row, from the row's own width. */
export function useRowRingPlaces(
	rowRef: RefObject<HTMLElement | null>,
	shown: boolean
): number {
	const [places, setPlaces] = useState(MAX_RING_PLACES);
	useLayoutEffect(() => {
		const row = rowRef.current;
		if (!(row && shown)) {
			return;
		}
		return observeSize(row, () => {
			setPlaces(
				ringPlaces(row.clientWidth - SIDEBAR_ROW_PADDING, SIDEBAR_RING_SLOT)
			);
		});
	}, [rowRef, shown]);
	return places;
}

/**
 * Where the full sidebar shows its rings: as a row above the account footer,
 * or as one ring beside the account button when the row would squeeze the
 * chat list.
 */
export function useSidebarUsagePlacement(
	listRef: RefObject<HTMLElement | null>,
	hasRings: boolean
): "footer" | "row" {
	const [placement, setPlacement] = useState<"footer" | "row">("row");
	const placementRef = useRef(placement);
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!(list && hasRings)) {
			return;
		}
		return observeSize(list, () => {
			const next = sidebarUsagePlacement({
				listHeight: list.clientHeight,
				rowHeight: SIDEBAR_RING_ROW_HEIGHT,
				rowShown: placementRef.current === "row",
			});
			placementRef.current = next;
			setPlacement(next);
		});
	}, [hasRings, listRef]);
	return placement;
}
