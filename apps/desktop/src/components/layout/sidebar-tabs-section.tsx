import {
	ArrowUpRight01Icon,
	Cancel01Icon,
	Folder01Icon,
	GridIcon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	type DragEvent as ReactDragEvent,
	type ReactNode,
	useState,
} from "react";
import { z } from "zod";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { SplitPresetMenuItems } from "@/src/components/layout/SplitPresetMenu.tsx";
import type { Split, Tab } from "@/src/contexts/TabsContext.tsx";
import {
	findSplit,
	splitPaneTabs,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { TabLayoutMenuItems } from "./appearance-context-menu.tsx";
import { MoveTabToWindowMenuItem } from "./MoveTabToWindowMenuItem.tsx";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { TabGlyph, useColdChatTabPrefetch, useTabBusy } from "./TitleBar.tsx";
import { TabEntityMenuSection } from "./tab-entity-menu.tsx";
import { TabRenameInput, useTabRename } from "./tab-rename.tsx";
import { useTabBracketShift, useTabDnd, useTabDragProps } from "./tabDnd.tsx";

/** A single open tab rendered as a vertical sidebar row (Zen-style vertical
    tabs). Mirrors the title-bar chip: click to activate, middle-click or the
    hover × to close, right-click for pin/split/duplicate/close. Split members
    get a left accent so a contiguous split reads as one block in the list. */
function VerticalTabRow({ tab, isActive }: { tab: Tab; isActive: boolean }) {
	const tl = useLiteralMessages();
	const tabs = useTabSelector((state) => state.tabs);
	const splits = useTabSelector((state) => state.splits);
	const activeTabId = useTabSelector((state) => state.activeTabId);
	const activateTab = useTabSelector((state) => state.activateTab);
	const closeTab = useTabSelector((state) => state.closeTab);
	const openTab = useTabSelector((state) => state.openTab);
	const togglePin = useTabSelector((state) => state.togglePin);
	const unloadTab = useTabSelector((state) => state.unloadTab);
	const splitTabs = useTabSelector((state) => state.splitTabs);
	const unsplit = useTabSelector((state) => state.unsplit);
	const inSplit = !!tab.splitId;
	const tabLayout = useTabLayout();
	const activeSplit = findSplit(tabs, splits, activeTabId);
	const inActiveSplit = inSplit && tab.splitId === activeSplit?.id;
	const { isDragging, showBefore, showAfter, dragHandlers, shiftProps } =
		useTabDragProps(tab.id, "y");
	const busy = useTabBusy(tab);
	const prefetchColdChat = useColdChatTabPrefetch(tab);
	const openTabInNewWindow = () => {
		const overrideName = useNodeStore.getState().tabOverrides[tab.id];
		void openEntityInNewWindow({
			conversationId: tab.conversationId,
			node: overrideName,
			path: tab.path,
			title: tab.title,
		});
	};
	const rowState = isActive ? "bg-muted" : "hover:bg-muted/60";
	const textState = isActive ? "text-foreground" : "text-muted-foreground";
	const {
		isEditing,
		canRename,
		startEditing,
		commitEditing,
		cancelEditing,
		draft,
		setDraft,
	} = useTabRename(tab);

	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* sidebar row combines nested controls with drag/middle-click */}
					<div
						className={`group/row relative flex h-8 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2 transition-colors ${rowState} ${tab.unloaded ? "opacity-60" : ""} ${isDragging ? "opacity-40" : ""}`}
						onClick={() => activateTab(tab.id)}
						onDoubleClick={canRename ? startEditing : undefined}
						onFocus={prefetchColdChat}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								activateTab(tab.id);
							}
						}}
						onMouseDown={(e) => {
							if (e.button === 1) {
								e.preventDefault();
								closeTab(tab.id);
							}
						}}
						onPointerEnter={prefetchColdChat}
						role="button"
						tabIndex={0}
						{...dragHandlers}
						{...shiftProps}
					>
						{showBefore && (
							<span
								aria-hidden
								className="reorder-drop-indicator pointer-events-none absolute inset-x-1 -top-0.5 z-20 h-0.5 bg-primary"
							/>
						)}
						{showAfter && (
							<span
								aria-hidden
								className="reorder-drop-indicator pointer-events-none absolute inset-x-1 -bottom-0.5 z-20 h-0.5 bg-primary"
							/>
						)}
						{inSplit && (
							<span
								aria-hidden
								className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary/60"
							/>
						)}
						{/* Icon zone — page icon morphs to close X on row hover */}
						<button
							aria-label={tl("Close {title}", { title: tab.title })}
							className={`relative flex size-4 shrink-0 items-center justify-center rounded-full ${textState}`}
							onClick={(e) => {
								e.stopPropagation();
								closeTab(tab.id);
							}}
							type="button"
						>
							<TabGlyph
								busy={busy}
								busySpeed={tab.busySpeed}
								className="absolute size-4"
								icon={tab.icon}
								logoSize="16px"
								path={tab.path}
								presentation="sidebar-tab"
								unloaded={tab.unloaded}
							/>
							<HugeiconsIcon
								className="absolute size-3.5 scale-50 opacity-0 transition-[opacity,scale] duration-150 group-hover/row:scale-100 group-hover/row:opacity-100 group-focus-visible/row:scale-100 group-focus-visible/row:opacity-100 group-has-[button:focus-visible]/row:scale-100 group-has-[button:focus-visible]/row:opacity-100 motion-reduce:transition-opacity"
								icon={Cancel01Icon}
							/>
						</button>
						{/* Busy and resting share one label: the shimmer rides the same
						    faded clip line, so a streaming title never falls back to an
						    ellipsis and the row cannot jump as a run starts or ends.
						    A double-click on the row starts an inline rename for a
						    renamable tab, replacing the label with the input below. */}
						{isEditing ? (
							<TabRenameInput
								className="text-sm"
								onCancel={cancelEditing}
								onChange={setDraft}
								onCommit={commitEditing}
								value={draft}
							/>
						) : (
							<OverflowTooltip
								className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm ${textState} ${tab.unloaded ? "italic" : ""}`}
								fade
								shimmer={busy && !tab.unloaded}
								text={tab.title}
							/>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={() => togglePin(tab.id)}>
						<HugeiconsIcon
							className="mr-2 size-4"
							icon={tab.pinned ? PinOffIcon : PinIcon}
						/>
						{tab.pinned ? "Unpin tab" : "Pin tab"}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={isActive || tab.unloaded || inActiveSplit}
						onClick={() => unloadTab(tab.id)}
					>
						Unload tab
					</ContextMenuItem>
					{inSplit ? (
						<ContextMenuItem onClick={() => unsplit(tab.id)}>
							<HugeiconsIcon className="mr-2 size-4" icon={GridIcon} />
							Unsplit
						</ContextMenuItem>
					) : (
						<ContextMenuItem
							onClick={() => {
								const id = openTab("/chat", { forceNew: true });
								splitTabs([tab.id, id]);
							}}
						>
							<HugeiconsIcon className="mr-2 size-4" icon={GridIcon} />
							Split with new chat
						</ContextMenuItem>
					)}
					{/* Verbs for the thing the tab is SHOWING — the same section the
					    horizontal strip's pills get, so a vertical tab is not a
					    second-class surface. Renders nothing for a tab with no entity. */}
					<TabEntityMenuSection tab={tab} />
					<ContextMenuSeparator />
					<ContextMenuItem
						onClick={() =>
							openTab(tab.path, {
								conversationId: tab.conversationId,
								forceNew: true,
								title: tab.title,
								icon: tab.icon,
							})
						}
					>
						<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
						Duplicate tab
					</ContextMenuItem>
					<OpenInNewWindowContextMenuItem onClick={openTabInNewWindow} />
					<MoveTabToWindowMenuItem tabId={tab.id} />
					<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
					<ContextMenuSeparator />
					<ContextMenuItem onClick={() => closeTab(tab.id)}>
						<HugeiconsIcon className="mr-2 size-4" icon={Cancel01Icon} />
						Close tab
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		</SidebarMenuItem>
	);
}

/** A contiguous split's members in the vertical list, bracketed as one block
    (the vertical answer to the strip's split bracket): a header row names the
    split's arrangement and takes drops to add panes; member rows render in
    PANE order so the list mirrors the on-screen tiling. */
function VerticalSplitBlock({
	split,
	members,
	activeTabId,
}: {
	activeTabId: string;
	members: Tab[];
	split: Split;
}) {
	const tabs = useTabSelector((state) => state.tabs);
	const addTabToSplit = useTabSelector((state) => state.addTabToSplit);
	const setSplitOrientation = useTabSelector(
		(state) => state.setSplitOrientation
	);
	const unsplit = useTabSelector((state) => state.unsplit);
	const dnd = useTabDnd();
	const bracketShift = useTabBracketShift(split.id, "y");
	const [joinHover, setJoinHover] = useState(false);
	const canJoin =
		!!dnd.draggingId &&
		tabs.find((t) => t.id === dnd.draggingId)?.splitId !== split.id;
	// Show rows in pane order (the tree's leaf order), not strip order, so the
	// list reads top-to-bottom the way the panes tile.
	const ordered = splitPaneTabs(tabs, split).filter((t) =>
		members.some((m) => m.id === t.id)
	);
	const label =
		split.root.orientation === "columns" ? "Side by side" : "Stacked";
	return (
		<div
			className="rounded-lg bg-primary/5 p-0.5 ring-1 ring-primary/25"
			ref={bracketShift.ref}
			style={bracketShift.style}
		>
			{/* The header row carries the split's own verbs, mirroring the strip's
			    split bracket — orientation, layout presets, equalize, unsplit —
			    so the vertical layout is not a second-class surface. */}
			<ContextMenu>
				<ContextMenuTrigger>
					{/* drag-and-drop join target; the same action exists in the tab context menus */}
					<div
						className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-primary/70 ${joinHover ? "bg-primary/20 text-primary" : ""}`}
						onDragLeave={() => setJoinHover(false)}
						onDragOver={(e: ReactDragEvent) => {
							if (!canJoin) {
								return;
							}
							e.preventDefault();
							e.stopPropagation();
							e.dataTransfer.dropEffect = "move";
							setJoinHover(true);
						}}
						onDrop={(e: ReactDragEvent) => {
							setJoinHover(false);
							if (!(canJoin && dnd.draggingId)) {
								return;
							}
							e.preventDefault();
							e.stopPropagation();
							addTabToSplit(split.id, dnd.draggingId);
							dnd.onEnd();
						}}
					>
						<HugeiconsIcon className="size-3" icon={Folder01Icon} />
						<span className="font-medium text-xs">
							{canJoin && joinHover
								? "Drop to add"
								: `${label} · ${formatCount(members.length) ?? "—"}`}
						</span>
						<button
							className="ml-auto rounded px-1 text-muted-foreground text-xs hover:text-foreground"
							onClick={() => unsplit(members[0]?.id ?? "")}
							type="button"
						>
							Unsplit
						</button>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuRadioGroup
						onValueChange={(value) =>
							setSplitOrientation(
								split.id,
								z.enum(["columns", "rows"]).parse(value)
							)
						}
						value={split.root.orientation}
					>
						<ContextMenuRadioItem value="columns">
							Side by side
						</ContextMenuRadioItem>
						<ContextMenuRadioItem value="rows">Stacked</ContextMenuRadioItem>
					</ContextMenuRadioGroup>
					<ContextMenuSeparator />
					<SplitPresetMenuItems split={split} />
					<ContextMenuSeparator />
					<ContextMenuItem onClick={() => unsplit(members[0]?.id ?? "")}>
						<HugeiconsIcon className="mr-2 size-4" icon={GridIcon} />
						Unsplit
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			{ordered.map((tab) => (
				<VerticalTabRow
					isActive={tab.id === activeTabId}
					key={tab.id}
					tab={tab}
				/>
			))}
		</div>
	);
}

