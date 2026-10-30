import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties, ReactNode, RefObject } from "react";
import panelStyles from "../WorkspacePanels.module.css";
import type { WorkspacePanelsProps } from "./workspace-panels-types.ts";

export interface WorkspaceDockStyle extends CSSProperties {
	"--workspace-display"?: "flex" | "block" | "none";
	"--workspace-height"?: string;
	"--workspace-pointer-events"?: "auto" | "none";
	"--workspace-right"?: string;
	"--workspace-transform"?: "translateX(0)" | "translateX(100%)";
	"--workspace-transition"?: string;
	"--workspace-width"?: string;
}

// How long the hover-peek stays after the pointer leaves (matches the left sidebar).
export const PEEK_HIDE_DELAY = 200;

// The Pinned summary column: the panel's fixed w-72 plus the same 12px gutter
// the right dock uses.
export const PINNED_PANEL_WIDTH = 288;
export const PANEL_GUTTER = 12;
// When docking the pinned column would leave the chat narrower than this, the
// panel auto-demotes to a floating overlay instead (stops pushing content).
export const MIN_CHAT_WIDTH = 520;

// Slide/ease used when docking or undocking a panel. Suppressed mid-drag so
// the resize stays 1:1 with the pointer.
export const DOCK_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

export interface WorkspaceDockLayoutInput
	extends Pick<
		WorkspacePanelsProps,
		"bottomOpen" | "children" | "renderPinnedSummary" | "rightOpen"
	> {
	bottomCard: (onClosePanel: () => void) => ReactNode;
	bottomResizeHandle: ReactNode;
	bottomResizing: boolean;
	closeBottom: () => void;
	closeRight: () => void;
	containerRef: RefObject<HTMLDivElement | null>;
	dockTop: string;
	effectiveBottomHeight: number;
	floatingChrome: boolean;
	hideRightPeek: () => void;
	isMobile: boolean;
	pinnedColumnWidth: number;
	pinnedDocked: boolean;
	pinnedFloating: boolean;
	rightCard: (onClosePanel: () => void) => ReactNode;
	rightDockWidth: number;
	rightPanelWidth: number;
	rightResizeHandle: ReactNode;
	rightResizing: boolean;
	rightVisible: boolean;
	showRightPeek: () => void;
	titleBarClearsContent: boolean;
}

/**
 * The dock frame: the chat column with the bottom dock, the in-flow spacers
 * that push the chat, the pinned-summary column (docked or floating) and the
 * right dock with its hover-peek edge.
 */
