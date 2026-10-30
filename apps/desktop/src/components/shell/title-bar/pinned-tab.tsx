import {
	Cancel01Icon,
	Copy01Icon,
	PinOffIcon,
	ZzzIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { TabLayoutMenuItems } from "@/src/components/layout/appearance-context-menu.tsx";
import { MorphingTabSurface } from "@/src/components/layout/MorphingTabSurface.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useFloatingTabs } from "@/src/hooks/useFloatingTabs.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { MoveTabToWindowMenuItem } from "../../layout/MoveTabToWindowMenuItem.tsx";
import { OpenInNewWindowContextMenuItem } from "../../layout/OpenInNewWindowMenuItem.tsx";
import layoutStyles from "../../layout/TitleBar.module.css";
import { TabEntityMenuSection } from "../../layout/tab-entity-menu.tsx";
import { useTabDragProps } from "../../layout/tabDnd.tsx";
import { TabGlyph, useTabBusy } from "./tab-glyph.tsx";
import {
	bulkCloseItems,
	MoveTabToRegionMenu,
	OpenInSidePanelItem,
	openTabInNewWindow,
	useColdChatTabPrefetch,
} from "./tab-menu-items.tsx";
import { NodeSubmenu } from "./tab-submenus.tsx";

// The vertical bar drawn in the gap beside the hovered tab when the strip cannot
// preview the landing spot by sliding tabs apart (a drop into another bracket).
// The host element must be `relative`.
export function DropIndicator({ side }: { side: "left" | "right" }) {
	return (
		<span
			aria-hidden
			className={cn(
				cn(
					"reorder-drop-indicator pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full bg-primary duration-150",
					layoutStyles.authored2,
					layoutStyles.authored3
				),
				side === "left" ? "-left-1" : "-right-1"
			)}
		/>
	);
}

// Compact, icon-only chip for a pinned tab (Chrome-style — no title, no X).
export function PinnedTab({ tab, isActive }: { tab: Tab; isActive: boolean }) {
	const activateTab = useTabSelector((state) => state.activateTab);
	const closeTab = useTabSelector((state) => state.closeTab);
	const togglePin = useTabSelector((state) => state.togglePin);
	const openTab = useTabSelector((state) => state.openTab);
	const tabs = useTabSelector((state) => state.tabs);
	const unloadTab = useTabSelector((state) => state.unloadTab);
	const [floatingTabs] = useFloatingTabs();
	const tabLayout = useTabLayout();
	const { isDragging, showBefore, showAfter, dragHandlers, shiftProps } =
		useTabDragProps(tab.id);
	const busy = useTabBusy(tab);
	const prefetchColdChat = useColdChatTabPrefetch(tab);
	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									aria-label={tab.title}
									className={cn(
										"group/tab relative isolate flex size-8 shrink-0 items-center justify-center transition-colors",
										floatingTabs
											? cn(
													"rounded-full",
													isActive ? "bg-muted" : "hover:bg-muted/50"
												)
											: cn(
													cn("", layoutStyles.authored4),
													isActive
														? "text-foreground"
														: "hover:bg-background/40"
												),
										tab.unloaded && "opacity-50",
										isDragging &&
											cn(
												"scale-[0.97] opacity-40 shadow-lg duration-150 motion-reduce:transform-none",
												layoutStyles.authored5,
												layoutStyles.authored6
											)
									)}
									data-active={isActive}
									onClick={() => activateTab(tab.id)}
									onFocus={prefetchColdChat}
									onMouseDown={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											closeTab(tab.id);
										}
									}}
									onPointerEnter={prefetchColdChat}
									type="button"
									{...dragHandlers}
									{...shiftProps}
								>
									<MorphingTabSurface
										floatingTabs={floatingTabs}
										isActive={isActive}
									/>
									{showBefore && <DropIndicator side="left" />}
									{showAfter && <DropIndicator side="right" />}
									{/* Color stays on the wrapper (TabGlyph forwards className to
									    Spinner, which owns its color); the size goes on TabGlyph
									    itself so the Hugeicons fallback and the busy Spinner, which
									    default to 24px / size-4, fit the 14px slot. */}
									<span
										className={cn(
											"relative z-10 flex size-3.5 items-center justify-center",
											isActive ? "text-foreground" : "text-muted-foreground"
										)}
									>
										<TabGlyph
											busy={busy}
											busySpeed={tab.busySpeed}
											className="size-3.5"
											icon={tab.icon}
											logoSize="14px"
											path={tab.path}
											unloaded={tab.unloaded}
										/>
									</span>
								</button>
							}
						/>
					}
				/>
				<TooltipContent>{tab.title}</TooltipContent>
			</Tooltip>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => togglePin(tab.id)}>
					<HugeiconsIcon className="size-4" icon={PinOffIcon} />
					Unpin tab
				</ContextMenuItem>
				<ContextMenuItem
					disabled={isActive || tab.unloaded}
					onClick={() => unloadTab(tab.id)}
				>
					<HugeiconsIcon className="size-4" icon={ZzzIcon} />
					Unload tab
				</ContextMenuItem>
				{/* Same entity section the regular pill gets — a pinned tab is still
				    showing a chat/space/agent, so the verbs for it belong here too. */}
				<TabEntityMenuSection tab={tab} />
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={() =>
						openTab(tab.path, {
							conversationId: tab.conversationId,
							forceNew: true,
							icon: tab.icon,
							title: tab.title,
						})
					}
				>
					<HugeiconsIcon className="size-4" icon={Copy01Icon} />
					Duplicate tab
				</ContextMenuItem>
				<OpenInNewWindowContextMenuItem
					iconClassName="size-4"
					onClick={() => openTabInNewWindow(tab)}
				/>
				<MoveTabToWindowMenuItem tabId={tab.id} />
				<MoveTabToRegionMenu tabId={tab.id} />
				<OpenInSidePanelItem tab={tab} />
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
				<ContextMenuSeparator />
				<NodeSubmenu tabId={tab.id} />
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => closeTab(tab.id)}>
					<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					Close tab
				</ContextMenuItem>
				{bulkCloseItems(tab, tabs, closeTab)}
			</ContextMenuContent>
		</ContextMenu>
	);
}
