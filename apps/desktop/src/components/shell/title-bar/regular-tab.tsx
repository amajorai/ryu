import {
	ArrowTurnBackwardIcon,
	Cancel01Icon,
	Copy01Icon,
	PinIcon,
	ZzzIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n, useLiteralMessages } from "@ryu/i18n/react";
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
import { findSplit, useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useFloatingTabs } from "@/src/hooks/useFloatingTabs.ts";
import { useNodeTabOverride } from "@/src/hooks/useNodeDisplayMode.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useTabSizing } from "@/src/hooks/useTabSizing.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { MoveTabToWindowMenuItem } from "../../layout/MoveTabToWindowMenuItem.tsx";
import { OpenInNewWindowContextMenuItem } from "../../layout/OpenInNewWindowMenuItem.tsx";
import { OverflowTooltip } from "../../layout/overflow-tooltip.tsx";
import layoutStyles from "../../layout/TitleBar.module.css";
import { TabEntityMenuSection } from "../../layout/tab-entity-menu.tsx";
import { TabRenameInput, useTabRename } from "../../layout/tab-rename.tsx";
import { useTabDragProps } from "../../layout/tabDnd.tsx";
import { DropIndicator } from "./pinned-tab.tsx";
import { TabGlyph, useTabBusy } from "./tab-glyph.tsx";
import {
	bulkCloseItems,
	MoveTabToRegionMenu,
	OpenInSidePanelItem,
	openTabInNewWindow,
	useColdChatTabPrefetch,
} from "./tab-menu-items.tsx";
import {
	capitalize,
	GroupSubmenu,
	NodeSubmenu,
	SplitSubmenu,
} from "./tab-submenus.tsx";

