import { useCallback, useEffect, useRef } from "react";
import type { IslandMaterialContour } from "../../shared/ipc.ts";

function visibleMaterialContours(): IslandMaterialContour[] {
	const contours: IslandMaterialContour[] = [];
	for (const element of document.querySelectorAll<HTMLElement>(
		"[data-island-material-shape]"
	)) {
		const style = getComputedStyle(element);
		if (Number.parseFloat(style.opacity) <= 0.05) {
			continue;
		}
		const rect = element.getBoundingClientRect();
		const x = Math.max(0, Math.round(rect.left));
		const y = Math.max(0, Math.round(rect.top));
		const width = Math.min(window.innerWidth, Math.round(rect.right)) - x;
		const height = Math.min(window.innerHeight, Math.round(rect.bottom)) - y;
		if (width < 1 || height < 1) {
			continue;
		}
		const parsedRadius = Number.parseFloat(style.borderTopLeftRadius);
		contours.push({
			x,
			y,
			width,
			height,
			radius: Number.isFinite(parsedRadius)
				? parsedRadius
				: Math.min(width, height) / 2,
		});
	}
	return contours;
}

/** Follow the visible Motion contours while a native-material Island morphs. */
export function useIslandMaterialMask(material: boolean): () => void {
	const frame = useRef<number | null>(null);
	// One send per animation frame, coalesced but never dropped: a throttle that
	// skipped the last frame left the native glass parked at a mid-morph shape
	// behind the settled web surface (a visible second layer).
	const schedule = useCallback(() => {
		if (!material || frame.current !== null) {
			return;
		}
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			const contours = visibleMaterialContours();
			if (contours.length > 0) {
				window.island.win.setMaterialShapes(contours);
			}
		});
	}, [material]);

	useEffect(() => {
		if (!material) {
			return;
		}
		window.addEventListener("resize", schedule);
		return () => window.removeEventListener("resize", schedule);
	}, [material, schedule]);
	useEffect(
		() => () => {
			if (frame.current !== null) {
				cancelAnimationFrame(frame.current);
				// Clear the handle too: a cancelled-but-set frame (StrictMode's
				// simulated remount) would block every later schedule, leaving the
				// glass on the final target shape while the web contours morph.
				frame.current = null;
			}
		},
		[]
	);
	return schedule;
}
