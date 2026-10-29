import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	WorkbenchGroup,
	WorkbenchItem,
	WorkbenchSplitNode,
} from "@ryu/workbench/model";
import type {
	CSSProperties,
	ReactNode,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Split } from "@/src/contexts/TabsContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type {
	SplitBranch,
	SplitNode,
	SplitOrientation,
} from "@/src/lib/splitTree.ts";
import { useDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { EmptyCenterGroup } from "@/src/workbench/WorkbenchRegion.tsx";
import { WorkbenchTabStrip } from "@/src/workbench/WorkbenchTabStrip.tsx";
import { useWorkbenchSlots } from "@/src/workbench/workbench-slots.tsx";
import splitStyles from "./SplitView.module.css";

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

function axisCalc(c: AxisCoeff, extraPx = 0): string {
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
function gutterStyle(spec: GutterSpec) {
	const clearance = paneNeedsTopClearance(spec.rect) ? TITLEBAR_PX : 0;
	return {
		"--pane-left": axisCalc(spec.rect.left),
		"--pane-top": axisCalc(spec.rect.top, clearance),
		"--pane-width": axisCalc(spec.rect.width),
		"--pane-height": axisCalc(spec.rect.height, -clearance),
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
	const previousPaneTransitionDurationRef = useRef<string | null>(null);

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
		// A cancelled pointer (OS-level gesture, focus loss) never sends
		// `pointerup`, so without this listener the body would keep its resize
		// cursor and `user-select: none` for the rest of the session.
		window.removeEventListener("pointercancel", endDrag);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		const previous = previousPaneTransitionDurationRef.current;
		if (previous === "") {
			document.body.style.removeProperty(
				"--ryu-split-pane-transition-duration"
			);
		} else if (previous !== null) {
			document.body.style.setProperty(
				"--ryu-split-pane-transition-duration",
				previous
			);
		}
		previousPaneTransitionDurationRef.current = null;
	}, [onPointerMove]);

	// NOTE: no momentum here, on purpose. A divider is placed, not thrown —
	// macOS split dividers and window edges carry no inertia, and projecting a
	// flick past the release point would read as the gutter slipping out from
	// under the pointer. `lib/gesture.ts` exists for surfaces that DO fly free.
	const beginDrag = useCallback(
		(spec: GutterSpec, e: ReactPointerEvent) => {
			e.preventDefault();
			// Keeps the drag alive when the pointer outruns the thin gutter.
			e.currentTarget.setPointerCapture?.(e.pointerId);
			activeRef.current = spec;
			previousPaneTransitionDurationRef.current =
				document.body.style.getPropertyValue(
					"--ryu-split-pane-transition-duration"
				);
			document.body.style.setProperty(
				"--ryu-split-pane-transition-duration",
				"0.001ms"
			);
			startSizesRef.current = [...spec.sizes];
			startPosRef.current =
				spec.orientation === "columns" ? e.clientX : e.clientY;
			document.body.style.cursor =
				spec.orientation === "columns" ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", endDrag);
			window.addEventListener("pointercancel", endDrag);
		},
		[onPointerMove, endDrag]
	);

	return (
		<>
			{layout.gutters.map((spec) => {
				const geometry = gutterStyle(spec);
				const gutterVariables: PaneCssVariables = {
					"--pane-left": geometry["--pane-left"],
					"--pane-top": geometry["--pane-top"],
					"--pane-width": geometry["--pane-width"],
					"--pane-height": geometry["--pane-height"],
				};
				return (
					<button
						aria-label="Resize split"
						className={cn(
							splitStyles.gutter,
							spec.orientation === "columns"
								? "group/gutter z-20 flex cursor-col-resize items-center justify-center hover:bg-primary/20"
								: "group/gutter z-20 flex cursor-row-resize items-center justify-center hover:bg-primary/20"
						)}
						key={`${spec.path.join(".")}:${spec.boundary}`}
						onPointerDown={(e) => beginDrag(spec, e)}
						// Without `touch-action: none` the browser claims the drag for
						// scrolling and a touch never resizes the split at all.
						style={gutterVariables}
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
				);
			})}
		</>
	);
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

function WorkbenchItemSlot({
	children,
	groupId,
	itemId,
}: {
	children?: ReactNode;
	groupId: string;
	itemId: string;
}) {
	const { registerSlot, unregisterSlot } = useWorkbenchSlots();
	const elementRef = useRef<HTMLDivElement | null>(null);
	const setSlotRef = useCallback(
		(element: HTMLDivElement | null) => {
			const previous = elementRef.current;
			if (previous) {
				unregisterSlot(groupId, itemId, previous);
			}
			elementRef.current = element;
			if (element) {
				registerSlot(groupId, itemId, element);
			}
		},
		[groupId, itemId, registerSlot, unregisterSlot]
	);
	return (
		<div
			className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
			data-workbench-item={itemId}
			data-workbench-slot={`${groupId}:${itemId}`}
			ref={setSlotRef}
		>
			{children}
		</div>
	);
}

function CenterGroupView({
	compatibilityContent,
	focused,
	group,
	hideTabStrip,
	items,
	onCloseItem,
	overlay,
	showOverlay,
	style,
}: {
	compatibilityContent?: ReactNode;
	focused: boolean;
	group: WorkbenchGroup;
	hideTabStrip: boolean;
	items: WorkbenchItem[];
	onCloseItem?: (item: WorkbenchItem) => void;
	overlay?: ReactNode;
	showOverlay: boolean;
	style: CSSProperties;
}) {
	const { dispatch } = useDesktopWorkbench();
	const activeItem = items.find((item) => item.id === group.activeItemId);
	return (
		<div
			className={cn(
				"absolute flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
				splitStyles.pane
			)}
			data-focused={focused}
			data-group-id={group.id}
			onMouseDownCapture={() =>
				dispatch({ type: "group/focus", groupId: group.id })
			}
			style={style}
		>
			{hideTabStrip ? null : (
				<WorkbenchTabStrip
					focused={focused}
					group={group}
					items={items}
					onCloseItem={onCloseItem}
				/>
			)}
			{activeItem ? (
				<WorkbenchItemSlot groupId={group.id} itemId={activeItem.id}>
					{compatibilityContent}
				</WorkbenchItemSlot>
			) : compatibilityContent ? (
				<div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
					{compatibilityContent}
				</div>
			) : (
				<EmptyCenterGroup group={group} />
			)}
			{showOverlay && overlay ? (
				<div
					className="pointer-events-none absolute inset-0 z-30 [&>*]:pointer-events-auto"
					data-workbench-center-overlay=""
				>
					{overlay}
				</div>
			) : null}
		</div>
	);
}

function WorkbenchCenterGutters({
	containerRef,
	layout,
}: {
	containerRef: React.RefObject<HTMLElement | null>;
	layout: SplitLayout;
}) {
	const { dispatch } = useDesktopWorkbench();
	const activeRef = useRef<{
		boundary: HTMLButtonElement;
		pointerId: number;
		previousCursor: string;
		previousUserSelect: string;
		spec: GutterSpec;
	} | null>(null);
	const startSizesRef = useRef<number[]>([]);
	const startPosRef = useRef(0);

	const onPointerMove = useCallback(
		(event: PointerEvent) => {
			const element = containerRef.current;
			const session = activeRef.current;
			if (!(element && session)) {
				return;
			}
			const { spec } = session;
			const box = element.getBoundingClientRect();
			const containerMain =
				spec.orientation === "columns" ? box.width : box.height;
			const total = spec.mainAxis.frac * containerMain + spec.mainAxis.px;
			if (total <= 0) {
				return;
			}
			const position =
				spec.orientation === "columns" ? event.clientX : event.clientY;
			const deltaFraction = (position - startPosRef.current) / total;
			const boundary = spec.boundary;
			const base = startSizesRef.current;
			const pair = (base[boundary] ?? 0) + (base[boundary + 1] ?? 0);
			const first = Math.max(
				MIN_PANE_FRACTION,
				Math.min(
					pair - MIN_PANE_FRACTION,
					(base[boundary] ?? 0) + deltaFraction
				)
			);
			const sizes = [...base];
			sizes[boundary] = first;
			sizes[boundary + 1] = pair - first;
			dispatch({ type: "center/resize-branch", path: spec.path, sizes });
		},
		[containerRef, dispatch]
	);
	const finishDragRef = useRef<() => void>(() => undefined);
	const onWindowKeyDown = useCallback((event: KeyboardEvent) => {
		if (event.key === "Escape") {
			finishDragRef.current();
		}
	}, []);

	const finishDrag = useCallback(() => {
		const session = activeRef.current;
		if (!session) {
			return;
		}
		activeRef.current = null;
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", finishDrag);
		window.removeEventListener("pointercancel", finishDrag);
		window.removeEventListener("blur", finishDrag);
		window.removeEventListener("keydown", onWindowKeyDown);
		session.boundary.removeEventListener("lostpointercapture", finishDrag);
		if (
			session.boundary.isConnected &&
			session.boundary.hasPointerCapture?.(session.pointerId)
		) {
			session.boundary.releasePointerCapture?.(session.pointerId);
		}
		document.body.style.cursor = session.previousCursor;
		document.body.style.userSelect = session.previousUserSelect;
	}, [onPointerMove, onWindowKeyDown]);
	finishDragRef.current = finishDrag;

	useEffect(() => finishDrag, [finishDrag]);

	const resizePair = useCallback(
		(spec: GutterSpec, delta: number) => {
			const boundary = spec.boundary;
			const sizes = [...spec.sizes];
			const pair = (sizes[boundary] ?? 0) + (sizes[boundary + 1] ?? 0);
			const first = Math.max(
				MIN_PANE_FRACTION,
				Math.min(pair - MIN_PANE_FRACTION, (sizes[boundary] ?? 0) + delta)
			);
			sizes[boundary] = first;
			sizes[boundary + 1] = pair - first;
			dispatch({ type: "center/resize-branch", path: spec.path, sizes });
		},
		[dispatch]
	);

	const beginDrag = useCallback(
		(spec: GutterSpec, event: ReactPointerEvent<HTMLButtonElement>) => {
			event.preventDefault();
			finishDrag();
			const boundary = event.currentTarget;
			activeRef.current = {
				boundary,
				pointerId: event.pointerId,
				previousCursor: document.body.style.cursor,
				previousUserSelect: document.body.style.userSelect,
				spec,
			};
			startSizesRef.current = [...spec.sizes];
			startPosRef.current =
				spec.orientation === "columns" ? event.clientX : event.clientY;
			document.body.style.cursor =
				spec.orientation === "columns" ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", finishDrag);
			window.addEventListener("pointercancel", finishDrag);
			window.addEventListener("blur", finishDrag);
			window.addEventListener("keydown", onWindowKeyDown);
			boundary.addEventListener("lostpointercapture", finishDrag);
			try {
				boundary.setPointerCapture?.(event.pointerId);
			} catch {
				// Window-level lifecycle listeners still settle synthetic/webview drags.
			}
		},
		[finishDrag, onPointerMove, onWindowKeyDown]
	);

	return layout.gutters.map((spec) => {
		const geometry = gutterStyle(spec);
		const gutterVariables: PaneCssVariables = {
			"--pane-left": geometry["--pane-left"],
			"--pane-top": geometry["--pane-top"],
			"--pane-width": geometry["--pane-width"],
			"--pane-height": geometry["--pane-height"],
		};
		const pair =
			(spec.sizes[spec.boundary] ?? 0) + (spec.sizes[spec.boundary + 1] ?? 0);
		return (
			<button
				aria-label="Resize Center split"
				aria-orientation={
					spec.orientation === "columns" ? "vertical" : "horizontal"
				}
				aria-valuemax={Math.round((pair - MIN_PANE_FRACTION) * 100)}
				aria-valuemin={Math.round(MIN_PANE_FRACTION * 100)}
				aria-valuenow={Math.round((spec.sizes[spec.boundary] ?? 0) * 100)}
				className={cn(
					splitStyles.gutter,
					spec.orientation === "columns"
						? "group/gutter absolute z-20 flex cursor-col-resize items-center justify-center hover:bg-primary/20"
						: "group/gutter absolute z-20 flex cursor-row-resize items-center justify-center hover:bg-primary/20"
				)}
				key={`${spec.path.join(".")}:${spec.boundary}`}
				onDoubleClick={() =>
					resizePair(spec, pair / 2 - (spec.sizes[spec.boundary] ?? pair / 2))
				}
				onKeyDown={(event) => {
					const negativeKey =
						spec.orientation === "columns" ? "ArrowLeft" : "ArrowUp";
					const positiveKey =
						spec.orientation === "columns" ? "ArrowRight" : "ArrowDown";
					if (event.key === "Escape") {
						finishDrag();
					} else if (event.key === negativeKey) {
						event.preventDefault();
						resizePair(spec, -0.05);
					} else if (event.key === positiveKey) {
						event.preventDefault();
						resizePair(spec, 0.05);
					}
				}}
				onPointerDown={(event) => beginDrag(spec, event)}
				role="separator"
				style={gutterVariables}
				tabIndex={0}
				type="button"
			/>
		);
	});
}

export function DesktopCenterSplitView({
	collapseToFocused = false,
	compatibilityContent,
	globalOverlay,
	onCloseItem,
	overlay,
	style,
	suppressFocusedTabStrip = false,
}: {
	/** Narrow windows show only the focused Center pane; the tree is kept. */
	collapseToFocused?: boolean;
	compatibilityContent?: ReactNode;
	globalOverlay?: ReactNode;
	onCloseItem?: (item: WorkbenchItem) => void;
	overlay?: ReactNode;
	style?: CSSProperties;
	suppressFocusedTabStrip?: boolean;
}) {
	const { state } = useDesktopWorkbench();
	const containerRef = useRef<HTMLElement | null>(null);
	const centerGroups = state.groups.filter(
		(group) => group.region === "center"
	);
	const collapsedGroupId =
		collapseToFocused && state.centerTree.type === "branch"
			? (centerGroups.find((group) => group.id === state.focusedGroupId)?.id ??
				centerGroups.find((group) => group.activeItemId !== null)?.id ??
				centerGroups[0]?.id)
			: undefined;
	const layout = useMemo(
		() =>
			computeCenterGroupLayout(
				collapsedGroupId
					? { type: "leaf", groupId: collapsedGroupId }
					: state.centerTree
			),
		[collapsedGroupId, state.centerTree]
	);
	const firstGroupId = layout.panes.keys().next().value;
	const focusedCenterGroupId = centerGroups.some(
		(group) => group.id === state.focusedGroupId && group.activeItemId !== null
	)
		? state.focusedGroupId
		: undefined;
	const overlayGroupId =
		focusedCenterGroupId ??
		centerGroups.find((group) => group.activeItemId !== null)?.id ??
		firstGroupId;
	return (
		<section
			aria-label="Center"
			className="relative min-h-0 min-w-0 overflow-hidden bg-background"
			data-focused={centerGroups.some(
				(group) => group.id === state.focusedGroupId
			)}
			data-region="center"
			ref={containerRef}
			style={style}
		>
			{centerGroups.flatMap((group) => {
				const rect = layout.panes.get(group.id);
				if (!rect) {
					return [];
				}
				const items = group.itemIds.flatMap((itemId) => {
					const item = state.items.find((candidate) => candidate.id === itemId);
					return item ? [item] : [];
				});
				const paneVariables: PaneCssVariables = {
					"--pane-left": axisCalc(rect.left),
					"--pane-top": axisCalc(rect.top),
					"--pane-width": axisCalc(rect.width),
					"--pane-height": axisCalc(rect.height),
				};
				const focused = group.id === state.focusedGroupId;
				const showOverlay = group.id === overlayGroupId;
				return [
					<CenterGroupView
						compatibilityContent={
							group.id === firstGroupId ? compatibilityContent : undefined
						}
						focused={focused}
						group={group}
						hideTabStrip={showOverlay && (suppressFocusedTabStrip || !!overlay)}
						items={items}
						key={group.id}
						onCloseItem={onCloseItem}
						overlay={showOverlay ? overlay : undefined}
						showOverlay={showOverlay}
						style={paneVariables}
					/>,
				];
			})}
			<WorkbenchCenterGutters containerRef={containerRef} layout={layout} />
			{globalOverlay}
		</section>
	);
}

export interface PaneCssVariables extends CSSProperties {
	"--pane-height"?: string;
	"--pane-left"?: string;
	"--pane-top"?: string;
	"--pane-width"?: string;
}
