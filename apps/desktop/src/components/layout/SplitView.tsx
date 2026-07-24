import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useMemo, useRef } from "react";
import type { Split } from "@/src/contexts/TabsContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type {
	SplitBranch,
	SplitNode,
	SplitOrientation,
} from "@/src/lib/splitTree.ts";

// Width/height of the draggable gutter between two panes, in pixels.
export const SPLIT_GUTTER_PX = 6;

// The frosted titlebar (h-12) overlays the top 48px of the content area. Gutters
// start below it so they never sit on top of the tab strip.
const TITLEBAR_PX = 48;

// Smallest fraction a single pane may shrink to while resizing, so a pane can
// never be dragged to zero (and become ungrabbable).
const MIN_PANE_FRACTION = 0.12;

/** One axis of a pane rect as a linear function of the container size:
    `value = frac × container% + px`. Because columns only divide width and
    rows only divide height, every rect in an arbitrarily nested tree stays
    linear per axis — so panes position with pure CSS calc() and never need a
    ResizeObserver. */
export interface AxisCoeff {
	frac: number;
	px: number;
}

/** A pane's rect: left/width are linear in container WIDTH, top/height in
    container HEIGHT. */
export interface PaneRect {
	height: AxisCoeff;
	left: AxisCoeff;
	top: AxisCoeff;
	width: AxisCoeff;
}

/** A draggable boundary between two children of one branch. `path` addresses
    the branch from the root (child indexes); `boundary` is the index of the
    child before the gutter; `mainAxis` is the branch's divisible main-axis
    size (gutters excluded), used to convert drag pixels into fractions. */
export interface GutterSpec {
	boundary: number;
	mainAxis: AxisCoeff;
	orientation: SplitOrientation;
	path: number[];
	rect: PaneRect;
	sizes: number[];
}

export interface SplitLayout {
	gutters: GutterSpec[];
	panes: Map<string, PaneRect>;
}

