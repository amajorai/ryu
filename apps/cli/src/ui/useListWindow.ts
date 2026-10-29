// Measured row windowing for keyboard-driven lists.
//
// TUI lists keep their selection in view by slicing rows around the selected
// index, not by using a focus-capturing <scrollbox> (OpenTUI's scrollbox claims
// the arrow keys, which would fight the shell's keyboard ownership model). The
// old windows used a fixed row count (16, 14, ...). On a short terminal that
// count overflowed the space the layout really had, so flex-shrunk rows were
// drawn on top of each other and subtitles overwrote titles.
//
// This hook sizes the window from the container's MEASURED height instead. The
// list container is a `<box flexBasis={0} flexGrow={1} minHeight={0}
// overflow="hidden">` that passes `onSizeChange` from here. The zero flex basis
// matters: without it the container's basis is its own rows, so once a too-tall
// window is drawn the layout shrinks the surrounding chrome (headers, hints)
// instead of the list, the measurement echoes the rows back, and the window
// never corrects itself. Before the first layout pass, the hook uses
// the terminal height minus `reserved` lines of surrounding chrome, so the
// first frame is never empty.

import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useState } from "react";

/** Lines of shell chrome (header, tab bar, hints, status) assumed around a list
 *  before its container has been measured. */
const DEFAULT_RESERVED_LINES = 8;

export interface ListWindowOptions {
	/** Total number of rows in the list. */
	count: number;
	/** Lines below the rows inside the measured container (e.g. an inline footer). */
	footerLines?: number;
	/** Currently selected row; the window is centred on it. */
	index: number;
	/** Terminal lines each row occupies (2 when rows carry a subtitle line). */
	linesPerRow: number;
	/** Optional hard cap on visible rows, whatever the measured space. */
	maxRows?: number;
	/** Chrome lines subtracted from the terminal height before first layout. */
	reserved?: number;
}

export interface ListWindow {
	/** One past the last visible row (exclusive). */
	end: number;
	/** Pass to the clipped list container's `onSizeChange`. */
	onSizeChange: (this: BoxRenderable) => void;
	/** Number of rows that fit, before clamping to `count`. */
	rowsFit: number;
	/** First visible row (inclusive). */
	start: number;
}

/** How many rows of `linesPerRow` fit in `height` lines after `footerLines`,
 *  at least one and at most `maxRows` when that cap is given. */
export function rowsThatFit(
	height: number,
	linesPerRow: number,
	footerLines = 0,
	maxRows?: number
): number {
	const perRow = Math.max(1, Math.floor(linesPerRow));
	const fit = Math.max(1, Math.floor((height - footerLines) / perRow));
	return maxRows === undefined ? fit : Math.max(1, Math.min(fit, maxRows));
}

/** The first visible row of a `size`-row window centred on `index` and clamped
 *  to the list bounds. */
export function windowStart(
	index: number,
	count: number,
	size: number
): number {
	return Math.max(
		0,
		Math.min(index - Math.floor(size / 2), Math.max(0, count - size))
	);
}

export function useListWindow({
	count,
	footerLines = 0,
	index,
	linesPerRow,
	maxRows,
	reserved = DEFAULT_RESERVED_LINES,
}: ListWindowOptions): ListWindow {
	const { height: terminalHeight } = useTerminalDimensions();
	const [measured, setMeasured] = useState<number | null>(null);

	const onSizeChange = useCallback(function onListSizeChange(
		this: BoxRenderable
	) {
		const next = this.height;
		setMeasured((prev) => (prev === next ? prev : next));
	}, []);

	const height = measured ?? Math.max(1, terminalHeight - reserved);
	const rowsFit = rowsThatFit(height, linesPerRow, footerLines, maxRows);
	const start = windowStart(index, count, rowsFit);
	return {
		start,
		end: Math.min(count, start + rowsFit),
		rowsFit,
		onSizeChange,
	};
}
