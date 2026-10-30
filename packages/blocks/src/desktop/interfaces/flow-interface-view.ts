import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type FlowView,
	fitView,
	keepInView,
	useFlowPanZoom,
	zoomAt,
} from "./flow-hooks.ts";
import {
	autoFitMinZoom,
	BRANCH_MARGIN,
	branchBox,
	chainBox,
	DEFAULT_VIEW,
	FIT_MAX_ZOOM,
	PANEL_OVERLAY_BELOW,
} from "./flow-interface-geometry.ts";
import type { FlowLayout } from "./flow-model.ts";

/**
 * The canvas camera: fits the flow until the user moves it, keeps the
 * selected branch clear of the panel, and exposes zoom/fit/reveal controls.
 */
export function useFlowInterfaceView({
	highlighted,
	layout,
	panelW,
	size,
	viewportRef,
}: {
	highlighted: string | null;
	layout: FlowLayout;
	panelW: number;
	size: { height: number; width: number };
	viewportRef: RefObject<HTMLDivElement | null>;
}) {
	const [view, setView] = useState<FlowView | null>(null);
	const [animateView, setAnimateView] = useState(false);
	const userMoved = useRef(false);

	const userChange = useCallback((update: (view: FlowView) => FlowView) => {
		userMoved.current = true;
		setAnimateView(false);
		setView((previous) => (previous ? update(previous) : previous));
	}, []);
	const { panning } = useFlowPanZoom(viewportRef, userChange);

	// Fit the flow to the screen until the user moves it themselves.
	const fitWidth =
		panelW < size.width && size.width >= PANEL_OVERLAY_BELOW
			? size.width - panelW
			: size.width;
	const minZoom = autoFitMinZoom(size.width);
	const { maxX, maxY, minX, minY } = layout.bounds;
	const shown = view ?? DEFAULT_VIEW;
	const viewRef = useRef<FlowView | null>(null);
	viewRef.current = view;
	// With the panel open, the selected node and its first-level children stay
	// clear of it, the way the reference keeps a service beside its panel.
	const branch =
		panelW > 0 && panelW < size.width ? branchBox(layout, highlighted) : null;
	const branchKey = branch
		? `${branch.minX},${branch.minY},${branch.maxX},${branch.maxY}`
		: "";
	const branchRef = useRef(branch);
	branchRef.current = branch;
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const highlightedRef = useRef(highlighted);
	highlightedRef.current = highlighted;
	useEffect(() => {
		if (size.width === 0) {
			return;
		}
		const focusBox = branchKey ? branchRef.current : null;
		const previous = viewRef.current;
		let next =
			userMoved.current && previous
				? previous
				: fitView(
						{ maxX, maxY, minX, minY },
						{ height: size.height, width: fitWidth },
						minZoom,
						FIT_MAX_ZOOM
					);
		if (focusBox) {
			const area = {
				bottom: size.height - BRANCH_MARGIN,
				left: BRANCH_MARGIN,
				right: size.width - panelW - BRANCH_MARGIN,
				top: BRANCH_MARGIN,
			};
			next = keepInView(next, focusBox, area);
			// Then pull the parent chain back in: when the children do not fit
			// beside the panel, they run under it rather than "You" leaving.
			const chain = chainBox(
				layoutRef.current,
				highlightedRef.current,
				(area.right - area.left) / next.k
			);
			if (chain) {
				next = keepInView(next, chain, area);
			}
		}
		if (next === previous) {
			return;
		}
		setAnimateView(previous !== null);
		setView(next);
	}, [
		branchKey,
		fitWidth,
		maxX,
		maxY,
		minX,
		minY,
		minZoom,
		panelW,
		size.height,
		size.width,
	]);

	const fitToScreen = useCallback(() => {
		userMoved.current = false;
		setAnimateView(true);
		setView(
			fitView(
				{ maxX, maxY, minX, minY },
				{ height: size.height, width: fitWidth },
				minZoom,
				FIT_MAX_ZOOM
			)
		);
	}, [fitWidth, maxX, maxY, minX, minY, minZoom, size.height]);

	const zoomBy = useCallback(
		(factor: number) => {
			userMoved.current = true;
			setAnimateView(true);
			setView((previous) =>
				previous
					? zoomAt(previous, factor, (size.width - panelW) / 2, size.height / 2)
					: previous
			);
		},
		[panelW, size.height, size.width]
	);

	/** Pans just enough to bring a node clear of the edges and the panel. */
	const reveal = useCallback(
		(id: string) => {
			const node = layout.nodes.find((item) => item.id === id);
			if (!node || size.width === 0) {
				return;
			}
			const previous = viewRef.current;
			if (!previous) {
				return;
			}
			const margin = 32;
			const right = size.width - (panelW < size.width ? panelW : 0) - margin;
			const left = previous.x + node.x * previous.k;
			const end = previous.x + (node.x + node.w) * previous.k;
			const top = previous.y + (node.y - node.h / 2) * previous.k;
			const bottom = previous.y + (node.y + node.h / 2) * previous.k;
			let dx = 0;
			let dy = 0;
			if (end > right) {
				dx = right - end;
			}
			if (left + dx < margin) {
				dx = margin - left;
			}
			if (bottom > size.height - margin) {
				dy = size.height - margin - bottom;
			}
			if (top + dy < margin) {
				dy = margin - top;
			}
			if (dx === 0 && dy === 0) {
				return;
			}
			setAnimateView(true);
			setView({ ...previous, x: previous.x + dx, y: previous.y + dy });
		},
		[layout.nodes, panelW, size.height, size.width]
	);

	return {
		animateView,
		fitToScreen,
		panning,
		reveal,
		shown,
		userMoved,
		view,
		zoomBy,
	};
}
