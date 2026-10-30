import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { motion } from "motion/react";
import type { PointerEventHandler, ReactNode } from "react";
import { ISLAND_SPRING } from "./island-config.ts";
import {
	type IslandGeometryStyle,
	notchSurfaceGeometryStyle,
} from "./island-shell-geometry.ts";

/**
 * The Island drawn as an extension of the hardware notch: a black surface that
 * grows down from the notch, showing a launcher row while collapsed or idle and
 * the live Island content otherwise.
 */
export function IslandNotchSurface({
	appName,
	children,
	footprintHeight,
	footprintWidth,
	isCollapsed,
	notchHeight,
	onOpenPanel,
	onPointerEnter,
	onPointerLeave,
	showLauncher,
}: {
	appName: string | null;
	children: ReactNode;
	footprintHeight: number;
	footprintWidth: number;
	isCollapsed: boolean;
	notchHeight: number;
	onOpenPanel: () => void;
	onPointerEnter: PointerEventHandler<HTMLDivElement>;
	onPointerLeave: PointerEventHandler<HTMLDivElement>;
	showLauncher: boolean;
}) {
	const notchGeometryStyle: IslandGeometryStyle = {
		"--island-surface-height": `${notchHeight}px`,
	};
	return (
		<div className="flex h-full w-full justify-center">
			<motion.div
				animate={{ width: footprintWidth, height: footprintHeight }}
				className="dark island-surface-radius flex flex-col overflow-hidden bg-black text-white"
				data-island-notch=""
				initial={false}
				onPointerEnter={onPointerEnter}
				onPointerLeave={onPointerLeave}
				style={notchSurfaceGeometryStyle}
				transition={ISLAND_SPRING}
			>
				<div
					aria-hidden="true"
					className="island-surface-height shrink-0"
					style={notchGeometryStyle}
				/>
				{showLauncher ? (
					<button
						aria-label="Open Island"
						className="flex min-h-9 w-full flex-1 items-center justify-center gap-2 px-4 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
						onClick={onOpenPanel}
						type="button"
					>
						<RyuLogo size="24px" variant="eyes" />
						{isCollapsed ? "" : (appName ?? "Ryu")}
					</button>
				) : (
					<div className="flex min-h-0 flex-1 flex-col px-3 pb-2">
						{children}
					</div>
				)}
			</motion.div>
		</div>
	);
}
