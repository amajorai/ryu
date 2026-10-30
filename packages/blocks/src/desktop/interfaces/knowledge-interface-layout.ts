import { useEffect, useMemo, useRef } from "react";
import {
	createLayout,
	type ForceSettings,
	type KnowledgeGraph,
	type KnowledgeSettings,
	type Layout,
	reheat,
	settleLayout,
	warmTicks,
} from "./knowledge-model.ts";
import { createProjection } from "./knowledge-stage.ts";

const EMPTY_GRAPH: KnowledgeGraph = { links: [], nodes: [] };

/** Ticks run up front under reduced motion, so the graph appears settled. */
export const SETTLE_TICKS = 320;
/**
 * Below this width the settings panel starts folded, and a side panel that
 * leaves the graph less than this folds it while it is open.
 */
export const COMPACT_WIDTH = 1100;
/** If the 3D view has not drawn a frame by now, the 2D renderer takes over. */
export const FIRST_FRAME_TIMEOUT_MS = 12_000;
/** Room the settings card takes on the right (its width plus gutters). */
export const CARD_INSET = 288;
/** Pointer travel (px) that turns a click into a drag. */
export const DRAG_SLOP = 5;

function forcesOf(settings: KnowledgeSettings, aspect: number): ForceSettings {
	return {
		aspect,
		centerForce: settings.centerForce,
		linkDistance: settings.linkDistance,
		linkForce: settings.linkForce,
		repelForce: settings.repelForce,
	};
}

/**
 * Height over width of the room the graph gets (clear of the header and the
 * legend), in tenths so a resize only re-shapes the layout when the shape
 * really changes. Measured on the whole interface, not the stage, so opening
 * a side panel or the settings card never re-shapes the graph.
 */
function stageAspect(size: { height: number; width: number } | null): number {
	if (!size || size.width <= 0 || size.height <= 0) {
		return 1;
	}
	const width = Math.max(120, size.width - 32);
	const height = Math.max(120, size.height - 116);
	return Math.round((height / width) * 10) / 10;
}

/** Escape and arrow keys inside a text field belong to the field. */
export function isTextField(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/** Width the side panel takes beside the graph (its widest breakpoint). */
export function sidePanelWidth(
	threadOpen: boolean,
	nodeSelected: boolean
): number {
	if (threadOpen) {
		return 480;
	}
	return nodeSelected ? 360 : 0;
}

type Size = { height: number; width: number } | null;

/**
 * The force layout the graph is drawn from: settled once the interface's and
 * the stage's sizes are known, and woken again when a force changes.
 */
export function useKnowledgeLayout({
	dims,
	isLocal,
	reduced,
	rootSize,
	settings,
	stageSize,
	visible,
}: {
	dims: 2 | 3;
	isLocal: boolean;
	reduced: boolean;
	rootSize: Size;
	settings: KnowledgeSettings;
	stageSize: Size;
	visible: KnowledgeGraph;
}) {
	const previousLayout = useRef<Layout | null>(null);
	/** The last global layout: leaving local mode returns nodes to it. */
	const globalLayout = useRef<Layout | null>(null);
	// The layout's shape comes from the whole interface, not the stage, so a
	// side panel or the settings card never re-shapes the graph.
	const aspect = stageAspect(rootSize);
	const forces = forcesOf(settings, aspect);
	const forcesRef = useRef(forces);
	forcesRef.current = forces;
	// The layout waits for the interface's and the stage's sizes (read
	// before the first paint), so it settles once, for the shape it is shown
	// in, and never visibly drifts into shape after mount.
	const sized = rootSize !== null && stageSize !== null;
	const layout = useMemo(() => {
		if (!sized) {
			return createLayout(EMPTY_GRAPH, dims);
		}
		// Back from a local graph, nodes return to where the global graph
		// left them (as in Obsidian); otherwise they keep their last spot.
		const seed = isLocal
			? previousLayout.current
			: (globalLayout.current ?? previousLayout.current);
		const next = createLayout(visible, dims, seed);
		settleLayout(
			next,
			forcesRef.current,
			reduced ? SETTLE_TICKS : warmTicks(next.ids.length)
		);
		return next;
	}, [visible, dims, reduced, isLocal, sized]);
	useEffect(() => {
		previousLayout.current = layout;
		if (!isLocal) {
			globalLayout.current = layout;
		}
	}, [layout, isLocal]);
	const projection = useMemo(
		() => createProjection(layout.ids.length),
		[layout]
	);

	// A force change wakes the layout (or re-settles it at once). The
	// layout's shape follows the whole interface (a window resize), never a
	// side panel or the settings card: those reframe the camera but never
	// rearrange the graph.
	const forceKey = `${aspect}|${settings.centerForce}|${settings.linkDistance}|${settings.linkForce}|${settings.repelForce}`;
	const lastForce = useRef({ key: forceKey, layout });
	useEffect(() => {
		const last = lastForce.current;
		lastForce.current = { key: forceKey, layout };
		// A new layout was settled with the current forces already.
		if (last.key === forceKey || last.layout !== layout) {
			return;
		}
		reheat(layout, 0.5);
		if (reduced) {
			settleLayout(layout, forcesRef.current, SETTLE_TICKS);
		}
	}, [forceKey, layout, reduced]);

	return { forces, forcesRef, layout, projection, sized };
}
