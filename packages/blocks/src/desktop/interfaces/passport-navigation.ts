import { useCallback, useMemo, useState } from "react";
import { type PassportSpread, spreadOfPage } from "./passport-model.ts";

/** A turn in progress, in spread indices of the current layout. */
export interface SpreadTurn {
	from: number;
	to: number;
}

/** The last page any spread shows (0 with none). */
function lastPageOf(spreads: readonly PassportSpread[]): number {
	const last = spreads.at(-1);
	return last?.right ?? last?.left ?? 0;
}

/** The page a spread opens on: its left page, or the right one alone. */
export function spreadPage(
	spreads: readonly PassportSpread[],
	index: number
): number {
	const spread = spreads[Math.max(0, Math.min(spreads.length - 1, index))];
	return spread?.left ?? spread?.right ?? 0;
}

/** A short signature of a layout, to tell when the spreads change shape. */
function layoutKey(spreads: readonly PassportSpread[]): string {
	return spreads
		.map((item) => `${item.left ?? "-"}/${item.right ?? "-"}`)
		.join(",");
}

export interface PassportNavigation {
	/** Finish the page-turn animation. */
	finishTurn: () => void;
	/** Open the spread that holds `page`. */
	goToPage: (page: number) => void;
	/** Open spread `index` of the current layout. */
	goToSpread: (index: number) => void;
	next: () => void;
	/** The open page: the source of truth across layout changes. */
	page: number;
	previous: () => void;
	/** The spread being shown (or turned to), in the current layout. */
	spread: number;
	/** The leaf turning, or null. */
	turn: SpreadTurn | null;
}

/**
 * Which page the booklet is open on, and the turn between pages. The open
 * PAGE is stored, never a spread index, so switching between two-page spreads
 * and single pages keeps the same page in view. A turn remembers the page it
 * started from; both ends map onto whatever spreads are current.
 */
export function usePassportNavigation({
	animate,
	initialPage,
	spreads,
}: {
	/** False with reduced motion or single pages: views swap without a leaf. */
	animate: boolean;
	initialPage: number;
	spreads: readonly PassportSpread[];
}): PassportNavigation {
	const [storedPage, setPage] = useState(initialPage);
	// The page a turn started from, and the layout it started in. A turn only
	// plays in that layout: if the spreads change mid-turn (the first
	// measurement, a resize into single pages), it lands at once instead of
	// replaying between pages of the new layout.
	const [turnFrom, setTurnFrom] = useState<{
		layout: string;
		page: number;
	} | null>(null);

	const layout = useMemo(() => layoutKey(spreads), [spreads]);
	// A turn that can no longer play (single pages, or another layout) is
	// dropped, not kept: it would replay as a phantom turn once the layout
	// comes back (the booklet sheet closing over the desk).
	if (turnFrom !== null && (!animate || turnFrom.layout !== layout)) {
		setTurnFrom(null);
	}
	// Pages can disappear under the open one (a record is deleted): stay on the
	// last page rather than snapping shut to the cover.
	const lastPage = lastPageOf(spreads);
	const page = Math.min(storedPage, lastPage);
	const spread = spreadOfPage(spreads, page);
	const turn = useMemo(() => {
		if (!animate || turnFrom === null || turnFrom.layout !== layout) {
			return null;
		}
		const from = spreadOfPage(spreads, Math.min(turnFrom.page, lastPage));
		return from === spread ? null : { from, to: spread };
	}, [animate, lastPage, layout, spread, spreads, turnFrom]);

	const goToPage = useCallback(
		(target: number) => {
			const clamped = Math.max(0, Math.min(lastPage, target));
			if (spreadOfPage(spreads, clamped) === spread) {
				setPage(clamped);
				return;
			}
			// A second turn while one is in flight lands at once.
			setTurnFrom(animate && turn === null ? { layout, page } : null);
			setPage(clamped);
		},
		[animate, lastPage, layout, page, spread, spreads, turn]
	);
	const goToSpread = useCallback(
		(index: number) => {
			const clamped = Math.max(0, Math.min(spreads.length - 1, index));
			if (clamped !== spread) {
				goToPage(spreadPage(spreads, clamped));
			}
		},
		[goToPage, spread, spreads]
	);
	const next = useCallback(() => goToSpread(spread + 1), [goToSpread, spread]);
	const previous = useCallback(
		() => goToSpread(spread - 1),
		[goToSpread, spread]
	);
	const finishTurn = useCallback(() => setTurnFrom(null), []);

	return {
		finishTurn,
		goToPage,
		goToSpread,
		next,
		page,
		previous,
		spread,
		turn,
	};
}
