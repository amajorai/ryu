// apps/desktop/src/hooks/useAfterDragStart.ts
//
// A drag flag that turns on one animation frame after the drag starts and off
// at once when it ends. Chromium cancels a native HTML5 drag whose layout
// shifts inside its `dragstart` task, and React flushes a discrete event's
// render (and its passive effects) synchronously inside that task. Feedback
// that inserts rows while dragging, such as the "Drop a project, chat, or
// section here" hint in empty sidebar sections, must therefore read this
// flag instead of the raw dragging state.

import { useEffect, useState } from "react";

export function useAfterDragStart(dragging: boolean): boolean {
	const [started, setStarted] = useState(false);
	useEffect(() => {
		if (!dragging) {
			setStarted(false);
			return;
		}
		const frame = requestAnimationFrame(() => setStarted(true));
		return () => cancelAnimationFrame(frame);
	}, [dragging]);
	return dragging && started;
}
