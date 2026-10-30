import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	WORKBENCH_DEFAULT_SIZES,
	WORKBENCH_SIZE_BOUNDS,
	type WorkbenchRegion as WorkbenchRegionName,
} from "@ryu/workbench/model";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

export type ResizableRegion = Exclude<WorkbenchRegionName, "center">;

export type RegionSizes = Record<ResizableRegion, number>;

export const RESIZE_DEFAULTS: RegionSizes = WORKBENCH_DEFAULT_SIZES;

export function clampRegionSize(region: ResizableRegion, size: number): number {
	const bounds = WORKBENCH_SIZE_BOUNDS[region];
	return Math.min(bounds.maximum, Math.max(bounds.minimum, size));
}

export function ResizeBoundary({
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
	const tl = useLiteralMessages();
	const label = region[0]?.toUpperCase() + region.slice(1);
	const bounds = WORKBENCH_SIZE_BOUNDS[region];
	return (
		<div
			aria-label={tl("Resize {label}", { label })}
			aria-orientation={orientation}
			aria-valuemax={bounds.maximum}
			aria-valuemin={bounds.minimum}
			aria-valuenow={Math.round(currentSize)}
			className={cn(
				"group/resize relative z-20 touch-none bg-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
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
