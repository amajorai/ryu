import {
	Add01Icon,
	Cancel01Icon,
	MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
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
import { useReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	BottomAlignment,
	WorkbenchGroup,
	WorkbenchItem,
	WorkbenchRegion,
} from "@ryu/workbench/model";
import {
	type DragEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import {
	useWorkbenchChrome,
	WORKBENCH_ITEM_DRAG_MIME,
} from "./workbench-chrome.tsx";
import {
	applyWorkbenchPaneDrop,
	splitTargetGroupId,
	stripDropIndex,
} from "./workbench-drop.ts";

const REGION_LABELS = {
	bottom: "Bottom",
	center: "Center",
	left: "Left",
	right: "Right",
} satisfies Record<WorkbenchRegion, string>;

const BOTTOM_ALIGNMENT_OPTIONS = [
	{ label: "Center", value: "center" },
	{ label: "Full width", value: "full" },
	{ label: "Left", value: "left" },
	{ label: "Right", value: "right" },
] as const satisfies ReadonlyArray<{ label: string; value: BottomAlignment }>;

function isBottomAlignment(value: unknown): value is BottomAlignment {
	return BOTTOM_ALIGNMENT_OPTIONS.some((option) => option.value === value);
}

interface StripDropTarget {
	before: boolean;
	overItemId: string | null;
}

function DropIndicator({ side }: { side: "left" | "right" }) {
	return (
		<span
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full bg-primary",
				side === "left" ? "-left-0.5" : "-right-0.5"
			)}
		/>
	);
}

interface WorkbenchTabStripProps {
	focused: boolean;
	group: WorkbenchGroup;
	items: WorkbenchItem[];
	onCloseItem?: (item: WorkbenchItem) => void;
}

function dispatchWorkbenchChromeEvent(type: "add", group: WorkbenchGroup) {
	window.dispatchEvent(
		new CustomEvent(`ryu:workbench-${type}`, {
			detail: { groupId: group.id, region: group.region },
		})
	);
}

/** Index reached by an arrow/Home/End key in a horizontal tab list, if any. */
function tabIndexForKey(
	key: string,
	currentIndex: number,
	count: number
): number | undefined {
	switch (key) {
		case "ArrowLeft":
			return (currentIndex - 1 + count) % count;
		case "ArrowRight":
			return (currentIndex + 1) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return undefined;
	}
}