export function renderWorkspaceDockLayout({
	bottomCard,
	bottomOpen,
	bottomResizeHandle,
	bottomResizing,
	children,
	closeBottom,
	closeRight,
	containerRef,
	dockTop,
	effectiveBottomHeight,
	floatingChrome,
	hideRightPeek,
	isMobile,
	pinnedColumnWidth,
	pinnedDocked,
	pinnedFloating,
	renderPinnedSummary,
	rightCard,
	rightDockWidth,
	rightOpen,
	rightPanelWidth,
	rightResizeHandle,
	rightResizing,
	rightVisible,
	showRightPeek,
	titleBarClearsContent,
}: WorkspaceDockLayoutInput) {
	return (
		// Outer row: [ chat column (+ bottom panel) ] [ pinned spacer ] [ right
		// spacer ] · the pinned-summary and right panels are edge-pinned absolutes
		<div className="relative flex h-full overflow-hidden" ref={containerRef}>
			{/* Chat column — shrinks when the bottom/right panels are docked */}
			<div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
				<div className="min-h-0 flex-1 overflow-hidden">{children}</div>

				{/* In-flow spacer: animates the chat's height when the bottom panel docks */}
				<div
					className={cn("shrink-0", panelStyles.bottomSpacer)}
					style={
						// SAFETY: satisfies validates full React CSSProperties and the finite workspace CSS variable slots; this checked-owner cast only removes fresh-literal metadata.
						{
							"--workspace-height": `${bottomOpen ? effectiveBottomHeight + 12 : 0}px`,
							"--workspace-transition": bottomResizing
								? "none"
								: `height 300ms ${DOCK_EASE}`,
						} satisfies WorkspaceDockStyle as WorkspaceDockStyle
					}
				/>

				{/* The one bottom-panel instance — pinned to the bottom edge. It has no
				    hover-peek and stays hidden until the toolbar toggle opens it. Closed
				    means display:none (fully out of layout) rather than an off-screen
				    transform: translateY(100%) only clears the viewport once the column
				    has reached full height, so on first mount the panel would otherwise
				    flash visible until a later reflow. */}
				<div
					className={cn(
						"absolute inset-x-0 bottom-0 z-20 flex flex-col",
						panelStyles.bottomPanel
					)}
					style={
						// SAFETY: satisfies validates full React CSSProperties and the finite workspace CSS variable slots; this checked-owner cast only removes fresh-literal metadata.
						{
							"--workspace-height": `${effectiveBottomHeight + 12}px`,
							"--workspace-display": bottomOpen ? "flex" : "none",
						} satisfies WorkspaceDockStyle as WorkspaceDockStyle
					}
				>
					{bottomResizeHandle}
					{bottomCard(closeBottom)}
				</div>
			</div>

			{/* In-flow spacer: animates the chat's width when the pinned summary
			    column docks (stacked left of the right panel's spacer) */}
			<div
				className={cn("shrink-0", panelStyles.widthSpacer)}
				style={
					// SAFETY: satisfies validates full React CSSProperties and the finite workspace CSS variable slots; this checked-owner cast only removes fresh-literal metadata.
					{
						"--workspace-width": `${pinnedDocked ? pinnedColumnWidth : 0}px`,
						"--workspace-transition": rightResizing
							? "none"
							: `width 300ms ${DOCK_EASE}`,
					} satisfies WorkspaceDockStyle as WorkspaceDockStyle
				}
			/>

			{/* In-flow spacer: animates the chat's width when the right panel docks.
			    Stays at zero while the panel is an overlay (mobile) — there is
			    nothing to push the chat out of the way of. */}
			<div
				className={cn("shrink-0", panelStyles.widthSpacer)}
				style={
					// SAFETY: satisfies validates full React CSSProperties and the finite workspace CSS variable slots; this checked-owner cast only removes fresh-literal metadata.
					{
						"--workspace-width": `${rightDockWidth}px`,
						"--workspace-transition": rightResizing
							? "none"
							: `width 300ms ${DOCK_EASE}`,
					} satisfies WorkspaceDockStyle as WorkspaceDockStyle
				}
			/>

			{/* The docked pinned-summary column — edge-pinned like the right panel
			    but offset by the right dock's width so the two stack. It sits under
			    the right panel (z-10 < z-20) so the right panel's slide-out passes
			    over it. display:none when hidden, same as the bottom panel, so it
			    never flashes on first mount. */}
			<div
				className={cn(
					"absolute bottom-0 z-10",
					dockTop,
					panelStyles.pinnedPanel
				)}
				style={
					// SAFETY: satisfies validates full React CSSProperties and the finite workspace CSS variable slots; this checked-owner cast only removes fresh-literal metadata.
					{
						"--workspace-right": `${rightDockWidth}px`,
						"--workspace-width": `${pinnedColumnWidth}px`,
						"--workspace-display": pinnedDocked ? "block" : "none",
						"--workspace-transition": rightResizing
							? "none"
							: `right 300ms ${DOCK_EASE}`,
					} satisfies WorkspaceDockStyle as WorkspaceDockStyle
				}
			>
				<div
					className={cn(
						"h-full overflow-y-auto border-border border-l px-3 pt-6",
						floatingChrome && "pb-2"
					)}
				>
					{pinnedDocked && renderPinnedSummary?.({ floating: false })}
				</div>
			</div>

			{/* Floating pinned summary — the auto-demoted overlay used when docking
			    would leave the chat too narrow. Overlays the message column (no
			    spacer), so it dismisses on press-away; the titlebar toggle brings
			    it back. */}
			{pinnedFloating && (
				<div
					className={cn(
						"pointer-events-none absolute z-20",
						panelStyles.floatingPinned,
						titleBarClearsContent ? "top-[64px]" : "top-0"
					)}
					style={
						// SAFETY: satisfies validates full React CSSProperties and the finite workspace CSS variable slots; this checked-owner cast only removes fresh-literal metadata.
						{
							"--workspace-right": `${rightDockWidth + PANEL_GUTTER}px`,
						} satisfies WorkspaceDockStyle as WorkspaceDockStyle
					}
				>
					{renderPinnedSummary?.({ floating: true })}
				</div>
			)}

			{/* The one right-panel instance — pinned to the right edge, slides via
			    transform for both docking and hover-peek. It starts BELOW the frosted
			    titlebar so the full-width bar keeps its right-side panel-toggle
			    buttons visible and clickable while the panel is open — otherwise this
			    z-20 layer covers the z-10 titlebar and you can no longer reach the
			    button that hides it. Floating chrome clears the titlebar's top-2
			    offset (58px); inset chrome sits flush under h-12. */}
			<div
				aria-hidden={!rightVisible}
				className={cn(
					"absolute right-0 bottom-0 z-20 flex flex-row",
					dockTop,
					panelStyles.rightPanel
				)}
				inert={!rightVisible}
				onMouseEnter={rightOpen || isMobile ? undefined : showRightPeek}
				onMouseLeave={rightOpen || isMobile ? undefined : hideRightPeek}
				style={
					// SAFETY: satisfies validates full React CSSProperties and the finite workspace CSS variable slots; this checked-owner cast only removes fresh-literal metadata.
					{
						"--workspace-width": `${rightPanelWidth}px`,
						"--workspace-transform": rightVisible
							? "translateX(0)"
							: "translateX(100%)",
						"--workspace-pointer-events": rightVisible ? "auto" : "none",
						"--workspace-transition": rightResizing
							? "none"
							: `transform 300ms ${DOCK_EASE}`,
					} satisfies WorkspaceDockStyle as WorkspaceDockStyle
				}
			>
				{!isMobile && rightResizeHandle}
				{rightCard(closeRight)}
			</div>

			{/* Right edge hover-zone: reveals the peek while the panel is closed.
			    Starts below the titlebar so its z-30 strip never sits over the bar's
			    right-side action buttons. Pointer-only, so it is absent on mobile —
			    where it would also swallow the edge-swipe back gesture. */}
			{!(rightOpen || isMobile) && (
				<div
					className={cn("absolute right-0 bottom-0 z-30 w-2", dockTop)}
					onMouseEnter={showRightPeek}
					onMouseLeave={hideRightPeek}
				/>
			)}
		</div>
	);
}
