import type {
	CSSProperties,
	CSSProperties as LayoutCSSProperties,
} from "react";
import type { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type { OsWindow } from "../../os/OsDesktopSurface.tsx";

export interface LayoutCssVariables extends CSSProperties {
	"--ryu-titlebar-inset"?: string;
	"--sidebar-width"?: string;
}

export const isMac = navigator.userAgent.includes("Mac");

export const EMPTY_OS_WINDOWS: OsWindow[] = [];

/** Docked-sidebar resize bounds. */
export const SIDEBAR_MIN_WIDTH = 180;

export const SIDEBAR_MAX_WIDTH = 480;

/**
 * Collapse the sidebar when the rail drag was HEADED below this width, even if
 * the pointer lifted before reaching it. Sits under the minimum so only a
 * deliberate inward gesture — a real flick, or a drag that already fought the
 * rubber-band past the min — can trigger it.
 */
export const SIDEBAR_COLLAPSE_PROJECTION = 140;

export type OpenTab = ReturnType<typeof useTabsContext>["openTab"];

export interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-opacity"?: string | number;
	"--desktop-inline2-left"?: string | number;
	"--desktop-inline3-width"?: string | number;
	"--desktop-inline4-opacity"?: string | number;
	"--desktop-inline4-pointer-Events"?: string | number;
	"--desktop-inline4-transform"?: string | number;
	"--desktop-inline4-width"?: string | number;
	"--desktop-inline7-padding-Right"?: string | number;
}
