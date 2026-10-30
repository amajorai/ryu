import {
	ArrowShrinkIcon,
	Cancel01Icon,
	Folder01Icon,
	PencilEdit01Icon,
	RowDeleteIcon,
	UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type DragEvent, type ReactNode, useState } from "react";
import type {
	Split,
	SplitOrientation,
	TabGroup,
	TabGroupColor,
} from "@/src/contexts/TabsContext.tsx";
import {
	TAB_GROUP_COLORS,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { SplitPresetMenuItems } from "../../layout/SplitPresetMenu.tsx";
import { useTabBracketShift, useTabDnd } from "../../layout/tabDnd.tsx";
import { COLOR_LABELS, GROUP_COLOR_CLASSES } from "./tab-segments.ts";

// The colored pill that brackets a group — click to collapse/expand, double-click
// or right-click for rename, and right-click for color/ungroup/close.
export function GroupHeaderPill({ group }: { group: TabGroup }) {
	const { t } = useI18n();
	const tabs = useTabSelector((state) => state.tabs);
	const toggleGroupCollapsed = useTabSelector(
		(state) => state.toggleGroupCollapsed
	);
	const renameGroup = useTabSelector((state) => state.renameGroup);
	const setGroupColor = useTabSelector((state) => state.setGroupColor);
	const ungroup = useTabSelector((state) => state.ungroup);
	const closeGroup = useTabSelector((state) => state.closeGroup);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(group.name);
	const memberCount = tabs.filter((tab) => tab.groupId === group.id).length;
	const colors = GROUP_COLOR_CLASSES[group.color];
	const startEditing = () => {
		setDraft(group.name);
		setEditing(true);
	};

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next && next !== group.name) {
			renameGroup(group.id, next);
		} else {
			setDraft(group.name);
		}
	};

	if (editing) {
		return (
			<input
				aria-label={t("shell.tab-group-name", undefined, "Tab group name")}
				// rename is an explicit user action
				autoFocus
				className={cn(
					"h-6 w-24 rounded-full px-2 font-medium text-xs outline-none ring-1",
					colors.pill,
					colors.container
				)}
				onBlur={commit}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						commit();
					} else if (e.key === "Escape") {
						setDraft(group.name);
						setEditing(false);
					}
				}}
				value={draft}
			/>
		);
	}

	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									className={cn(
										"flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs transition-colors",
										colors.pill
									)}
									data-testid="tab-group-header"
									onClick={() => toggleGroupCollapsed(group.id)}
									onDoubleClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										startEditing();
									}}
									type="button"
								>
									<span
										aria-hidden
										className={cn("size-1.5 shrink-0 rounded-full", colors.dot)}
									/>
									{group.name ? (
										<span className="max-w-[120px] truncate">{group.name}</span>
									) : null}
									{group.collapsed && (
										<span className="text-muted-foreground/70 tabular-nums">
											{memberCount}
										</span>
									)}
								</button>
							}
						/>
					}
				/>
				<TooltipContent>
					{group.collapsed ? "Expand group" : "Collapse group"}
				</TooltipContent>
			</Tooltip>
			<ContextMenuContent>
				<ContextMenuItem onClick={startEditing}>
					<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					Rename group
				</ContextMenuItem>
				<ContextMenuItem onClick={() => toggleGroupCollapsed(group.id)}>
					<HugeiconsIcon className="size-4" icon={UnfoldMoreIcon} />
					{group.collapsed ? "Expand group" : "Collapse group"}
				</ContextMenuItem>
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<span className="flex size-4 items-center justify-center">
							<span
								aria-hidden
								className={cn("size-2.5 rounded-full", colors.dot)}
							/>
						</span>
						Color
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						<ContextMenuRadioGroup
							onValueChange={(value) =>
								setGroupColor(
									group.id,
									/* SAFETY: This private native radio group is populated from TAB_GROUP_COLORS. Its item publisher forwards the selected authored value, matching TabGroupColor; no arbitrary stored group color is validated here. */ value as TabGroupColor
								)
							}
							value={group.color}
						>
							{TAB_GROUP_COLORS.map((c) => (
								<ContextMenuRadioItem key={c} value={c}>
									<span
										aria-hidden
										className={cn(
											"size-2.5 rounded-full",
											GROUP_COLOR_CLASSES[c].dot
										)}
									/>
									{COLOR_LABELS[c]}
								</ContextMenuRadioItem>
							))}
						</ContextMenuRadioGroup>
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => ungroup(group.id)}>
					<HugeiconsIcon className="size-4" icon={RowDeleteIcon} />
					Ungroup
				</ContextMenuItem>
				<ContextMenuItem onClick={() => closeGroup(group.id)}>
					<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					Close group
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// The leading chip of a split bracket: a split glyph that opens a context menu
// to flip orientation or dissolve the split, and a drop target — dragging any
// other tab onto it joins that tab to the split as a new pane. `anyMemberId`
// is any tab in the split (unsplit/orientation resolve the split from it).
export function SplitBracketHeader({
	split,
	anyMemberId,
}: {
	split: Split;
	anyMemberId: string;
}) {
	const tabs = useTabSelector((state) => state.tabs);
	const setSplitOrientation = useTabSelector(
		(state) => state.setSplitOrientation
	);
	const unsplit = useTabSelector((state) => state.unsplit);
	const addTabToSplit = useTabSelector((state) => state.addTabToSplit);
	const dnd = useTabDnd();
	const [joinHover, setJoinHover] = useState(false);
	// Any dragged tab that isn't already a member can join by dropping here.
	const canJoin =
		!!dnd.draggingId &&
		tabs.find((t) => t.id === dnd.draggingId)?.splitId !== split.id;
	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									aria-label="Split view"
									className={cn(
										"flex h-6 shrink-0 items-center justify-center rounded-full px-1.5 text-muted-foreground/70 transition-colors hover:text-muted-foreground",
										joinHover && "bg-muted/50 text-muted-foreground"
									)}
									onDragLeave={() => setJoinHover(false)}
									onDragOver={(e: DragEvent) => {
										if (!canJoin) {
											return;
										}
										e.preventDefault();
										e.stopPropagation();
										e.dataTransfer.dropEffect = "move";
										setJoinHover(true);
									}}
									onDrop={(e: DragEvent) => {
										setJoinHover(false);
										if (!(canJoin && dnd.draggingId)) {
											return;
										}
										e.preventDefault();
										e.stopPropagation();
										addTabToSplit(split.id, dnd.draggingId);
										dnd.onEnd();
									}}
									type="button"
								>
									<HugeiconsIcon className="size-3.5" icon={Folder01Icon} />
								</button>
							}
						/>
					}
				/>
				<TooltipContent>
					{canJoin ? "Drop to add to split" : "Split view"}
				</TooltipContent>
			</Tooltip>
			<ContextMenuContent>
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
				<ContextMenuItem onClick={() => unsplit(anyMemberId)}>
					<HugeiconsIcon className="size-4" icon={ArrowShrinkIcon} />
					Unsplit
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// A group or split bracket in the strip. It slides as one item when a loose tab
// is dragged past it.
export function TabBracket({
	bracketId,
	children,
	className,
}: {
	bracketId: string;
	children: ReactNode;
	className: string;
}) {
	const shift = useTabBracketShift(bracketId);
	return (
		<div className={className} ref={shift.ref} style={shift.style}>
			{children}
		</div>
	);
}
