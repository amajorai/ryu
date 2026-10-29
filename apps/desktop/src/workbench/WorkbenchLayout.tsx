import { cn } from "@ryu/ui/lib/utils.ts";
import {
	WORKBENCH_DEFAULT_SIZES,
	WORKBENCH_SIZE_BOUNDS,
	type WorkbenchItem,
	type WorkbenchRegion as WorkbenchRegionName,
	type WorkbenchState,
} from "@ryu/workbench/model";
import {
	type CSSProperties,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { DesktopCenterSplitView } from "@/src/components/layout/SplitView.tsx";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import { WorkbenchEdgeDropTargets } from "./WorkbenchDropTargets.tsx";
import styles from "./WorkbenchLayout.module.css";
import { WorkbenchRegion } from "./WorkbenchRegion.tsx";
import { REGION_LABELS } from "./WorkbenchTabStrip.tsx";
import {
	type WorkbenchAddMenu,
	WorkbenchChromeProvider,
	type WorkbenchDragBridge,
} from "./workbench-chrome.tsx";
import { WorkbenchSlotProvider } from "./workbench-slots.tsx";
import {
	isNarrowWorkbench,
	type SurroundingRegion,
	usePublishWorkbenchViewport,
	type WorkbenchViewport,
	WorkbenchViewportProvider,
} from "./workbench-viewport.tsx";

type ResizableRegion = Exclude<WorkbenchRegionName, "center">;
type RegionSizes = Record<ResizableRegion, number>;
type WorkbenchGridStyle = CSSProperties & {
	"--workbench-bottom-size": string;
	"--workbench-left-size": string;
	"--workbench-right-size": string;
	"--workbench-columns": string;
	"--workbench-rows": string;
	"--workbench-bottom-column": string;
	"--workbench-left-row": string;
	"--workbench-right-row": string;
};

const RESIZE_DEFAULTS: RegionSizes = WORKBENCH_DEFAULT_SIZES;

const BOTTOM_GRID_COLUMNS = {
	center: "3 / 4",
	full: "1 / 6",
	left: "1 / 4",
	right: "3 / 6",
} as const;

export function workbenchCenterHasRouteItems(state: WorkbenchState): boolean {
	const routeItemIds = new Set(
		state.items.flatMap((item) =>
			item.source.kind === "route" ? [item.id] : []
		)
	);
	return state.groups
		.filter((group) => group.region === "center")
		.some((group) => group.itemIds.some((itemId) => routeItemIds.has(itemId)));
}

export interface WorkbenchLayoutProps {
	centerContent: ReactNode;
	centerGlobalOverlay?: ReactNode;
	centerOverlay?: ReactNode;
	onCloseItem?: (item: WorkbenchItem) => void;
	suppressCenterTabStrips?: boolean;
	suppressLeftRegion?: boolean;
}

export function CompatibilityWorkbenchFrame({
	addMenu,
	centerContent,
	centerGlobalOverlay,
	centerOverlay,
	drag,
	itemHost,
	onCloseItem,
	prepareItemForSplit,
	renderItemIcon,
}: {
	addMenu?: WorkbenchAddMenu;
	centerContent: ReactNode;
	centerGlobalOverlay?: ReactNode;
	centerOverlay: ReactNode;
	drag?: WorkbenchDragBridge;
	itemHost?: ReactNode;
	onCloseItem?: (item: WorkbenchItem) => void;
	prepareItemForSplit?: (itemId: string) => void;
	renderItemIcon?: (item: WorkbenchItem) => ReactNode;
}) {
	return (
		<WorkbenchChromeProvider
			addMenu={addMenu}
			drag={drag}
			// AppSidebar still owns Desktop navigation, so Left is not a target.
			leftAvailable={false}
			prepareItemForSplit={prepareItemForSplit}
			renderItemIcon={renderItemIcon}
		>
			<WorkbenchSlotProvider>
				{itemHost}
				<WorkbenchLayout
					centerContent={centerContent}
					centerGlobalOverlay={centerGlobalOverlay}
					centerOverlay={centerOverlay}
					onCloseItem={onCloseItem}
					// The legacy TitleBar remains Center's tab chrome until Task 6 adapts
					// route ownership, so do not reserve another strip above its canvas.
					suppressCenterTabStrips
					// AppSidebar still owns Desktop navigation through Task 8. Rendering the
					// Navigation workbench item beside it would reserve Left twice.
					suppressLeftRegion
				/>
			</WorkbenchSlotProvider>
		</WorkbenchChromeProvider>
	);
}

function clampRegionSize(region: ResizableRegion, size: number): number {
	const bounds = WORKBENCH_SIZE_BOUNDS[region];
	return Math.min(bounds.maximum, Math.max(bounds.minimum, size));
}

function ResizeBoundary({
	currentSize,
	onResizeStart,
	onRestoreDefault,
	onStep,
	orientation,
	region,
	style,
}: {
	currentSize: number;
	onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onRestoreDefault: () => void;
	onStep: (direction: -1 | 1) => void;
	orientation: "horizontal" | "vertical";
	region: ResizableRegion;
	style?: CSSProperties;
}) {
	const label = region[0]?.toUpperCase() + region.slice(1);
	const bounds = WORKBENCH_SIZE_BOUNDS[region];
	return (
		<div
			aria-label={`Resize ${label}`}
			aria-orientation={orientation}
			aria-valuemax={bounds.maximum}
			aria-valuemin={bounds.minimum}
			aria-valuenow={Math.round(currentSize)}
			className={cn(
				"group/resize relative z-20 touch-none bg-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset",
				orientation === "vertical"
					? "cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-3"
					: "cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-3"
			)}
			onDoubleClick={onRestoreDefault}
			onKeyDown={(event) => {
				const negativeKey =
					orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
				const positiveKey =
					orientation === "vertical" ? "ArrowRight" : "ArrowDown";
				if (event.key === negativeKey) {
					event.preventDefault();
					onStep(-1);
				} else if (event.key === positiveKey) {
					event.preventDefault();
					onStep(1);
				}
			}}
			onPointerDown={onResizeStart}
			role="separator"
			style={style}
			tabIndex={0}
		/>
	);
}

export function WorkbenchLayout({
	centerContent,
	centerGlobalOverlay,
	centerOverlay,
	onCloseItem,
	suppressCenterTabStrips = false,
	suppressLeftRegion = false,
}: WorkbenchLayoutProps) {
	const { dispatch, state } = useDesktopWorkbench();
	const [liveSizes, setLiveSizes] = useState<RegionSizes>(state.sizes);
	const resizeSessionRef = useRef<{
		cancel: () => void;
		settle: () => void;
	} | null>(null);

	useEffect(() => {
		if (!resizeSessionRef.current) {
			setLiveSizes(state.sizes);
		}
	}, [state.sizes]);

	useEffect(
		() => () => {
			resizeSessionRef.current?.cancel();
		},
		[]
	);

	const groupsForRegion = (region: WorkbenchRegionName) =>
		state.groups.filter((group) => group.region === region);
	const regionIsVisible = (region: WorkbenchRegionName) => {
		if (region === "center") {
			return true;
		}
		return (
			state.openRegions[region] &&
			groupsForRegion(region).some((group) => group.itemIds.length > 0)
		);
	};
	const leftOpen = !suppressLeftRegion && regionIsVisible("left");
	const rightOpen = regionIsVisible("right");
	const bottomOpen = regionIsVisible("bottom");

	// Narrow windows show Left/Right/Bottom as one overlay sheet at a time
	// instead of squeezing Center; the saved layout itself is untouched.
	const layoutRef = useRef<HTMLDivElement | null>(null);
	const [layoutWidth, setLayoutWidth] = useState(0);
	useEffect(() => {
		const element = layoutRef.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			setLayoutWidth(entry?.contentRect.width ?? 0);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const narrow = isNarrowWorkbench(
		layoutWidth,
		(leftOpen ? liveSizes.left + 1 : 0) + (rightOpen ? liveSizes.right + 1 : 0)
	);
	const focusedGroup = state.groups.find(
		(group) => group.id === state.focusedGroupId
	);
	const focusedRegion = focusedGroup?.region;
	const overlayRegion: SurroundingRegion | null =
		narrow &&
		focusedRegion !== undefined &&
		focusedRegion !== "center" &&
		{ bottom: bottomOpen, left: leftOpen, right: rightOpen }[focusedRegion]
			? focusedRegion
			: null;
	const firstCenterGroupId = state.groups.find(
		(group) => group.region === "center"
	)?.id;
	const viewport: WorkbenchViewport = {
		dismissOverlay: () => {
			const centerGroupId =
				state.centerTree.type === "leaf"
					? state.centerTree.groupId
					: firstCenterGroupId;
			if (centerGroupId) {
				dispatch({ type: "group/focus", groupId: centerGroupId });
			}
		},
		narrow,
		overlayRegion,
		showOverlay: (region) => {
			const activeItemId = groupsForRegion(region).find(
				(group) => group.activeItemId
			)?.activeItemId;
			if (activeItemId) {
				dispatch({ type: "item/activate", itemId: activeItemId });
			}
		},
	};
	usePublishWorkbenchViewport(viewport);
	const leftVisible = leftOpen && !narrow;
	const rightVisible = rightOpen && !narrow;
	const bottomVisible = bottomOpen && !narrow;
	const bottomGridColumn = BOTTOM_GRID_COLUMNS[state.bottomAlignment];
	// A side region runs the full height beside Bottom unless Bottom's alignment
	// spans underneath it, so no empty grid cells appear below Left or Right.
	const bottomSpansLeft =
		state.bottomAlignment === "full" || state.bottomAlignment === "left";
	const bottomSpansRight =
		state.bottomAlignment === "full" || state.bottomAlignment === "right";
	const leftGridRow = bottomVisible && !bottomSpansLeft ? "1 / 4" : "1 / 2";
	const rightGridRow = bottomVisible && !bottomSpansRight ? "1 / 4" : "1 / 2";

	const startResize = (
		region: ResizableRegion,
		event: ReactPointerEvent<HTMLDivElement>
	) => {
		event.preventDefault();
		resizeSessionRef.current?.settle();
		const boundary = event.currentTarget;
		const pointerId = event.pointerId;
		const startX = event.clientX;
		const startY = event.clientY;
		const startSize = liveSizes[region];
		let settledSize = startSize;
		let finished = false;
		const onPointerMove = (pointerEvent: PointerEvent) => {
			const delta =
				region === "left"
					? pointerEvent.clientX - startX
					: region === "right"
						? startX - pointerEvent.clientX
						: startY - pointerEvent.clientY;
			settledSize = clampRegionSize(region, startSize + delta);
			setLiveSizes((current) => ({ ...current, [region]: settledSize }));
		};
		const cleanup = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", settle);
			window.removeEventListener("pointercancel", settle);
			window.removeEventListener("blur", settle);
			boundary.removeEventListener("lostpointercapture", settle);
			if (boundary.isConnected && boundary.hasPointerCapture(pointerId)) {
				boundary.releasePointerCapture(pointerId);
			}
			resizeSessionRef.current = null;
		};
		const cancel = () => {
			if (finished) {
				return;
			}
			finished = true;
			cleanup();
		};
		const settle = () => {
			if (finished) {
				return;
			}
			finished = true;
			cleanup();
			dispatch({ type: "region/resize", region, size: settledSize });
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", settle);
		window.addEventListener("pointercancel", settle);
		window.addEventListener("blur", settle);
		boundary.addEventListener("lostpointercapture", settle);
		resizeSessionRef.current = { cancel, settle };
		try {
			boundary.setPointerCapture(pointerId);
		} catch {
			// Window pointer/blur fallbacks still settle the drag when capture is
			// unavailable (for example, a synthetic event in an embedded webview).
		}
	};

	const stepRegion = (region: ResizableRegion, direction: -1 | 1) => {
		const visualDirection = region === "left" ? direction : -direction;
		const size = clampRegionSize(
			region,
			liveSizes[region] + visualDirection * 10
		);
		setLiveSizes((current) => ({ ...current, [region]: size }));
		dispatch({ type: "region/resize", region, size });
	};

	const gridStyle: WorkbenchGridStyle = {
		"--workbench-bottom-column": bottomGridColumn,
		"--workbench-bottom-size": `${liveSizes.bottom}px`,
		"--workbench-left-row": leftGridRow,
		"--workbench-left-size": `${liveSizes.left}px`,
		"--workbench-right-row": rightGridRow,
		"--workbench-right-size": `${liveSizes.right}px`,
		"--workbench-columns": `${
			leftVisible ? "var(--workbench-left-size) 1px" : "0px 0px"
		} minmax(0, 1fr) ${
			rightVisible ? "1px var(--workbench-right-size)" : "0px 0px"
		}`,
		"--workbench-rows": `minmax(0, 1fr) ${
			bottomVisible ? "1px var(--workbench-bottom-size)" : "0px 0px"
		}`,
	};

	return (
		<WorkbenchViewportProvider value={viewport}>
			<div
				className={cn(
					styles.layout,
					"relative grid h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
				)}
				data-bottom-alignment={state.bottomAlignment}
				data-left-suppressed={suppressLeftRegion}
				data-narrow={narrow}
				ref={layoutRef}
				style={gridStyle}
			>
				{leftVisible ? (
					<WorkbenchRegion
						groups={groupsForRegion("left")}
						onCloseItem={onCloseItem}
						region="left"
					/>
				) : null}
				{leftVisible ? (
					<ResizeBoundary
						currentSize={liveSizes.left}
						onResizeStart={(event) => startResize("left", event)}
						onRestoreDefault={() =>
							dispatch({
								type: "region/resize",
								region: "left",
								size: RESIZE_DEFAULTS.left,
							})
						}
						onStep={(direction) => stepRegion("left", direction)}
						orientation="vertical"
						region="left"
					/>
				) : null}
				<DesktopCenterSplitView
					collapseToFocused={narrow}
					compatibilityContent={centerContent}
					globalOverlay={centerGlobalOverlay}
					onCloseItem={onCloseItem}
					overlay={centerOverlay}
					suppressFocusedTabStrip={suppressCenterTabStrips}
				/>
				{rightVisible ? (
					<ResizeBoundary
						currentSize={liveSizes.right}
						onResizeStart={(event) => startResize("right", event)}
						onRestoreDefault={() =>
							dispatch({
								type: "region/resize",
								region: "right",
								size: RESIZE_DEFAULTS.right,
							})
						}
						onStep={(direction) => stepRegion("right", direction)}
						orientation="vertical"
						region="right"
					/>
				) : null}
				{rightVisible ? (
					<WorkbenchRegion
						groups={groupsForRegion("right")}
						onCloseItem={onCloseItem}
						region="right"
					/>
				) : null}
				{bottomVisible ? (
					<ResizeBoundary
						currentSize={liveSizes.bottom}
						onResizeStart={(event) => startResize("bottom", event)}
						onRestoreDefault={() =>
							dispatch({
								type: "region/resize",
								region: "bottom",
								size: RESIZE_DEFAULTS.bottom,
							})
						}
						onStep={(direction) => stepRegion("bottom", direction)}
						orientation="horizontal"
						region="bottom"
					/>
				) : null}
				{bottomVisible ? (
					<WorkbenchRegion
						groups={groupsForRegion("bottom")}
						onCloseItem={onCloseItem}
						region="bottom"
					/>
				) : null}
				{overlayRegion ? (
					<>
						<button
							aria-label={`Close ${REGION_LABELS[overlayRegion]}`}
							className="absolute inset-0 z-40 cursor-default bg-background/50 backdrop-blur-[1px]"
							data-workbench-overlay-scrim={overlayRegion}
							onClick={viewport.dismissOverlay}
							tabIndex={-1}
							type="button"
						/>
						<WorkbenchRegion
							className={cn(styles.overlay, "z-50 shadow-xl")}
							groups={groupsForRegion(overlayRegion)}
							onCloseItem={onCloseItem}
							region={overlayRegion}
						/>
					</>
				) : null}
				<WorkbenchEdgeDropTargets
					visible={{ bottom: bottomVisible, right: rightVisible }}
				/>
			</div>
		</WorkbenchViewportProvider>
	);
}