export function WorkbenchTabStrip({
	focused,
	group,
	items,
	onCloseItem,
}: WorkbenchTabStripProps) {
	const { dispatch, moveItem, state } = useDesktopWorkbench();
	const { addMenu, drag, movableRegions, prepareItemForSplit, renderItemIcon } =
		useWorkbenchChrome();
	const regionLabel = REGION_LABELS[group.region];
	const tabListRef = useRef<HTMLDivElement | null>(null);
	const [dropTarget, setDropTarget] = useState<StripDropTarget | null>(null);
	const draggingId = drag?.draggingId ?? null;
	// A tab dragged within this strip slides its neighbours apart; one arriving
	// from another strip falls back to the drop line.
	const shift = useReorderShift({
		activeId: draggingId,
		axis: "x",
		before: dropTarget?.before,
		overId: dropTarget?.overItemId ?? null,
	});
	const centerGroupCount = state.groups.filter(
		(candidate) => candidate.region === "center"
	).length;
	const canClosePane = group.region === "center" && centerGroupCount > 1;
	const moveRegions = movableRegions.filter(
		(region) => region !== group.region
	);
	// Navigation may always return to Left, its home, even where Left is not
	// otherwise a move target.
	const moveRegionsFor = (item: WorkbenchItem | undefined) =>
		item?.source.kind === "navigation" &&
		group.region !== "left" &&
		!moveRegions.includes("left")
			? (["left", ...moveRegions] as WorkbenchRegion[])
			: moveRegions;
	const activeItem = items.find((item) => item.id === group.activeItemId);

	// Overflowing tabs scroll rather than clip; keep the active tab in view.
	useEffect(() => {
		if (!group.activeItemId) {
			return;
		}
		const activeTab = tabListRef.current?.querySelector<HTMLElement>(
			`[data-workbench-tab="${CSS.escape(group.activeItemId)}"]`
		);
		activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [group.activeItemId]);

	useEffect(() => {
		if (!draggingId) {
			setDropTarget(null);
		}
	}, [draggingId]);

	const closeItem = (item: WorkbenchItem) => {
		if (!item.closable) {
			return;
		}
		if (onCloseItem) {
			onCloseItem(item);
		} else {
			dispatch({ type: "item/close", itemId: item.id });
		}
	};

	const moveToRegion = (itemId: string, region: WorkbenchRegion) => {
		dispatch({ type: "region/show", region });
		moveItem(itemId, { region });
	};

	const splitItem = (itemId: string, zone: "down" | "right") => {
		const targetGroupId = splitTargetGroupId(state, itemId);
		if (!targetGroupId) {
			return;
		}
		applyWorkbenchPaneDrop({
			dispatch,
			draggingId: itemId,
			state,
			synchronizeRoute: prepareItemForSplit,
			targetGroupId,
			zone,
		});
	};

	// Splitting a tab out of its own Center pane only helps when that pane keeps
	// another tab; a lone tab would just leave an empty pane behind.
	const canSplit = (itemId: string) =>
		group.region !== "center" || group.itemIds.some((id) => id !== itemId);

	const onTabKeyDown = (
		event: KeyboardEvent<HTMLButtonElement>,
		index: number
	) => {
		const nextIndex = tabIndexForKey(event.key, index, items.length);
		if (nextIndex === undefined) {
			return;
		}
		const nextItem = items[nextIndex];
		if (!nextItem) {
			return;
		}
		event.preventDefault();
		dispatch({ type: "item/activate", itemId: nextItem.id });
		tabListRef.current
			?.querySelector<HTMLElement>(
				`[data-workbench-tab="${CSS.escape(nextItem.id)}"] [role="tab"]`
			)
			?.focus();
	};

	const dropTargetForEvent = (event: DragEvent): StripDropTarget => {
		const tab =
			event.target instanceof Element
				? event.target.closest<HTMLElement>("[data-workbench-tab]")
				: null;
		const overItemId = tab?.dataset.workbenchTab ?? null;
		const from = items.findIndex((item) => item.id === draggingId);
		if (draggingId && from >= 0) {
			// Within this strip the tabs have slid aside, so target the resting
			// slot under the pointer rather than whichever tab is drawn there.
			// Past the last tab, the drop goes to the end.
			const slotId = shift.resolveOver(
				overItemId ?? items.at(-1)?.id ?? draggingId,
				event.clientX,
				event.clientY
			);
			const to = items.findIndex((item) => item.id === slotId);
			return { before: to < from, overItemId: slotId };
		}
		if (!(tab && overItemId)) {
			return { before: false, overItemId: null };
		}
		const rect = tab.getBoundingClientRect();
		return { before: event.clientX < rect.left + rect.width / 2, overItemId };
	};

	const onStripDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!draggingId) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const next = dropTargetForEvent(event);
		setDropTarget((previous) =>
			previous?.overItemId === next.overItemId &&
			previous.before === next.before
				? previous
				: next
		);
	};

	const onStripDrop = (event: DragEvent<HTMLDivElement>) => {
		if (!draggingId) {
			return;
		}
		event.preventDefault();
		const target = dropTargetForEvent(event);
		setDropTarget(null);
		if (target.overItemId !== draggingId) {
			moveItem(draggingId, {
				groupId: group.id,
				index: stripDropIndex(
					group.itemIds,
					draggingId,
					target.overItemId,
					target.before
				),
			});
		}
		drag?.end();
	};

	return (
		<div
			className={cn(
				"flex h-8 min-w-0 shrink-0 items-center border-border/70 border-b bg-muted/25 px-1",
				focused && "bg-muted/40",
				draggingId && dropTarget && "bg-primary/10"
			)}
			data-focused={focused}
			data-group-id={group.id}
			data-region={group.region}
			onDragLeave={(event) => {
				if (
					!(
						event.relatedTarget instanceof Node &&
						event.currentTarget.contains(event.relatedTarget)
					)
				) {
					setDropTarget(null);
				}
			}}
			onDragOver={onStripDragOver}
			onDrop={onStripDrop}
		>
			<div
				aria-label={`${regionLabel} tabs`}
				aria-orientation="horizontal"
				className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				ref={tabListRef}
				role="tablist"
			>
				{items.map((item, index) => {
					const active = item.id === group.activeItemId;
					const showLine =
						dropTarget?.overItemId === item.id && !shift.previewing;
					const showBefore = showLine && dropTarget.before === true;
					const showAfter = showLine && dropTarget.before === false;
					const others = items.filter(
						(candidate) => candidate.id !== item.id && candidate.closable
					);
					const toTheRight = items
						.slice(index + 1)
						.filter((candidate) => candidate.closable);
					return (
						<ContextMenu key={item.id}>
							<ContextMenuTrigger
								className={cn(
									"group/workbench-tab relative flex h-7 min-w-24 max-w-44 shrink-0 items-center rounded-md",
									active
										? "bg-background text-foreground shadow-xs"
										: "text-muted-foreground hover:bg-background/60 hover:text-foreground",
									draggingId === item.id && "opacity-40"
								)}
								data-active={active}
								data-workbench-tab={item.id}
								draggable={drag !== undefined}
								onDragEnd={(event) => drag?.end(event)}
								onDragStart={(event) => {
									if (!drag) {
										return;
									}
									event.dataTransfer.effectAllowed = "copyMove";
									event.dataTransfer.setData("text/plain", item.id);
									event.dataTransfer.setData(WORKBENCH_ITEM_DRAG_MIME, item.id);
									drag.start(item.id);
								}}
								ref={shift.register(item.id)}
								style={shift.styleFor(item.id)}
							>
								{showBefore ? <DropIndicator side="left" /> : null}
								<button
									aria-selected={active}
									className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
									onAuxClick={(event) => {
										// Middle-click closes a tab, as in editor tab strips.
										if (event.button === 1) {
											event.preventDefault();
											closeItem(item);
										}
									}}
									onClick={() =>
										dispatch({ type: "item/activate", itemId: item.id })
									}
									onKeyDown={(event) => onTabKeyDown(event, index)}
									role="tab"
									tabIndex={active ? 0 : -1}
									title={item.title}
									type="button"
								>
									{renderItemIcon ? (
										<span
											aria-hidden
											className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5"
										>
											{renderItemIcon(item)}
										</span>
									) : null}
									<span className="min-w-0 truncate" title={item.title}>
										{item.title}
									</span>
								</button>
								{item.closable ? (
									<Button
										appearance="workbench-tab-close"
										aria-label={`Close ${item.title}`}
										className="mr-0.5"
										onClick={() => closeItem(item)}
										size="icon-xs"
										tabIndex={active ? 0 : -1}
										variant="ghost-muted"
									>
										<HugeiconsIcon icon={Cancel01Icon} />
									</Button>
								) : null}
								{showAfter ? <DropIndicator side="right" /> : null}
							</ContextMenuTrigger>
							<ContextMenuContent>
								{moveRegionsFor(item).map((region) => (
									<ContextMenuItem
										key={region}
										onClick={() => moveToRegion(item.id, region)}
									>
										Move to {REGION_LABELS[region]}
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
						</ContextMenu>
					);
				})}
			</div>
			{addMenu && addMenu.tools.length > 0 && group.region !== "center" ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={`Add tab to ${regionLabel}`}
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
					aria-label={`Add tab to ${regionLabel}`}
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
							aria-label={`More ${regionLabel} tab actions`}
							className="size-6 shrink-0"
							size="icon-xs"
							variant="ghost-muted"
						/>
					}
				>
					<HugeiconsIcon icon={MoreHorizontalIcon} />
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{moveRegionsFor(activeItem).map((region) => (
						<DropdownMenuItem
							disabled={!group.activeItemId}
							key={region}
							onClick={() => {
								if (group.activeItemId) {
									moveToRegion(group.activeItemId, region);
								}
							}}
						>
							Move to {REGION_LABELS[region]}
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
							Hide {regionLabel}
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
		</div>
	);
}

export { REGION_LABELS };
