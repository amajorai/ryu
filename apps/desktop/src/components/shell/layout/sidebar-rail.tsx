import {
	clampWithRubberband,
	createVelocityTracker,
	projectEndpoint,
} from "@ryu/ui/lib/gesture.ts";
import { haptic } from "@ryu/ui/lib/haptics.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ComponentProps,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { DesktopWorkbenchValue } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { SidebarPanelContent } from "../../layout/AppSidebar.tsx";
import layoutStyles from "../../layout/Layout.module.css";
import {
	type LayoutCssVariables,
	SIDEBAR_COLLAPSE_PROJECTION,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from "./layout-constants.ts";

/** Pointer-driven resize (and flick-to-collapse) for the docked sidebar rail. */
export function useSidebarRailResize(
	sidebarWidth: number,
	onSidebarWidthChange: (width: number) => void,
	setOpen: (open: boolean) => void
) {
	const resizingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(sidebarWidth);
	const widthRef = useRef(sidebarWidth);
	const pointerIdRef = useRef<number | null>(null);
	// Position history for the release velocity — see `endRailDrag`.
	const railVelocityRef = useRef(createVelocityTracker());

	// POINTER events, not mouse events. The rail used to listen for
	// `mousemove`/`mouseup`, which a pen or a touch drag never fires — the
	// sidebar simply could not be resized by either. `setPointerCapture` then
	// keeps the drag alive when the pointer leaves the 2px handle, which is what
	// the document-level listener was standing in for.
	const handleRailPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			// Capture on the handle: every subsequent move/up for this pointer is
			// retargeted here and still bubbles to the document listeners below.
			e.currentTarget.setPointerCapture?.(e.pointerId);
			pointerIdRef.current = e.pointerId;
			resizingRef.current = true;
			startXRef.current = e.clientX;
			startWidthRef.current = sidebarWidth;
			widthRef.current = sidebarWidth;
			railVelocityRef.current.reset();
			railVelocityRef.current.sample(e.clientX, e.timeStamp);
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		[sidebarWidth]
	);

	useEffect(() => {
		const finishDrag = () => {
			resizingRef.current = false;
			pointerIdRef.current = null;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		const onMove = (e: PointerEvent) => {
			if (!resizingRef.current || e.pointerId !== pointerIdRef.current) {
				return;
			}
			railVelocityRef.current.sample(e.clientX, e.timeStamp);
			const raw = startWidthRef.current + (e.clientX - startXRef.current);
			// Give at the limits instead of stopping dead. The overshoot is
			// transient — `endRailDrag` snaps back to the hard bounds on release,
			// so nothing out of range is ever the resting value.
			const next = clampWithRubberband(
				raw,
				SIDEBAR_MIN_WIDTH,
				SIDEBAR_MAX_WIDTH,
				window.innerWidth
			);
			widthRef.current = next;
			onSidebarWidthChange(next);
		};

		const onUp = (e: PointerEvent) => {
			if (!resizingRef.current || e.pointerId !== pointerIdRef.current) {
				return;
			}
			railVelocityRef.current.sample(e.clientX, e.timeStamp);
			// Where the gesture was HEADED, not where the pointer happened to stop.
			// A decisive inward flick collapses the sidebar even if the finger
			// lifted well short of the edge; a slow drag to the same pixel does
			// not. Without this the release velocity is simply discarded and both
			// gestures produce the same result.
			const projected = projectEndpoint(
				widthRef.current,
				railVelocityRef.current.velocity()
			);
			finishDrag();
			if (projected < SIDEBAR_COLLAPSE_PROJECTION) {
				// Restore the pre-drag width so reopening does not come back pinned
				// to the minimum.
				onSidebarWidthChange(startWidthRef.current);
				// Same frame as the collapse, not after it — the feedback has to
				// coincide with the event that caused it to read as one thing.
				haptic("snap");
				setOpen(false);
				return;
			}
			onSidebarWidthChange(
				Math.max(
					SIDEBAR_MIN_WIDTH,
					Math.min(SIDEBAR_MAX_WIDTH, widthRef.current)
				)
			);
		};

		// A cancelled pointer (OS gesture, focus loss) never sends `pointerup`;
		// without this the body keeps `col-resize` and `user-select: none`.
		const onCancel = (e: PointerEvent) => {
			if (e.pointerId !== pointerIdRef.current) {
				return;
			}
			finishDrag();
			onSidebarWidthChange(
				Math.max(
					SIDEBAR_MIN_WIDTH,
					Math.min(SIDEBAR_MAX_WIDTH, widthRef.current)
				)
			);
		};

		document.addEventListener("pointermove", onMove, { passive: true });
		document.addEventListener("pointerup", onUp);
		document.addEventListener("pointercancel", onCancel);
		return () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointercancel", onCancel);
		};
	}, [onSidebarWidthChange, setOpen]);
	return { handleRailPointerDown, resizingRef };
}

