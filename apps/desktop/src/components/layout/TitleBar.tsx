import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useHotkey } from "@ryu/hotkeys/react";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { EdgeScrollChevrons } from "@ryu/ui/components/edge-scroller.tsx";
import { ProgressiveBlur } from "@ryu/ui/components/progressive-blur.tsx";
import { useSidebar } from "@ryu/ui/components/sidebar.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties as LayoutCSSProperties } from "react";
import { lazy, Suspense, useEffect, useRef, type WheelEvent } from "react";
import { TabSearchDialog } from "@/src/components/layout/tab-search-dialog.tsx";
import { findSplit, useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useTitleBarContext } from "@/src/contexts/TitleBarContext.tsx";
import { useFloatingTabs } from "@/src/hooks/useFloatingTabs.ts";
import { useMouseNavigationButtons } from "@/src/hooks/useMouseNavigationButtons.ts";
import { useActiveSeason } from "@/src/hooks/useSeasonalEffects.ts";
import { useTabCycleHotkeys } from "@/src/hooks/useTabCycleHotkeys.ts";
import { useTabDropdown } from "@/src/hooks/useTabDropdown.ts";
import { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useTabSearchButton } from "@/src/hooks/useTabSearchButton.ts";
import { useTabSizing } from "@/src/hooks/useTabSizing.ts";
import { useOptionalDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { buildSegments } from "../shell/title-bar/tab-segments.ts";
import {
	TabDropdownStrip,
	TabStrip,
	TitleBarActions,
} from "../shell/title-bar/tab-strip.tsx";
import {
	TabStripContextMenuContent,
	TitleBarDragContextMenu,
} from "../shell/title-bar/title-bar-menus.tsx";
import { useTitleBarAutoHide } from "../shell/title-bar/use-title-bar-auto-hide.ts";
import layoutStyles from "./TitleBar.module.css";

export { GroupHeaderPill } from "../shell/title-bar/tab-brackets.tsx";
export { TabGlyph, useTabBusy } from "../shell/title-bar/tab-glyph.tsx";
export { useColdChatTabPrefetch } from "../shell/title-bar/tab-menu-items.tsx";

// The particle layer is opt-in decoration: load it only once a season is on.
const SeasonalParticles = lazy(() =>
	import("./SeasonalEffects.tsx").then((module) => ({
		default: module.SeasonalParticles,
	}))
);

// legacy component
interface TitleBarProps {
	navClusterReserve: string;
	pageActionsMargin: string;
}

export function TitleBar({
	navClusterReserve,
	pageActionsMargin,
}: TitleBarProps) {
	const { t } = useI18n();
	const { open } = useSidebar();
	const activeSeason = useActiveSeason();
	// At phone widths the sidebar is never docked, so the strip always has to
	// leave room for the fixed nav cluster (see Layout) — but only for the two
	// buttons it keeps there, not the full desktop four-button + traffic-light
	// reservation.
	const isMobile = useIsMobile();
	const { actions } = useTitleBarContext();
	const activateTab = useTabSelector((state) => state.activateTab);
	const allTabs = useTabSelector((state) => state.tabs);
	const groups = useTabSelector((state) => state.groups);
	const globalActiveTabId = useTabSelector((state) => state.activeTabId);
	const openTab = useTabSelector((state) => state.openTab);
	const closeTab = useTabSelector((state) => state.closeTab);
	const restoreTab = useTabSelector((state) => state.restoreTab);
	const hasClosedTabs = useTabSelector((state) => state.hasClosedTabs);
	const goBack = useTabSelector((state) => state.goBack);
	const goForward = useTabSelector((state) => state.goForward);
	const splits = useTabSelector((state) => state.splits);
	const splitTabs = useTabSelector((state) => state.splitTabs);
	const unsplit = useTabSelector((state) => state.unsplit);
	const workbench = useOptionalDesktopWorkbench();
	const workbenchState = workbench?.state;
	const focusedCenterGroup = workbenchState?.groups.find(
		(group) =>
			group.id === workbenchState?.focusedGroupId &&
			group.region === "center" &&
			group.activeItemId !== null
	);
	const displayedCenterGroup =
		focusedCenterGroup ??
		workbenchState?.groups.find(
			(group) => group.region === "center" && group.activeItemId !== null
		) ??
		workbenchState?.groups.find((group) => group.region === "center");
	const focusedItemIds = new Set(displayedCenterGroup?.itemIds ?? []);
	const tabs = workbenchState
		? allTabs.filter((tab) => focusedItemIds.has(tab.id))
		: allTabs;
	const activeTabId = displayedCenterGroup?.activeItemId ?? globalActiveTabId;
	const scrollRef = useRef<HTMLDivElement>(null);
	// Only the compact horizontal mode owns a title-bar tab strip. Vertical tabs
	// move the list into the sidebar; scroll and canvas modes own the live center
	// surface and leave a drag-region spacer here.
	const tabLayout = useTabLayout();
	const tabSizing = useTabSizing();
	const [tabDropdownEnabled, setTabDropdownEnabled] = useTabDropdown();
	const [floatingTabs, setFloatingTabs] = useFloatingTabs();
	const [tabSearchButtonVisible, setTabSearchButtonVisible] =
		useTabSearchButton();
	const {
		autoHideTitleBar,
		setAutoHideTitleBar,
		isFullscreen,
		effectiveAutoHide,
		handleToggleFullscreen,
		showTitleBarPeek,
		scheduleTitleBarHide,
		onTitleBarMenuOpenChange,
		titleBarVisible,
	} = useTitleBarAutoHide(isMobile);

	const pinnedTabs = tabs.filter((t) => t.pinned);
	const unpinnedTabs = tabs.filter((t) => !t.pinned);
	const segments = buildSegments(unpinnedTabs, groups, splits);

	// Route actions stay with the focused Center group's TitleBar. Additional
	// groups have local strips, so there is no duplicate pane badge to host them.
	const activeInSplit = false;

	const activeTab = tabs.find((t) => t.id === activeTabId);
	const activeTabIndex = tabs.findIndex((t) => t.id === activeTabId);

	// The Tauri decorum titlebar fix lives in App.tsx now — it runs permanently
	// (a MutationObserver + window focus/resize) from the always-mounted root, so
	// decorum can never re-assert a full-width bar over this titlebar. The old
	// copy here was a 5s interval that left the titlebar dead after any later
	// revert; it was removed to keep a single source of truth.

	// Scroll newly-activated tab into view
	useEffect(() => {
		if (!scrollRef.current) {
			return;
		}
		const activeEl = scrollRef.current.querySelector("[data-active='true']");
		activeEl?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
			behavior: "smooth",
		});
		// `activeTabId` is load-bearing — it is the "newly-activated" half. Without
		// it this runs once at mount and a newly activated tab is never scrolled
		// into view.
	}, [activeTabId]);

	// Translate vertical wheel into horizontal scroll for the tab strip, since
	// its scrollbar is hidden to keep the tabs aligned with the rest of the
	// titlebar. Trackpad horizontal gestures (deltaX) pass through untouched.
	const handleTabStripWheel = (e: WheelEvent<HTMLDivElement>) => {
		const el = scrollRef.current;
		if (!el || el.scrollWidth <= el.clientWidth) {
			return;
		}
		if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
			el.scrollLeft += e.deltaY;
		}
	};

	const handleNewTab = () => {
		openTab("/chat", { forceNew: true });
	};

	// Toggle a split on the active tab: if it's already split, collapse the split;
	// otherwise open a fresh chat beside it. Shared by the shortcut + strip menu.
	const toggleSplitActive = () => {
		if (!activeTabId) {
			return;
		}
		if (findSplit(tabs, splits, activeTabId)) {
			unsplit(activeTabId);
			return;
		}
		const id = openTab("/chat", { forceNew: true });
		splitTabs([activeTabId, id]);
	};

	// Tab, window, and navigation shortcuts route through the unified hotkey
	// system, so they are customizable in Settings → Keyboard Shortcuts and share
	// one dispatch listener with every other surface.
	useHotkey("tab.close", () => {
		if (activeTabId) {
			closeTab(activeTabId);
		}
	});
	useHotkey("tab.new", handleNewTab);
	useHotkey("tab.restore", restoreTab);
	useHotkey("tab.split-toggle", toggleSplitActive);
	useTabCycleHotkeys();
	useHotkey("nav.back", goBack);
	useHotkey("nav.forward", goForward);
	useMouseNavigationButtons(goBack, goForward);

	const cssVariables1: LayoutCssVariables = {
		"--desktop-inline1-pointer-Events": titleBarVisible ? "none" : "auto",
	};
	const cssVariables2: LayoutCssVariables = {
		"--desktop-inline2-transform": titleBarVisible
			? "translateY(0)"
			: "translateY(calc(-100% - 12px))",
		"--desktop-inline2-opacity": titleBarVisible ? 1 : 0,
		"--desktop-inline2-pointer-Events": titleBarVisible ? "auto" : "none",
	};
	return (
		<>
			{/* Top-edge hover zone — catches the cursor when the bar is tucked away
			    so it can slide back in. Always mounted while auto-hide is on; the
			    bar itself takes over once peeked (pointer-events resume). */}
			{effectiveAutoHide && (
				<div
					aria-hidden
					className={cn(
						"absolute top-0 left-0 z-10 h-4 w-full",
						layoutStyles.inline1
					)}
					onMouseEnter={showTitleBarPeek}
					onMouseLeave={scheduleTitleBarHide}
					style={cssVariables1}
				/>
			)}
			<div
				// One 48px (h-12) bar, offset 8px from the window top so its row
				// lines up with the sidebar node selector and the fixed nav cluster
				// (see Layout) at 32px. Both sidebar variants now start the content
				// at the window edge, so the offset no longer depends on the variant.
				//
				// The offset is PADDING, not a `top`: `data-tauri-drag-region` lives
				// on this element, so anything above its box would not drag. `pt-2`
				// keeps the topmost 8px band inside the drag region.
				className={cn(
					"absolute top-0 left-0 z-10 flex h-14 w-full items-center px-2 pt-2",
					// The auto-hide rule reads variables set only while auto-hide is
					// on. Without them `pointer-events` is invalid and inherits, so
					// inside the workbench overlay (`pointer-events-none`) the bar
					// would render but never take a click.
					effectiveAutoHide && layoutStyles.inline2
				)}
				data-tab-appearance={floatingTabs ? "floating" : "morphing"}
				data-tauri-drag-region
				onMouseEnter={effectiveAutoHide ? showTitleBarPeek : undefined}
				onMouseLeave={effectiveAutoHide ? scheduleTitleBarHide : undefined}
				style={effectiveAutoHide ? cssVariables2 : undefined}
			>
				{/* The shared page inset includes this short fade below the controls.
				    Resting content starts clear; scrolling content fades under the glass. */}
				<ProgressiveBlur
					backgroundColor="var(--background)"
					blurAmount="16px"
					height="calc(100% + var(--spacing) * 6)"
					position="top"
				/>
				{/* Seasonal particles drift down the bar on holidays. They sit ABOVE
				    the background layer and BELOW the z-10 controls row, so they never
				    cover a tab label, and they fade out towards the bottom edge so the
				    bar does not end in a hard line of emoji. */}
				{activeSeason && (
					<Suspense fallback={null}>
						<SeasonalParticles
							color={activeSeason.color}
							count={30}
							emoji={activeSeason.emoji}
							fadeBottom
							maxOpacity={1}
							maxSize={activeSeason.maxSize ?? 30}
							minOpacity={0}
							minSize={activeSeason.minSize ?? 1}
							zIndex={1}
						/>
					</Suspense>
				)}
				<div
					className="relative z-10 flex h-full w-full flex-row items-center gap-2"
					data-tauri-drag-region
				>
					{/* Back/forward + the sidebar toggle are pinned at the window's
					    top-left (fixed, in Layout) so the whole nav cluster survives
					    sidebar collapse and never eats tab-strip space. When the sidebar
					    is docked the cluster floats over the sidebar and the strip needs
					    no offset. When collapsed the titlebar spans the full window, so
					    reserve room on the left for the cluster (and, on macOS, the
					    traffic lights). */}
					{(isMobile || !open) && (
						<div
							aria-hidden
							className={cn("shrink-0", navClusterReserve)}
							data-tauri-drag-region
						/>
					)}

					{/* Tab strip — scrollable, fills remaining space. Hidden whenever a
					    different tab view owns the tabs. */}
					{tabLayout === "horizontal" ? (
						<ContextMenu onOpenChange={onTitleBarMenuOpenChange}>
							<div className="flex min-w-0 flex-1 items-center">
								{tabDropdownEnabled ? (
									<TabDropdownStrip
										activateTab={activateTab}
										activeTab={activeTab}
										activeTabId={activeTabId}
										closeTab={closeTab}
										handleNewTab={handleNewTab}
										tabs={tabs}
									/>
								) : (
									<>
										<ContextMenuTrigger
											className="flex min-w-0 flex-1 items-center"
											data-tauri-drag-region
										>
											{/* Wrapper sizes to content but is capped at the available width
											 (max-w 100%). So the + button follows the last tab while they
								    fit, and once the tabs' total content would exceed the bar the
								    wrapper caps at 100% — in "fit" mode the shrinkable tabs then
								    trim to fit, in "fixed" mode they keep size and the strip
								    scrolls. */}
											<div
												className={cn(
													"flex min-w-0 items-center",
													layoutStyles.inline3
												)}
											>
												{/* Fixed h-8 clip wrapper: the inner strip is allowed to grow
								    taller than h-8 (via pb-8) so the horizontal scrollbar renders
								    in the bottom padding band, BELOW the 32px visible row, and is
								    then clipped away by this overflow-hidden box. That keeps the
								    scrollbar from ever reserving space inside the tab row and
								    squashing the tabs (a WebView2 quirk hiding alone didn't fully
								    cure). items-start so the inner box isn't stretched, so its
								    align-items:center then centers the tabs in the unpadded 32px
								    content box, leaving the padding band (and its scrollbar) below.
								    Overflow is also reached via the wheel handler + scrollIntoView,
								    and by the hover-revealed edge chevrons (`EdgeScrollChevrons`) —
								    the same affordance the Store/Library section strips wear, which
								    is why the group is named `edge-scroller` here too. */}
												<div className="group/edge-scroller relative flex h-8 min-w-0 flex-1 items-start overflow-hidden">
													<EdgeScrollChevrons scrollRef={scrollRef} />
													<TabStrip
														activeTabId={activeTabId}
														onWheel={handleTabStripWheel}
														pinnedTabs={pinnedTabs}
														scrollRef={scrollRef}
														segments={segments}
													/>
												</div>

												{/* New tab button — outside the scroll container, always visible */}
												<Button
													aria-label={t(
														"shell.new-chat-tab",
														undefined,
														"New chat tab"
													)}
													className="ml-0.5 shrink-0"
													data-tauri-drag-region={false}
													onClick={handleNewTab}
													size="icon-sm"
													variant="ghost-muted"
												>
													<HugeiconsIcon className="size-4" icon={Add01Icon} />
												</Button>
											</div>
										</ContextMenuTrigger>
										{tabSearchButtonVisible && (
											<TabSearchDialog
												activateTab={activateTab}
												activeTabId={activeTabId}
												closeTab={closeTab}
												floatingTabs={floatingTabs}
												onHide={() => setTabSearchButtonVisible(false)}
												tabs={tabs}
											/>
										)}
									</>
								)}
							</div>
							<TabStripContextMenuContent
								activeTabId={activeTabId}
								activeTabIndex={activeTabIndex}
								autoHideTitleBar={autoHideTitleBar}
								closeTab={closeTab}
								floatingTabs={floatingTabs}
								handleNewTab={handleNewTab}
								handleToggleFullscreen={handleToggleFullscreen}
								hasClosedTabs={hasClosedTabs}
								isFullscreen={isFullscreen}
								restoreTab={restoreTab}
								setAutoHideTitleBar={setAutoHideTitleBar}
								setFloatingTabs={setFloatingTabs}
								setTabDropdownEnabled={setTabDropdownEnabled}
								setTabSearchButtonVisible={setTabSearchButtonVisible}
								splits={splits}
								tabDropdownEnabled={tabDropdownEnabled}
								tabLayout={tabLayout}
								tabSearchButtonVisible={tabSearchButtonVisible}
								tabSizing={tabSizing}
								tabs={tabs}
								toggleSplitActive={toggleSplitActive}
							/>
						</ContextMenu>
					) : (
						<TitleBarDragContextMenu
							autoHideTitleBar={autoHideTitleBar}
							handleToggleFullscreen={handleToggleFullscreen}
							isFullscreen={isFullscreen}
							onOpenChange={onTitleBarMenuOpenChange}
							setAutoHideTitleBar={setAutoHideTitleBar}
							tabLayout={tabLayout}
						/>
					)}

					{/* Spacer so actions hug the right edge */}
					<div
						className={cn("flex-shrink-0 flex-grow-0", layoutStyles.inline4)}
						data-tauri-drag-region
					/>

					{/* Right-side page actions — offset clears Windows titlebar buttons.
				    Hidden when the active tab is in a split: the focused pane shows
				    those actions beside its title pill instead. */}
					{actions && !activeInSplit && (
						<TitleBarActions pageActionsMargin={pageActionsMargin}>
							{actions}
						</TitleBarActions>
					)}
				</div>
			</div>
		</>
	);
}

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-pointer-Events"?: string | number;
	"--desktop-inline2-opacity"?: string | number;
	"--desktop-inline2-pointer-Events"?: string | number;
	"--desktop-inline2-transform"?: string | number;
}
