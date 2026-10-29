import { useEffect, useState } from "react";

/**
 * The current time, re-read on each `intervalMs` boundary (so a one-second
 * clock flips with the system clock rather than drifting from mount time).
 */
export function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			const current = Date.now();
			timer = setTimeout(
				() => {
					setNow(Date.now());
					schedule();
				},
				intervalMs - (current % intervalMs)
			);
		};
		setNow(Date.now());
		schedule();
		return () => clearTimeout(timer);
	}, [intervalMs]);
	return now;
}

/** Height reserved under a clipped list for its "more" row. */
export const MORE_ROW_PX = 28;

export interface WholeRows {
	/** Snapped list height in pixels, or null when everything fits. */
	height: number | null;
	/** Item rows wholly or partly below the visible area. */
	hiddenBelow: number;
}

/**
 * Sizes a scroll list to whole rows. The frame is the space the panel gives
 * the list; when the content outgrows it, the list stops at the last row edge
 * that fits above a "more" row, so no row is ever cut mid-glyph. Rows are the
 * list's descendants marked `data-row` (`header` or `item`); only items count
 * toward `hiddenBelow`. `contentKey` changes when the rows do, so the
 * measurement follows. Returns callback refs for the frame and the list.
 */
export function useWholeRows(
	contentKey: string
): [
	(node: HTMLElement | null) => void,
	(node: HTMLElement | null) => void,
	WholeRows,
] {
	const [frame, setFrame] = useState<HTMLElement | null>(null);
	const [list, setList] = useState<HTMLElement | null>(null);
	const [rows, setRows] = useState<WholeRows>({
		height: null,
		hiddenBelow: 0,
	});
	useEffect(() => {
		if (!(frame && list)) {
			return;
		}
		const measure = () => {
			const room = frame.clientHeight;
			const content = list.scrollHeight;
			const marks = list.querySelectorAll<HTMLElement>("[data-row]");
			let height: number | null = null;
			if (room > 0 && content > room + 1) {
				const limit = room - MORE_ROW_PX;
				let edge = 0;
				for (const mark of marks) {
					const bottom = mark.offsetTop + mark.offsetHeight;
					if (bottom <= limit && bottom > edge) {
						edge = bottom;
					}
				}
				height = Math.max(edge, MORE_ROW_PX);
			}
			const visibleTo = list.scrollTop + (height ?? content);
			let hiddenBelow = 0;
			for (const mark of marks) {
				if (
					mark.dataset.row === "item" &&
					mark.offsetTop + mark.offsetHeight > visibleTo + 1
				) {
					hiddenBelow += 1;
				}
			}
			setRows((current) =>
				current.height === height && current.hiddenBelow === hiddenBelow
					? current
					: { height, hiddenBelow }
			);
		};
		measure();
		list.addEventListener("scroll", measure, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(frame);
		for (const child of list.children) {
			observer?.observe(child);
		}
		return () => {
			list.removeEventListener("scroll", measure);
			observer?.disconnect();
		};
	}, [frame, list, contentKey]);
	return [setFrame, setList, rows];
}