/** Hover-peek state for the floating sidebar while the docked one is closed. */
export function useSidebarFloatPeek(
	open: boolean,
	resizingRef: RefObject<boolean>
) {
	const [floatOpen, setFloatOpen] = useState(false);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Close floating sidebar when the docked one opens
	useEffect(() => {
		if (open) {
			if (hideTimer.current) {
				clearTimeout(hideTimer.current);
			}
			setFloatOpen(false);
		}
	}, [open]);

	const showFloat = () => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
		setFloatOpen(true);
	};

	const scheduleHide = () => {
		// Dragging the floating panel's resize handle pulls the cursor out of the
		// panel, firing onMouseLeave. Don't hide while a resize is in progress —
		// otherwise the panel slides away mid-drag.
		if (resizingRef.current) {
			return;
		}
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
		}
		hideTimer.current = setTimeout(() => {
			// The footer trays (Downloads, Inbox) are portaled to the body — they
			// are wider than the sidebar, and this panel clips them — so moving the
			// pointer onto an open tray reads as leaving the panel. Hold the panel
			// up while one is open and re-check, so it slides away on the tick after
			// the tray closes instead of vanishing out from under it.
			if (document.querySelector('[data-sidebar-overlay="open"]')) {
				scheduleHide();
				return;
			}
			setFloatOpen(false);
		}, 200);
	};
	return { floatOpen, scheduleHide, showFloat };
}

/** The hover-peek copy of the sidebar shown while the docked one is collapsed. */
export function FloatingSidebarPeek({
	cssVariables3,
	cssVariables4,
	onRailPointerDown,
	panelProps,
	scheduleHide,
	showFloat,
}: {
	cssVariables3: LayoutCssVariables;
	cssVariables4: LayoutCssVariables;
	onRailPointerDown: (e: React.PointerEvent) => void;
	panelProps: ComponentProps<typeof SidebarPanelContent>;
	scheduleHide: () => void;
	showFloat: () => void;
}) {
	return (
		<div
			className={cn("fixed top-0 left-0 z-50 h-full", layoutStyles.inline3)}
			style={cssVariables3}
		>
			<div
				className={cn(
					"ryu-sidebar-surface absolute top-2 bottom-2 left-2 flex flex-col overflow-hidden rounded-2xl border border-border bg-sidebar shadow-xl",
					layoutStyles.inline4
				)}
				data-sidebar-preview-boundary=""
				onMouseEnter={showFloat}
				onMouseLeave={scheduleHide}
				style={cssVariables4}
			>
				<SidebarPanelContent {...panelProps} />
				<div
					className={cn(
						"absolute top-0 right-0 h-full w-1.5 cursor-col-resize opacity-0 transition-opacity hover:bg-sidebar-border hover:opacity-100",
						layoutStyles.inline5
					)}
					onPointerDown={onRailPointerDown}
				/>
			</div>

			<div
				className={cn(
					"absolute top-0 left-0 h-full w-10",
					layoutStyles.inline6
				)}
				onMouseEnter={showFloat}
				onMouseLeave={scheduleHide}
			/>
		</div>
	);
}

/**
 * Where the Navigation workbench item lives. In Left (the default) AppSidebar
 * renders it; moved to another pane, the docked sidebar stands down.
 */
export function useNavigationPlacement({
	dispatchWorkbench,
	isMobile,
	open,
	osProduct,
	setOpen,
	sidebarShown,
	toggleSidebar,
	workbenchState,
}: {
	dispatchWorkbench: DesktopWorkbenchValue["dispatch"];
	isMobile: boolean;
	open: boolean;
	osProduct: boolean;
	setOpen: (open: boolean) => void;
	sidebarShown: boolean;
	toggleSidebar: () => void;
	workbenchState: DesktopWorkbenchValue["state"];
}) {
	// Navigation is a workbench item. In Left (the default) AppSidebar renders
	// it; moved to another pane, the same SidebarPanelContent renders as that
	// pane's Navigation tab and the docked sidebar stands down. Phones keep the
	// sidebar Sheet regardless.
	const navigationItemId = workbenchState.items.find(
		(item) => item.source.kind === "navigation"
	)?.id;
	const navigationGroup = workbenchState.groups.find(
		(group) =>
			navigationItemId !== undefined && group.itemIds.includes(navigationItemId)
	);
	const navigationMoved =
		!(isMobile || osProduct) &&
		navigationGroup !== undefined &&
		navigationGroup.region !== "left";
	const navigationShown = navigationMoved
		? navigationGroup.region === "center" ||
			(workbenchState.openRegions[navigationGroup.region] &&
				navigationGroup.activeItemId === navigationItemId)
		: sidebarShown;
	const toggleNavigation = () => {
		if (!(navigationMoved && navigationItemId)) {
			toggleSidebar();
			return;
		}
		if (navigationShown && navigationGroup.region !== "center") {
			dispatchWorkbench({
				type: "region/hide",
				region: navigationGroup.region,
			});
		} else {
			dispatchWorkbench({ type: "item/activate", itemId: navigationItemId });
		}
	};
	// While Navigation lives in another pane the docked sidebar is not rendered,
	// so its state stays collapsed: the title bar then reserves room for the
	// window's nav cluster exactly as it does for a collapsed sidebar. Returning
	// Navigation to Left shows the docked sidebar again.
	const navigationWasMoved = useRef(navigationMoved);
	useEffect(() => {
		if (navigationMoved && open) {
			setOpen(false);
		} else if (navigationWasMoved.current && !navigationMoved) {
			setOpen(true);
		}
		navigationWasMoved.current = navigationMoved;
	}, [navigationMoved, open, setOpen]);
	return { navigationMoved, navigationShown, toggleNavigation };
}
