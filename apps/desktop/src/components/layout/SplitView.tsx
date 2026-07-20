import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useRef } from "react";
import type { Split, SplitOrientation } from "@/src/contexts/TabsContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";

// Width/height of the draggable gutter between two panes, in pixels.
export const SPLIT_GUTTER_PX = 6;

// The frosted titlebar (h-12) overlays the top 48px of the content area. Gutters
// start below it so they never sit on top of the tab strip.
const TITLEBAR_PX = 48;

// Smallest fraction a single pane may shrink to while resizing, so a pane can
// never be dragged to zero (and become ungrabbable).
const MIN_PANE_FRACTION = 0.12;

// Cumulative fraction occupied by every pane before `index`.
function fractionBefore(sizes: number[], index: number): number {
	let sum = 0;
	for (let i = 0; i < index; i += 1) {
		sum += sizes[i];
	}
	return sum;
}

// Absolute position + size for pane `index`. Panes share the cross-axis fully
// (full height for columns, full width for rows) and divide the main axis by
// `sizes`, with SPLIT_GUTTER_PX of space reserved between adjacent panes. The
// mixed `%`/`px` calc keeps the gutters pixel-exact regardless of container size.
export function paneStyle(
	orientation: SplitOrientation,
	sizes: number[],
	index: number
): CSSProperties {
	const n = sizes.length;
	const g = SPLIT_GUTTER_PX;
	const before = fractionBefore(sizes, index);
	const frac = sizes[index];
	const start = `calc(${(before * 100).toFixed(4)}% - ${(before * (n - 1) * g).toFixed(2)}px + ${(index * g).toFixed(2)}px)`;
	const size = `calc(${(frac * 100).toFixed(4)}% - ${(frac * (n - 1) * g).toFixed(2)}px)`;
	if (orientation === "columns") {
		return {
			position: "absolute",
			top: 0,
			bottom: 0,
			left: start,
			width: size,
		};
	}
	return { position: "absolute", left: 0, right: 0, top: start, height: size };
}

// Only panes whose top edge sits under the titlebar need to pad their content
// down to clear it: every column pane spans the full height, but for stacked
// rows only the top row underlaps the bar.
export function paneNeedsTopClearance(
	orientation: SplitOrientation,
	index: number
): boolean {
	return orientation === "columns" || index === 0;
}

// Position of the gutter handle sitting just before pane `boundary + 1`.
function gutterStyle(
	orientation: SplitOrientation,
	sizes: number[],
	boundary: number
): CSSProperties {
	const n = sizes.length;
	const g = SPLIT_GUTTER_PX;
	const through = fractionBefore(sizes, boundary + 1);
	const pos = `calc(${(through * 100).toFixed(4)}% - ${(through * (n - 1) * g).toFixed(2)}px + ${(boundary * g).toFixed(2)}px)`;
	if (orientation === "columns") {
		return {
			position: "absolute",
			top: TITLEBAR_PX,
			bottom: 0,
			left: pos,
			width: g,
		};
	}
	return { position: "absolute", left: 0, right: 0, top: pos, height: g };
}

// The draggable handles between panes. Dragging redistributes the fractions of
// the two adjacent panes (the rest stay put), clamped so neither collapses.
export function SplitGutters({
	split,
	containerRef,
}: {
	split: Split;
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const { setSplitSizes } = useTabsContext();
	// The fractions captured at drag start, so each move recomputes from a stable
	// baseline instead of compounding rounding.
	const startSizesRef = useRef<number[]>([]);
	const startPosRef = useRef(0);
	const boundaryRef = useRef(0);

	const onPointerMove = useCallback(
		(e: PointerEvent) => {
			const el = containerRef.current;
			if (!el) {
				return;
			}
			const rect = el.getBoundingClientRect();
			const total = split.orientation === "columns" ? rect.width : rect.height;
			if (total <= 0) {
				return;
			}
			const pos = split.orientation === "columns" ? e.clientX : e.clientY;
			const deltaFrac = (pos - startPosRef.current) / total;
			const i = boundaryRef.current;
			const base = startSizesRef.current;
			const pair = base[i] + base[i + 1];
			let first = base[i] + deltaFrac;
			first = Math.max(
				MIN_PANE_FRACTION,
				Math.min(pair - MIN_PANE_FRACTION, first)
			);
			const next = [...base];
			next[i] = first;
			next[i + 1] = pair - first;
			setSplitSizes(split.id, next);
		},
		[containerRef, split.id, split.orientation, setSplitSizes]
	);

	const endDrag = useCallback(() => {
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", endDrag);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	}, [onPointerMove]);

	const beginDrag = useCallback(
		(boundary: number, e: ReactPointerEvent) => {
			e.preventDefault();
			boundaryRef.current = boundary;
			startSizesRef.current = [...split.sizes];
			startPosRef.current =
				split.orientation === "columns" ? e.clientX : e.clientY;
			document.body.style.cursor =
				split.orientation === "columns" ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", endDrag);
		},
		[split.orientation, split.sizes, onPointerMove, endDrag]
	);

	return (
		<>
			{split.sizes.slice(0, -1).map((_, boundary) => (
				<button
					aria-label="Resize split"
					className={
						split.orientation === "columns"
							? "group/gutter z-20 flex cursor-col-resize items-center justify-center hover:bg-primary/20"
							: "group/gutter z-20 flex cursor-row-resize items-center justify-center hover:bg-primary/20"
					}
					// biome-ignore lint/suspicious/noArrayIndexKey: gutters are positional
					key={boundary}
					onPointerDown={(e) => beginDrag(boundary, e)}
					style={gutterStyle(split.orientation, split.sizes, boundary)}
					type="button"
				>
					<span
						aria-hidden
						className={
							split.orientation === "columns"
								? "h-8 w-0.5 rounded-full bg-border transition-colors group-hover/gutter:bg-primary"
								: "h-0.5 w-8 rounded-full bg-border transition-colors group-hover/gutter:bg-primary"
						}
					/>
				</button>
			))}
		</>
	);
}
