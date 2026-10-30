import { type RefObject, useEffect, useState } from "react";
import { flushSync } from "react-dom";

/** The stage's measured size, or null before the first measurement. */
export function useStageSize(stageRef: RefObject<HTMLElement | null>): {
	height: number;
	width: number;
} | null {
	const [stageSize, setStageSize] = useState<{
		height: number;
		width: number;
	} | null>(null);

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage || typeof ResizeObserver === "undefined") {
			return;
		}
		// Committed before the browser paints, so the HUD and the diorama
		// refit in the same frame the stage changes size (a panel opening).
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				flushSync(() => {
					setStageSize({
						height: entry.contentRect.height,
						width: entry.contentRect.width,
					});
				});
			}
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, [stageRef]);
	return stageSize;
}
