// In-process holder for the current island edge offset (the gap from a docked
// screen edge). The positioning code (`window.ts` cold-start, `position.ts`
// re-home, `ipc/win.ts` snap) reads this getter live so a settings change takes
// effect without re-registering IPC or recreating the window. `index.ts` seeds
// it from Core before the first window is built and updates it on each SSE change.

import { DEFAULT_EDGE_OFFSET } from "../shared/edge-offset.ts";

let currentOffset = DEFAULT_EDGE_OFFSET;

/** The current gap from a docked screen edge, in pixels. */
export function getEdgeOffset(): number {
	return currentOffset;
}

/** Set the current edge offset (callers pass an already-clamped value). */
export function setEdgeOffset(value: number): void {
	currentOffset = value;
}
