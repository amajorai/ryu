// Split-pane layout math: pane rects and gutters as linear CSS calc() per axis,
// for both the tab split tree and the workbench center group tree.

import type { WorkbenchSplitNode } from "@ryu/workbench/model";
import type { CSSProperties } from "react";
import type {
	SplitBranch,
	SplitNode,
	SplitOrientation,
} from "@/src/lib/splitTree.ts";

// Width/height of the draggable gutter between two panes, in pixels.
export const SPLIT_GUTTER_PX = 6;

// The frosted titlebar (h-12) overlays the top 48px of the content area. Gutters
// start below it so they never sit on top of the tab strip.
export const TITLEBAR_PX = 48;

// Smallest fraction a single pane may shrink to while resizing, so a pane can
// never be dragged to zero (and become ungrabbable).
export const MIN_PANE_FRACTION = 0.12;

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

// one recursive walk keeps both axes' math side by side
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

export function axisCalc(c: AxisCoeff, extraPx = 0): string {
	return `calc(${(c.frac * 100).toFixed(4)}% + ${(c.px + extraPx).toFixed(2)}px)`;
}

/** Absolute-position style for a pane rect. */
export function paneRectStyle(rect: PaneRect): CSSProperties {
	return {
		position: "absolute",
		left: axisCalc(rect.left),
		top: axisCalc(rect.top),
		transition:
			"left var(--ryu-split-pane-transition-duration, 220ms) cubic-bezier(0.23, 1, 0.32, 1), top var(--ryu-split-pane-transition-duration, 220ms) cubic-bezier(0.23, 1, 0.32, 1), width var(--ryu-split-pane-transition-duration, 220ms) cubic-bezier(0.23, 1, 0.32, 1), height var(--ryu-split-pane-transition-duration, 220ms) cubic-bezier(0.23, 1, 0.32, 1)",
		width: axisCalc(rect.width),
		height: axisCalc(rect.height),
	};
}

/** Pixel rect for a pane given the measured container box (drop-zone math). */
export function paneRectPx(
	rect: PaneRect,
	container: { height: number; width: number }
) {
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
export function gutterStyle(spec: GutterSpec) {
	const clearance = paneNeedsTopClearance(spec.rect) ? TITLEBAR_PX : 0;
	return {
		"--pane-left": axisCalc(spec.rect.left),
		"--pane-top": axisCalc(spec.rect.top, clearance),
		"--pane-width": axisCalc(spec.rect.width),
		"--pane-height": axisCalc(spec.rect.height, -clearance),
	};
}

function workbenchTreeAsSplitNode(tree: WorkbenchSplitNode): SplitNode {
	if (tree.type === "leaf") {
		return { type: "leaf", tabId: tree.groupId };
	}
	return {
		type: "branch",
		children: tree.children.map(workbenchTreeAsSplitNode),
		orientation: tree.orientation,
		sizes: tree.sizes,
	};
}

export function computeCenterGroupLayout(
	tree: WorkbenchSplitNode
): SplitLayout {
	const splitNode = workbenchTreeAsSplitNode(tree);
	if (splitNode.type === "leaf") {
		return {
			gutters: [],
			panes: new Map([[splitNode.tabId, FULL_PANE_RECT]]),
		};
	}
	return computeSplitLayout(splitNode);
}

export interface PaneCssVariables extends CSSProperties {
	"--pane-height"?: string;
	"--pane-left"?: string;
	"--pane-top"?: string;
	"--pane-width"?: string;
}
