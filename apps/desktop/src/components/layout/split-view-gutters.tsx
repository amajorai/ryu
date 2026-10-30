// The draggable gutters between split panes: one for the tab split tree and one
// for the workbench center groups. Dragging redistributes adjacent fractions.

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import type { Split } from "@/src/contexts/TabsContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import splitStyles from "./SplitView.module.css";
import {
	computeSplitLayout,
	type GutterSpec,
	gutterStyle,
	MIN_PANE_FRACTION,
	type PaneCssVariables,
	type SplitLayout,
} from "./split-view-layout.ts";

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

export function WorkbenchCenterGutters({
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
