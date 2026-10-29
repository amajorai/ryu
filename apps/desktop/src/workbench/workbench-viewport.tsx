import type { WorkbenchRegion } from "@ryu/workbench/model";
import { createContext, useContext, useEffect } from "react";

/** The narrowest Center that stays usable beside docked side regions. */
export const CENTER_MIN_WIDTH = 400;

export type SurroundingRegion = Exclude<WorkbenchRegion, "center">;

/**
 * Whether docking the visible side regions would squeeze Center below a usable
 * width. Computed from the saved sizes, not from what is currently docked, so
 * switching to overlays cannot flip the answer back (no oscillation).
 */
export function isNarrowWorkbench(
	width: number,
	dockedSideWidth: number
): boolean {
	return width > 0 && width - dockedSideWidth < CENTER_MIN_WIDTH;
}

/**
 * In a narrow window Left, Right, and Bottom become one-at-a-time overlay
 * sheets over Center. The saved layout (open regions, sizes, split tree) is
 * never rewritten for this; widening the window restores the docked layout.
 */
export interface WorkbenchViewport {
	/** Return focus to Center, which closes the overlay. */
	dismissOverlay: () => void;
	narrow: boolean;
	/** The surrounding region shown as an overlay, if any. */
	overlayRegion: SurroundingRegion | null;
	/** Show a region's overlay by focusing its active tab. */
	showOverlay: (region: SurroundingRegion) => void;
}

const DOCKED_VIEWPORT: WorkbenchViewport = {
	dismissOverlay: () => undefined,
	narrow: false,
	overlayRegion: null,
	showOverlay: () => undefined,
};

const WorkbenchViewportContext =
	createContext<WorkbenchViewport>(DOCKED_VIEWPORT);

export const WorkbenchViewportProvider = WorkbenchViewportContext.Provider;

export function useWorkbenchViewport(): WorkbenchViewport {
	return useContext(WorkbenchViewportContext);
}

// The dock bridge (the Toggle Right/Bottom Panel shortcuts and the palette's
// Layout actions) is built above the layout that provides the viewport, so the
// mounted layout publishes its viewport here as well.
let liveViewport: WorkbenchViewport = DOCKED_VIEWPORT;

/** The mounted workbench layout's viewport, or the docked default. */
export function currentWorkbenchViewport(): WorkbenchViewport {
	return liveViewport;
}

/** Publish `viewport` as the current one while the calling layout is mounted. */
export function usePublishWorkbenchViewport(viewport: WorkbenchViewport): void {
	useEffect(() => {
		liveViewport = viewport;
		return () => {
			if (liveViewport === viewport) {
				liveViewport = DOCKED_VIEWPORT;
			}
		};
	});
}