// Full chip for an unpinned tab (with title + hover-to-close), used both
// standalone and inside a group bracket.
export function RegularTab({
	tab,
	isActive,
}: {
	tab: Tab;
	isActive: boolean;
	inGroup: boolean;
}) {
	const { t } = useI18n();
	const tl = useLiteralMessages();
	const tabs = useTabSelector((state) => state.tabs);
	const splits = useTabSelector((state) => state.splits);
	const activeTabId = useTabSelector((state) => state.activeTabId);
	const activateTab = useTabSelector((state) => state.activateTab);
	const closeTab = useTabSelector((state) => state.closeTab);
	const openTab = useTabSelector((state) => state.openTab);
	const restoreTab = useTabSelector((state) => state.restoreTab);
	const hasClosedTabs = useTabSelector((state) => state.hasClosedTabs);
	const togglePin = useTabSelector((state) => state.togglePin);
	const unloadTab = useTabSelector((state) => state.unloadTab);
	const [floatingTabs] = useFloatingTabs();
	const { isDragging, showBefore, showAfter, dragHandlers, shiftProps } =
		useTabDragProps(tab.id);
	const busy = useTabBusy(tab);
	const prefetchColdChat = useColdChatTabPrefetch(tab);
	// A pane in the currently-visible split must not be unloadable — it's on
	// screen — so the Unload item is disabled for it.
	const activeSplit = findSplit(tabs, splits, activeTabId);
	const inActiveSplit = !!tab.splitId && tab.splitId === activeSplit?.id;
	const tabLayout = useTabLayout();
	const tabSizing = useTabSizing();
	const tabOverrideEnabled = useNodeTabOverride();
	const defaultNode = useNodeStore((s) => s.defaultNode);
	const overrideName = useNodeStore((s) => s.tabOverrides[tab.id]);
	// Only flag tabs pinned to a node other than the current default — a pin
	// matching the default is a no-op.
	const hasNodeOverride =
		tabOverrideEnabled && !!overrideName && overrideName !== defaultNode;
	// Active tabs inside a group use a lighter fill so they read against the
	// group's tinted bracket instead of clashing with it.
	const activeBg = "bg-muted";
	const {
		isEditing,
		canRename,
		startEditing,
		commitEditing,
		cancelEditing,
		draft,
		setDraft,
	} = useTabRename(tab);
	const titleContent = (
		<>
			{hasNodeOverride && (
				<Tooltip>
					<TooltipTrigger
						render={
							<span
								aria-hidden
								className="mr-1.5 size-1.5 shrink-0 rounded-full bg-success"
							/>
						}
					/>
					<TooltipContent>
						{tl("Connected to {node}", { node: capitalize(overrideName) })}
					</TooltipContent>
				</Tooltip>
			)}
			{/* One label in both states: a streaming title shimmers on the
			    SAME clipped line, so an over-long busy title dissolves at the
			    edge exactly like a resting one instead of losing the fade. */}
			<OverflowTooltip
				className={cn(
					"min-w-0 overflow-hidden whitespace-nowrap text-sm leading-none",
					tab.unloaded && "italic"
				)}
				fade
				forceShow={tab.unloaded}
				shimmer={busy && !tab.unloaded}
				text={tab.title}
				tooltip={
					tab.unloaded
						? t(
								"shell.tab-unloaded",
								{ title: tab.title },
								`${tab.title} (unloaded — click to reload)`
							)
						: undefined
				}
			/>
		</>
	);

	return (
		<ContextMenu>
			{/* The sizing classes must live on the Trigger itself, since that's the
			    direct flex child of the strip; the inner pill just fills it (w-full).
			    "fit" = tabs hug their text (basis auto, no stretch, so no empty space
			    after short titles) but shrink to fit when crowded, floored at min-w so
			    they keep an icon before the strip scrolls. "fixed" = each tab keeps a
			    fixed width and the strip scrolls on overflow. */}
			<ContextMenuTrigger
				className={cn(
					"flex h-8 items-center",
					tabSizing === "fit"
						? "min-w-[2.5rem] max-w-[180px] shrink"
						: "max-w-[180px] shrink-0"
				)}
			>
				{/* custom drag/resize interaction */}
				<div
					className={cn(
						"group/tab relative flex h-8 w-full min-w-0 items-center transition-colors",
						floatingTabs
							? cn(
									"rounded-lg duration-150 hover:duration-0",
									isActive ? activeBg : "hover:bg-muted/60"
								)
							: cn(
									cn("", layoutStyles.authored7),
									isActive ? "text-foreground" : "hover:bg-background/40"
								),
						tab.unloaded && "opacity-60",
						isDragging &&
							cn(
								"scale-[0.97] opacity-40 duration-150 motion-reduce:transform-none",
								layoutStyles.authored8,
								layoutStyles.authored9
							)
					)}
					data-active={isActive}
					data-tab-appearance={floatingTabs ? "floating" : "morphing"}
					onMouseDown={(e) => {
						if (e.button === 1) {
							e.preventDefault();
							closeTab(tab.id);
						}
					}}
					onPointerEnter={prefetchColdChat}
					{...dragHandlers}
					{...shiftProps}
				>
					{showBefore && <DropIndicator side="left" />}
					{showAfter && <DropIndicator side="right" />}
					<MorphingTabSurface floatingTabs={floatingTabs} isActive={isActive} />
					{/* Icon zone — page icon morphs to close X on tab hover */}
					<button
						aria-label={t(
							"shell.close-tab",
							{ title: tab.title },
							`Close ${tab.title}`
						)}
						className={cn(
							"relative z-10 ml-2 flex size-4 shrink-0 items-center justify-center rounded-full",
							isActive ? "text-foreground" : "text-muted-foreground"
						)}
						onClick={() => closeTab(tab.id)}
						type="button"
					>
						{/* Motion stays on the wrapper (TabGlyph forwards className to
						    Spinner, which owns its motion); the size goes on TabGlyph so
						    its Hugeicons fallback and busy Spinner fit the 14px slot. */}
						<span className="absolute flex size-3.5 items-center justify-center transition-[opacity,scale] duration-150 group-hover/tab:scale-50 group-hover/tab:opacity-0 motion-reduce:transition-opacity">
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
						<HugeiconsIcon
							className="absolute size-3.5 scale-50 opacity-0 transition-[opacity,scale] duration-150 group-hover/tab:scale-100 group-hover/tab:opacity-100 motion-reduce:transition-opacity"
							icon={Cancel01Icon}
						/>
					</button>

					{/* Title — activates the tab (and reloads it if unloaded); a
					    double-click starts an inline rename for a renamable tab. The
					    editor is a sibling of the activation button so the input is
					    never nested in a native interactive element. */}
					{isEditing ? (
						<div
							className={cn(
								"relative z-10 flex h-full min-w-0 flex-1 items-center overflow-hidden pr-3 pl-1.5",
								isActive ? "text-foreground" : "text-muted-foreground"
							)}
						>
							<TabRenameInput
								className="text-sm leading-none"
								onCancel={cancelEditing}
								onChange={setDraft}
								onCommit={commitEditing}
								value={draft}
							/>
						</div>
					) : (
						<button
							className={cn(
								"relative z-10 flex h-full min-w-0 flex-1 items-center overflow-hidden pr-3 pl-1.5",
								isActive ? "text-foreground" : "text-muted-foreground"
							)}
							onClick={() => activateTab(tab.id)}
							onDoubleClick={canRename ? startEditing : undefined}
							type="button"
						>
							{titleContent}
						</button>
					)}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => togglePin(tab.id)}>
					<HugeiconsIcon className="size-4" icon={PinIcon} />
					Pin tab
				</ContextMenuItem>
				<ContextMenuItem
					disabled={isActive || tab.unloaded || inActiveSplit}
					onClick={() => unloadTab(tab.id)}
				>
					<HugeiconsIcon className="size-4" icon={ZzzIcon} />
					Unload tab
				</ContextMenuItem>
				<GroupSubmenu tab={tab} />
				<SplitSubmenu tab={tab} />
				{/* Verbs for the thing the tab is SHOWING (the chat, the space, …) —
				    shell flags plus whatever apps anchor to it. Copy transcript lives
				    there now rather than being a hardcoded chat-only row here. */}
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
				<ContextMenuItem disabled={!hasClosedTabs} onClick={restoreTab}>
					<HugeiconsIcon className="size-4" icon={ArrowTurnBackwardIcon} />
					Restore closed tab
				</ContextMenuItem>
				{tabOverrideEnabled && (
					<>
						<ContextMenuSeparator />
						<NodeSubmenu tabId={tab.id} />
					</>
				)}
				<ContextMenuSeparator />
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
				<ContextMenuItem onClick={() => closeTab(tab.id)}>
					<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					Close tab
				</ContextMenuItem>
				{bulkCloseItems(tab, tabs, closeTab)}
			</ContextMenuContent>
		</ContextMenu>
	);
}