/** The whole content area — the rect of a lone (unsplit) pane. */
export const FULL_PANE_RECT: PaneRect = {
	left: { frac: 0, px: 0 },
	top: { frac: 0, px: 0 },
	width: { frac: 1, px: 0 },
	height: { frac: 1, px: 0 },
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one recursive walk keeps both axes' math side by side
function walkNode(
	node: SplitNode,
	rect: PaneRect,
	path: number[],
	out: SplitLayout
): void {
	if (node.type === "leaf") {
		out.panes.set(node.tabId, rect);
		return;
	}
	const n = node.children.length;
	const g = SPLIT_GUTTER_PX;
	if (node.orientation === "columns") {
		const avail: AxisCoeff = {
			frac: rect.width.frac,
			px: rect.width.px - (n - 1) * g,
		};
		let cursor: AxisCoeff = { ...rect.left };
		node.children.forEach((child, i) => {
			const frac = node.sizes[i] ?? 1 / n;
			const width: AxisCoeff = { frac: avail.frac * frac, px: avail.px * frac };
			walkNode(
				child,
				{ left: { ...cursor }, top: rect.top, width, height: rect.height },
				[...path, i],
				out
			);
			cursor = { frac: cursor.frac + width.frac, px: cursor.px + width.px };
			if (i < n - 1) {
				out.gutters.push({
					orientation: node.orientation,
					path,
					boundary: i,
					sizes: node.sizes,
					mainAxis: avail,
					rect: {
						left: { ...cursor },
						top: rect.top,
						width: { frac: 0, px: g },
						height: rect.height,
					},
				});
				cursor = { frac: cursor.frac, px: cursor.px + g };
			}
		});
		return;
	}
	const avail: AxisCoeff = {
		frac: rect.height.frac,
		px: rect.height.px - (n - 1) * g,
	};
	let cursor: AxisCoeff = { ...rect.top };
	node.children.forEach((child, i) => {
		const frac = node.sizes[i] ?? 1 / n;
		const height: AxisCoeff = { frac: avail.frac * frac, px: avail.px * frac };
		walkNode(
			child,
			{ left: rect.left, top: { ...cursor }, width: rect.width, height },
			[...path, i],
			out
		);
		cursor = { frac: cursor.frac + height.frac, px: cursor.px + height.px };
		if (i < n - 1) {
			out.gutters.push({
				orientation: node.orientation,
				path,
				boundary: i,
				sizes: node.sizes,
				mainAxis: avail,
				rect: {
					left: rect.left,
					top: { ...cursor },
					width: rect.width,
					height: { frac: 0, px: g },
				},
			});
			cursor = { frac: cursor.frac, px: cursor.px + g };
		}
	});
}

/** Geometry for every pane (keyed by tab id) and every gutter of a split
    tree, in container-relative linear coordinates. */
export function computeSplitLayout(root: SplitBranch): SplitLayout {
	const out: SplitLayout = { panes: new Map(), gutters: [] };
	walkNode(root, FULL_PANE_RECT, [], out);
	return out;
}

function axisCalc(c: AxisCoeff, extraPx = 0): string {
	return `calc(${(c.frac * 100).toFixed(4)}% + ${(c.px + extraPx).toFixed(2)}px)`;
}

/** Absolute-position style for a pane rect. */
export function paneRectStyle(rect: PaneRect): CSSProperties {
	return {
		position: "absolute",
		left: axisCalc(rect.left),
		top: axisCalc(rect.top),
		width: axisCalc(rect.width),
		height: axisCalc(rect.height),
	};
}

/** Pixel rect for a pane given the measured container box (drop-zone math). */
export function paneRectPx(
	rect: PaneRect,
	container: { height: number; width: number }
): { height: number; left: number; top: number; width: number } {
	return {
		left: rect.left.frac * container.width + rect.left.px,
		top: rect.top.frac * container.height + rect.top.px,
		width: rect.width.frac * container.width + rect.width.px,
		height: rect.height.frac * container.height + rect.height.px,
	};
}

// Only panes that reach the top of the content area sit under the titlebar
// and need to pad their content down to clear it.
export function paneNeedsTopClearance(rect: PaneRect): boolean {
	return rect.top.frac === 0 && rect.top.px === 0;
}

// A gutter that reaches the top edge starts below the titlebar so it never
// sits on top of the tab strip.
function gutterStyle(spec: GutterSpec): CSSProperties {
	const clearance = paneNeedsTopClearance(spec.rect) ? TITLEBAR_PX : 0;
	return {
		position: "absolute",
		left: axisCalc(spec.rect.left),
		top: axisCalc(spec.rect.top, clearance),
		width: axisCalc(spec.rect.width),
		height: axisCalc(spec.rect.height, -clearance),
	};
}

// The draggable handles between panes — one per branch boundary, at any depth.
// Dragging redistributes the fractions of the two adjacent children of that
// branch (the rest stay put), clamped so neither collapses.
export function SplitGutters({
	split,
	containerRef,
}: {
	split: Split;
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const { setSplitSizes } = useTabsContext();
	const layout = useMemo(() => computeSplitLayout(split.root), [split.root]);
	// The gutter + fractions captured at drag start, so each move recomputes
	// from a stable baseline instead of compounding rounding.
	const activeRef = useRef<GutterSpec | null>(null);
	const startSizesRef = useRef<number[]>([]);
	const startPosRef = useRef(0);

	const onPointerMove = useCallback(
		(e: PointerEvent) => {
			const el = containerRef.current;
			const spec = activeRef.current;
			if (!(el && spec)) {
				return;
			}
			const box = el.getBoundingClientRect();
			const containerMain =
				spec.orientation === "columns" ? box.width : box.height;
			const total = spec.mainAxis.frac * containerMain + spec.mainAxis.px;
			if (total <= 0) {
				return;
			}
			const pos = spec.orientation === "columns" ? e.clientX : e.clientY;
			const deltaFrac = (pos - startPosRef.current) / total;
			const i = spec.boundary;
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
			setSplitSizes(split.id, spec.path, next);
		},
		[containerRef, split.id, setSplitSizes]
	);

	const endDrag = useCallback(() => {
		activeRef.current = null;
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", endDrag);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	}, [onPointerMove]);

	const beginDrag = useCallback(
		(spec: GutterSpec, e: ReactPointerEvent) => {
			e.preventDefault();
			activeRef.current = spec;
			startSizesRef.current = [...spec.sizes];
			startPosRef.current =
				spec.orientation === "columns" ? e.clientX : e.clientY;
			document.body.style.cursor =
				spec.orientation === "columns" ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", endDrag);
		},
		[onPointerMove, endDrag]
	);

	return (
		<>
			{layout.gutters.map((spec) => (
				<button
					aria-label="Resize split"
					className={
						spec.orientation === "columns"
							? "group/gutter z-20 flex cursor-col-resize items-center justify-center hover:bg-primary/20"
							: "group/gutter z-20 flex cursor-row-resize items-center justify-center hover:bg-primary/20"
					}
					key={`${spec.path.join(".")}:${spec.boundary}`}
					onPointerDown={(e) => beginDrag(spec, e)}
					style={gutterStyle(spec)}
					type="button"
				>
					<span
						aria-hidden
						className={
							spec.orientation === "columns"
								? "h-8 w-0.5 rounded-full bg-border transition-colors group-hover/gutter:bg-primary"
								: "h-0.5 w-8 rounded-full bg-border transition-colors group-hover/gutter:bg-primary"
						}
					/>
				</button>
			))}
		</>
	);
}
