import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { type RefObject, useEffect, useLayoutEffect, useMemo } from "react";
import { escapeIsFree } from "./rides-interface-parts.ts";
import { etaLabel } from "./rides-model.ts";
import type { RidesActEta } from "./rides-parts.tsx";
import type { ActsView } from "./use-acts.ts";

/**
 * A routine's run is the only trip with an ETA: what is left of its
 * estimate. A chat's typical length is not one.
 */
export function useRidesActEtas(
	acts: ActsView["acts"],
	threads: InterfaceSnapshot["threads"]
): Map<string, RidesActEta> {
	return useMemo(() => {
		const out = new Map<string, RidesActEta>();
		for (const act of acts.values()) {
			const progress = act.progress;
			const thread = threads.find((item) => item.id === act.threadId);
			if (
				progress?.kind === "estimate" &&
				thread?.routineRun &&
				progress.total > 0
			) {
				const left = Math.max(0, progress.total - progress.done) / 60_000;
				out.set(thread.id, {
					label: etaLabel(Math.round(left)),
					share: Math.min(1, progress.done / progress.total),
				});
			}
		}
		return out;
	}, [acts, threads]);
}

/** Land keyboard users on the trip they opened, and back on its row after. */
export function useTripFocus({
	closeTrip,
	focusHeading,
	headingRef,
	returnFocusTo,
	rootRef,
	threadOpen,
}: {
	closeTrip: () => void;
	focusHeading: RefObject<boolean>;
	headingRef: RefObject<HTMLHeadingElement | null>;
	returnFocusTo: RefObject<string | null>;
	rootRef: RefObject<HTMLDivElement | null>;
	threadOpen: boolean;
}): void {
	useLayoutEffect(() => {
		if (threadOpen && focusHeading.current) {
			focusHeading.current = false;
			headingRef.current?.focus();
			return;
		}
		if (!threadOpen && returnFocusTo.current) {
			const tripId = returnFocusTo.current;
			returnFocusTo.current = null;
			// The same trip can be listed twice (the phone's peek row and the
			// full list); return to the copy that is on screen.
			const rows = rootRef.current?.querySelectorAll<HTMLButtonElement>(
				`[data-trip-id="${CSS.escape(tripId)}"]`
			);
			const row = [...(rows ?? [])].find(
				(candidate) => candidate.getClientRects().length > 0
			);
			(row ?? rows?.[0])?.focus({ preventScroll: false });
		}
	}, [headingRef, returnFocusTo, rootRef, focusHeading, threadOpen]);

	useEffect(() => {
		const root = rootRef.current;
		if (!(root && threadOpen)) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && escapeIsFree(event.target)) {
				event.preventDefault();
				closeTrip();
			}
		};
		root.addEventListener("keydown", onKeyDown);
		return () => root.removeEventListener("keydown", onKeyDown);
	}, [closeTrip, rootRef, threadOpen]);
}