/** Vertical list of open tabs (Zen-style). Only rendered when the tab layout is
    "vertical"; in that mode the horizontal title-bar strip is hidden. Tabs are
    already normalized so grouped/split members render contiguously. */
export function TabsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const tabs = useTabSelector((state) => state.tabs);
	const splits = useTabSelector((state) => state.splits);
	const activeTabId = useTabSelector((state) => state.activeTabId);
	const openTab = useTabSelector((state) => state.openTab);
	// Bracket contiguous split runs (tabs are normalized, so members are always
	// adjacent) the way the horizontal strip does; everything else stays a row.
	const items: ReactNode[] = [];
	let i = 0;
	while (i < tabs.length) {
		const tab = tabs[i];
		const split = tab.splitId
			? splits.find((s) => s.id === tab.splitId)
			: undefined;
		if (split) {
			const members: Tab[] = [];
			while (i < tabs.length && tabs[i].splitId === split.id) {
				members.push(tabs[i]);
				i += 1;
			}
			items.push(
				<VerticalSplitBlock
					activeTabId={activeTabId}
					key={split.id}
					members={members}
					split={split}
				/>
			);
		} else {
			items.push(
				<VerticalTabRow
					isActive={tab.id === activeTabId}
					key={tab.id}
					tab={tab}
				/>
			);
			i += 1;
		}
	}
	return (
		<SidebarSection
			action={
				<SectionAddButton
					onClick={() => openTab("/chat", { forceNew: true })}
					title="New tab"
				/>
			}
			collapsed={collapsed}
			dnd={dnd}
			icon={GridIcon}
			label="Tabs"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="tabs"
			sort={sort}
		>
			{tabs.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">No tabs open</p>
			) : (
				<SidebarMenu>{items}</SidebarMenu>
			)}
		</SidebarSection>
	);
}
