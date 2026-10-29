// apps/desktop/src/hooks/useCompactRail.ts
//
// Whether the shell draws the compact agent rail in place of collapsed
// navigation, plus the one side effect that makes narrow windows feel like a
// messaging app: crossing below the compact breakpoint folds a docked sidebar
// into the rail, and widening again restores it — but only when the fold was
// ours, so a sidebar the user closed on purpose stays closed.

import { useSidebar } from "@ryu/ui/components/sidebar.tsx";
import { useIsCompact } from "@ryu/ui/hooks/use-mobile.ts";
import { useEffect, useRef } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import {
	COMPACT_RAIL_PREFERENCE_KEY,
	isCompactRailActive,
} from "@/src/lib/compact-rail.ts";
import { isDetachedTabWindow } from "@/src/lib/tab-transfer.ts";

/** `[enabled, setEnabled]` for the user's compact-rail preference (default on). */
export function useCompactRailPreference(): [boolean, (v: boolean) => void] {
	return usePersistedToggle(COMPACT_RAIL_PREFERENCE_KEY, true);
}

/**
 * `true` while the rail should replace the collapsed navigation.
 *
 * `navigationShown` is the shell's own answer to "is the full navigation
 * visible" (docked sidebar, mobile Sheet, or navigation moved into a pane), so
 * the rail and the full sidebar never show at once.
 */
export function useCompactRail(navigationShown: boolean): boolean {
	const [enabled] = useCompactRailPreference();
	const narrow = useIsCompact();
	const { surface } = useAppSurface();
	// A detached tab window shows one tab and the extension side panel is its own
	// quick-capture surface; neither has a roster to switch between.
	const excluded = surface === "extension" || isDetachedTabWindow();
	const { open, setOpen } = useSidebar();
	const allowed = enabled && !excluded;

	const previousNarrow = useRef<boolean | null>(null);
	const foldedForWidth = useRef(false);
	useEffect(() => {
		const wasNarrow = previousNarrow.current;
		previousNarrow.current = narrow;
		// React to width transitions (and the first render) only. An `open`
		// change while the width holds is the user's own choice, and once they
		// reopen the sidebar its later state is theirs to keep, not ours to restore.
		if (wasNarrow === narrow) {
			if (open) {
				foldedForWidth.current = false;
			}
			return;
		}
		if (!allowed) {
			return;
		}
		if (narrow) {
			if (open) {
				foldedForWidth.current = true;
				setOpen(false);
			}
		} else if (foldedForWidth.current) {
			foldedForWidth.current = false;
			setOpen(true);
		}
	}, [allowed, narrow, open, setOpen]);

	return isCompactRailActive({
		enabled,
		excluded,
		narrow,
		navigationShown,
	});
}
