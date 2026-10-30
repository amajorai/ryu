import { Add01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type {
	BottomAlignment,
	WorkbenchGroup,
	WorkbenchItem,
	WorkbenchRegion,
} from "@ryu/workbench/model";
import type { DesktopWorkbenchValue } from "./DesktopWorkbenchContext.tsx";
import type { WorkbenchChromeValue } from "./workbench-chrome.tsx";

export const REGION_LABELS = {
	bottom: "Bottom",
	center: "Center",
	left: "Left",
	right: "Right",
} satisfies Record<WorkbenchRegion, string>;

export const BOTTOM_ALIGNMENT_OPTIONS = [
	{ label: "Center", value: "center" },
	{ label: "Full width", value: "full" },
	{ label: "Left", value: "left" },
	{ label: "Right", value: "right" },
] as const satisfies ReadonlyArray<{ label: string; value: BottomAlignment }>;

export function isBottomAlignment(value: unknown): value is BottomAlignment {
	return BOTTOM_ALIGNMENT_OPTIONS.some((option) => option.value === value);
}

export function dispatchWorkbenchChromeEvent(
	type: "add",
	group: WorkbenchGroup
) {
	window.dispatchEvent(
		new CustomEvent(`ryu:workbench-${type}`, {
			detail: { groupId: group.id, region: group.region },
		})
	);
}

/** A workbench tab's right-click menu: move, split and close. */
export function WorkbenchTabMenu({
	canSplit,
	closeItem,
	item,
	moveRegions,
	moveToRegion,
	others,
	splitItem,
	toTheRight,
}: {
	canSplit: (itemId: string) => boolean;
	closeItem: (item: WorkbenchItem) => void;
	item: WorkbenchItem;
	moveRegions: WorkbenchRegion[];
	moveToRegion: (itemId: string, region: WorkbenchRegion) => void;
	others: WorkbenchItem[];
	splitItem: (itemId: string, zone: "down" | "right") => void;
	toTheRight: WorkbenchItem[];
}) {
	const tl = useLiteralMessages();
	return (
		<ContextMenuContent>
			{moveRegions.map((region) => (
				<ContextMenuItem
					key={region}
					onClick={() => moveToRegion(item.id, region)}
				>
					{tl("Move to {region}", { region: REGION_LABELS[region] })}
				</ContextMenuItem>
			))}
			<ContextMenuSeparator />
			<ContextMenuItem
				disabled={!canSplit(item.id)}
				onClick={() => splitItem(item.id, "right")}
			>
				Split Right
			</ContextMenuItem>
			<ContextMenuItem
				disabled={!canSplit(item.id)}
				onClick={() => splitItem(item.id, "down")}
			>
				Split Down
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				disabled={!item.closable}
				onClick={() => closeItem(item)}
			>
				Close
			</ContextMenuItem>
			<ContextMenuItem
				disabled={others.length === 0}
				onClick={() => {
					for (const other of others) {
						closeItem(other);
					}
				}}
			>
				Close Others
			</ContextMenuItem>
			<ContextMenuItem
				disabled={toTheRight.length === 0}
				onClick={() => {
					for (const right of toTheRight) {
						closeItem(right);
					}
				}}
			>
				Close to the Right
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

/** The strip's trailing "+" and "…" menus. */
export function WorkbenchStripActions({
	addMenu,
	canClosePane,
	dispatch,
	group,
	moveRegions,
	moveToRegion,
	regionLabel,
	state,
}: {
	addMenu: WorkbenchChromeValue["addMenu"];
	canClosePane: boolean;
	dispatch: DesktopWorkbenchValue["dispatch"];
	group: WorkbenchGroup;
	moveRegions: WorkbenchRegion[];
	moveToRegion: (itemId: string, region: WorkbenchRegion) => void;
	regionLabel: string;
	state: DesktopWorkbenchValue["state"];
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{addMenu && addMenu.tools.length > 0 && group.region !== "center" ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={tl("Add tab to {regionLabel}", { regionLabel })}
								className="size-6 shrink-0"
								size="icon-xs"
								variant="ghost-muted"
							/>
						}
					>
						<HugeiconsIcon icon={Add01Icon} />
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem
							onClick={() => dispatchWorkbenchChromeEvent("add", group)}
						>
							New chat
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						{addMenu.tools.map((tool) => (
							<DropdownMenuItem
								key={tool.id}
								onClick={() => addMenu.openTool(tool.id, group.id)}
							>
								{tool.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				<Button
					aria-label={tl("Add tab to {regionLabel}", { regionLabel })}
					className="size-6 shrink-0"
					onClick={() => dispatchWorkbenchChromeEvent("add", group)}
					size="icon-xs"
					variant="ghost-muted"
				>
					<HugeiconsIcon icon={Add01Icon} />
				</Button>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={tl("More {regionLabel} tab actions", { regionLabel })}
							className="size-6 shrink-0"
							size="icon-xs"
							variant="ghost-muted"
						/>
					}
				>
					<HugeiconsIcon icon={MoreHorizontalIcon} />
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{moveRegions.map((region) => (
						<DropdownMenuItem
							disabled={!group.activeItemId}
							key={region}
							onClick={() => {
								if (group.activeItemId) {
									moveToRegion(group.activeItemId, region);
								}
							}}
						>
							{tl("Move to {region}", { region: REGION_LABELS[region] })}
						</DropdownMenuItem>
					))}
					{group.region === "bottom" ? (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>Align Bottom</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<DropdownMenuRadioGroup
									onValueChange={(value) => {
										if (isBottomAlignment(value)) {
											dispatch({ type: "bottom/align", alignment: value });
										}
									}}
									value={state.bottomAlignment}
								>
									{BOTTOM_ALIGNMENT_OPTIONS.map((option) => (
										<DropdownMenuRadioItem
											key={option.value}
											value={option.value}
										>
											{option.label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					) : null}
					<DropdownMenuSeparator />
					{group.region === "center" ? null : (
						<DropdownMenuItem
							onClick={() => {
								if (group.region !== "center") {
									dispatch({ type: "region/hide", region: group.region });
								}
							}}
						>
							{tl("Hide {regionLabel}", { regionLabel })}
						</DropdownMenuItem>
					)}
					{canClosePane ? (
						<DropdownMenuItem
							onClick={() =>
								dispatch({ type: "center/remove-group", groupId: group.id })
							}
						>
							{group.itemIds.length > 0
								? "Close pane and keep its tabs"
								: "Close pane"}
						</DropdownMenuItem>
					) : null}
					<DropdownMenuItem onClick={() => dispatch({ type: "layout/reset" })}>
						Reset layout
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
