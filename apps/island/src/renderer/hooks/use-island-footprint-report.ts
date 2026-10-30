import { useEffect } from "react";
import { islandMaterialContours } from "../components/island-config.ts";
import type { IslandState } from "../store/island-state.ts";
import type { useIslandAppearance } from "./use-island-appearance.ts";
import type { useNotch } from "./use-notch.ts";

export interface IslandFootprintReport {
	background: ReturnType<typeof useIslandAppearance>;
	detailHeight: number;
	detailRadius: number;
	detailWidth: number;
	footprintHeight: number;
	footprintWidth: number;
	isExpanded: boolean;
	material: boolean;
	notch: ReturnType<typeof useNotch>;
	scheduleMaterialMask: () => void;
	showCircle: boolean;
	state: IslandState;
}

/**
 * Reports the Island's visible footprint (and its material contours) to the
 * main process, which sizes, masks and keeps the window on-screen from it.
 */
export function useIslandFootprintReport({
	background,
	detailHeight,
	detailRadius,
	detailWidth,
	footprintHeight,
	footprintWidth,
	isExpanded,
	material,
	notch,
	scheduleMaterialMask,
	showCircle,
	state,
}: IslandFootprintReport): void {
	useEffect(() => {
		// Report nothing until both window facts are known: an early report would
		// size or mask the window for the wrong Background.
		if (notch === undefined || background === null) {
			return;
		}
		if (footprintWidth > 0 && footprintHeight > 0) {
			const detailContour =
				detailWidth > 0 && detailHeight > 0
					? {
							width: detailWidth,
							height: detailHeight,
							radius: detailRadius,
						}
					: null;
			window.island.win.setContentSize(
				footprintWidth,
				footprintHeight,
				isExpanded,
				notch ? [] : islandMaterialContours(showCircle, detailContour, state)
			);
			if (material) {
				scheduleMaterialMask();
			}
		}
	}, [
		notch,
		background,
		footprintWidth,
		footprintHeight,
		isExpanded,
		showCircle,
		detailWidth,
		detailHeight,
		detailRadius,
		state,
		material,
		scheduleMaterialMask,
	]);
}
