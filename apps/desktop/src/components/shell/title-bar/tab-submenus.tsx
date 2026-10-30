import {
	Add01Icon,
	ArrowShrinkIcon,
	Cancel01Icon,
	GridIcon,
	RowDeleteIcon,
	ServerStack01Icon,
	Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import {
	ContextMenuItem,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { SplitOrientation, Tab } from "@/src/contexts/TabsContext.tsx";
import { findSplit, useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { SplitPresetMenuItems } from "../../layout/SplitPresetMenu.tsx";
import { GROUP_COLOR_CLASSES } from "./tab-segments.ts";

// Radio value used for the "follow the default node" choice in the per-tab node
// picker, distinct from any real node name.
export const DEFAULT_NODE_VALUE = "__default__";

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Per-tab "Connect to node" submenu, shared by pinned and regular tabs.
export function NodeSubmenu({ tabId }: { tabId: string }) {
	const { t } = useI18n();
	const nodes = useNodeStore((s) => s.nodes);
	const defaultNode = useNodeStore((s) => s.defaultNode);
	const overrideName = useNodeStore((s) => s.tabOverrides[tabId]);
	const setTabOverride = useNodeStore((s) => s.setTabOverride);
	const clearTabOverride = useNodeStore((s) => s.clearTabOverride);

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={ServerStack01Icon} />
				Connect to node
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				<ContextMenuRadioGroup
					onValueChange={(value) => {
						if (value === DEFAULT_NODE_VALUE) {
							clearTabOverride(tabId);
						} else {
							setTabOverride(tabId, value);
						}
					}}
					value={overrideName ?? DEFAULT_NODE_VALUE}
				>
					<ContextMenuRadioItem value={DEFAULT_NODE_VALUE}>
						{t(
							"shell.default-node",
							{ node: capitalize(defaultNode) },
							`Default (${capitalize(defaultNode)})`
						)}
					</ContextMenuRadioItem>
					{nodes.map((node) => (
						<ContextMenuRadioItem key={node.name} value={node.name}>
							{capitalize(node.name)}
						</ContextMenuRadioItem>
					))}
				</ContextMenuRadioGroup>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

// Shared "Add to group" submenu used by regular tabs.
export function GroupSubmenu({ tab }: { tab: Tab }) {
	const groups = useTabSelector((state) => state.groups);
	const createGroup = useTabSelector((state) => state.createGroup);
	const addTabToGroup = useTabSelector((state) => state.addTabToGroup);
	const removeTabFromGroup = useTabSelector(
		(state) => state.removeTabFromGroup
	);

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={Tag01Icon} />
				Add to group
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				<ContextMenuItem onClick={() => createGroup(tab.id)}>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					New group
				</ContextMenuItem>
				{groups.length > 0 && <ContextMenuSeparator />}
				{groups.map((g) => (
					<ContextMenuItem
						key={g.id}
						onClick={() => addTabToGroup(tab.id, g.id)}
					>
						<span
							aria-hidden
							className={cn(
								"size-2 shrink-0 rounded-full",
								GROUP_COLOR_CLASSES[g.color].dot
							)}
						/>
						{g.name || "Group"}
					</ContextMenuItem>
				))}
				{tab.groupId && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onClick={() => removeTabFromGroup(tab.id)}>
							<HugeiconsIcon className="size-4" icon={RowDeleteIcon} />
							Remove from group
						</ContextMenuItem>
					</>
				)}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

// Per-tab "Split view" submenu: start a split (with a fresh chat or another open
// tab), or — when the tab is already split — flip orientation, drop this pane, or
// dissolve the whole split. Pinned tabs are excluded as split partners.
export function SplitSubmenu({ tab }: { tab: Tab }) {
	const { t } = useI18n();
	const tabs = useTabSelector((state) => state.tabs);
	const splits = useTabSelector((state) => state.splits);
	const openTab = useTabSelector((state) => state.openTab);
	const splitTabs = useTabSelector((state) => state.splitTabs);
	const addTabToSplit = useTabSelector((state) => state.addTabToSplit);
	const removeFromSplit = useTabSelector((state) => state.removeFromSplit);
	const unsplit = useTabSelector((state) => state.unsplit);
	const setSplitOrientation = useTabSelector(
		(state) => state.setSplitOrientation
	);
	const split = findSplit(tabs, splits, tab.id);
	// Tabs that can join a split: not this tab, not pinned, not already split.
	const candidates = tabs.filter(
		(t) => t.id !== tab.id && !t.pinned && !t.splitId
	);

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={GridIcon} />
				Split view
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				{split ? (
					<>
						<ContextMenuRadioGroup
							onValueChange={(value) =>
								setSplitOrientation(
									split.id,
									/* SAFETY: This native ContextMenuRadioGroup publishes the value of its two authored RadioItems, columns and rows, matching SplitOrientation. This is a private mounted radio callback, not an external event payload. */ value as SplitOrientation
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
						{/* Grow the split to 3+ panes: the new pane joins at the end of
						    the root run, keeping any nested arrangement intact. */}
						<ContextMenuItem
							onClick={() => {
								const id = openTab("/chat", { forceNew: true });
								addTabToSplit(split.id, id);
							}}
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							{t("shell.add-chat-to-split", undefined, "Add new chat to split")}
						</ContextMenuItem>
						{candidates.length > 0 && (
							<ContextMenuSub>
								<ContextMenuSubTrigger>
									<HugeiconsIcon className="size-4" icon={GridIcon} />
									{t("shell.add-tab-to-split", undefined, "Add tab to split")}
								</ContextMenuSubTrigger>
								<ContextMenuSubContent>
									{candidates.map((c) => (
										<ContextMenuItem
											key={c.id}
											onClick={() => addTabToSplit(split.id, c.id)}
										>
											<span className="max-w-[160px] truncate">{c.title}</span>
										</ContextMenuItem>
									))}
								</ContextMenuSubContent>
							</ContextMenuSub>
						)}
						<ContextMenuSeparator />
						<ContextMenuItem onClick={() => removeFromSplit(tab.id)}>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							{t("shell.remove-from-split", undefined, "Remove from split")}
						</ContextMenuItem>
						<ContextMenuItem onClick={() => unsplit(tab.id)}>
							<HugeiconsIcon className="size-4" icon={ArrowShrinkIcon} />
							{t("shell.unsplit", undefined, "Unsplit")}
						</ContextMenuItem>
					</>
				) : (
					<>
						<ContextMenuItem
							onClick={() => {
								const id = openTab("/chat", { forceNew: true });
								splitTabs([tab.id, id]);
							}}
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							{t("shell.split-with-new-chat", undefined, "Split with new chat")}
						</ContextMenuItem>
						{candidates.length > 0 && <ContextMenuSeparator />}
						{candidates.map((c) => (
							<ContextMenuItem
								key={c.id}
								onClick={() => splitTabs([tab.id, c.id])}
							>
								<span className="max-w-[160px] truncate">
									{t(
										"shell.split-with",
										{ title: c.title },
										`Split with ${c.title}`
									)}
								</span>
							</ContextMenuItem>
						))}
						<ContextMenuSeparator />
						{/* Applying a preset from an unsplit tab lays the shape out over
						    fresh panes; there is no layout here yet to save. */}
						<SplitPresetMenuItems split={null} />
					</>
				)}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}
