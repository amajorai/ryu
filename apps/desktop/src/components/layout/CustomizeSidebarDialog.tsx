import { EyeIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { useState } from "react";
import type { ChromeKey, SectionKey } from "./AppSidebar.tsx";

interface ChromeItem {
	key: string;
	label: string;
}

function BulkVisibilityActions({
	hideLabel = "Hide all",
	onHideAll,
	onShowAll,
	showLabel = "Show all",
}: {
	hideLabel?: string;
	onHideAll: () => void;
	onShowAll: () => void;
	showLabel?: string;
}) {
	return (
		<div className="flex shrink-0 items-center gap-1">
			<Button onClick={onShowAll} size="sm" type="button" variant="ghost">
				{showLabel}
			</Button>
			<Button onClick={onHideAll} size="sm" type="button" variant="ghost">
				{hideLabel}
			</Button>
		</div>
	);
}

/** A non-reorderable chrome row: a show/hide toggle, no drag handle. */
function ChromeRow({
	hidden,
	item,
	onToggle,
}: {
	hidden: boolean;
	item: ChromeItem;
	onToggle: (key: string) => void;
}) {
	return (
		<div className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted">
			<span
				className={`min-w-0 flex-1 truncate text-sm ${hidden ? "text-muted-foreground line-through" : ""}`}
			>
				{item.label}
			</span>
			<Button
				aria-label={hidden ? "Show button" : "Hide button"}
				onClick={() => onToggle(item.key)}
				size="icon-sm"
				variant="ghost"
			>
				<HugeiconsIcon
					className="size-4"
					icon={hidden ? ViewOffSlashIcon : EyeIcon}
				/>
			</Button>
		</div>
	);
}

/** Drag/drop + hide state threaded into a reorderable row (sections or buttons). */
interface RowDnd {
	draggingKey: string | null;
	dragOverKey: string | null;
	onDragEnd: () => void;
	onDragOver: (key: string) => void;
	onDragStart: (key: string) => void;
	onDrop: (key: string) => void;
	/** Current order of this list, so a target knows which edge to draw the line. */
	order: string[];
}

/** A draggable row with a show/hide toggle, shared by the sections list and the
 *  top-buttons list (each passes its own RowDnd, so the two lists never mix). */
function ReorderableRow({
	dnd,
	hidden,
	label,
	noun,
	onToggleHidden,
	rowKey,
}: {
	dnd: RowDnd;
	hidden: boolean;
	label: string;
	noun: string;
	onToggleHidden: (key: string) => void;
	rowKey: string;
}) {
	const isDragging = dnd.draggingKey === rowKey;
	const isDragOver =
		dnd.dragOverKey === rowKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== rowKey;
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(rowKey);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: row is the drag-and-drop reorder target; the nested button carries the keyboard-reachable affordance
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: row is the drag-and-drop reorder target; the nested button carries the keyboard-reachable affordance
		<div
			className={`relative flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted ${isDragging ? "opacity-50" : ""}`}
			onDragOver={(e) => {
				if (dnd.draggingKey) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					dnd.onDragOver(rowKey);
				}
			}}
			onDrop={(e) => {
				e.preventDefault();
				dnd.onDrop(rowKey);
			}}
		>
			{isDragOver && (
				<div
					className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			<button
				className="flex min-w-0 flex-1 cursor-grab items-center gap-2 text-left active:cursor-grabbing"
				draggable
				onDragEnd={() => dnd.onDragEnd()}
				onDragStart={(e) => {
					e.dataTransfer.effectAllowed = "move";
					e.dataTransfer.setData("text/plain", rowKey);
					dnd.onDragStart(rowKey);
				}}
				type="button"
			>
				<span
					className={`min-w-0 truncate text-sm ${hidden ? "text-muted-foreground line-through" : ""}`}
				>
					{label}
				</span>
			</button>
			<Button
				aria-label={hidden ? `Show ${noun}` : `Hide ${noun}`}
				onClick={() => onToggleHidden(rowKey)}
				size="icon-sm"
				variant="ghost"
			>
				<HugeiconsIcon
					className="size-4"
					icon={hidden ? ViewOffSlashIcon : EyeIcon}
				/>
			</Button>
		</div>
	);
}

/** Reusable drop handler: move the dragged key next to the drop target within
 *  `order`, dropping after the target when dragging down and before when up. */
function reorder<T extends string>(order: T[], dragging: T, target: T): T[] {
	const draggingDown = order.indexOf(dragging) < order.indexOf(target);
	const next = order.filter((k) => k !== dragging);
	const targetIdx = next.indexOf(target);
	next.splice(draggingDown ? targetIdx + 1 : targetIdx, 0, dragging);
	return next;
}

/**
 * "Customize sidebar" dialog: the one place that lists every section and button,
 * including the ones currently hidden from the sidebar. The list reads in the same
 * top-to-bottom order as the sidebar itself — the fixed top chrome (logo, node
 * selector), then the reorderable top buttons, then the reorderable content
 * sections, then the fixed bottom buttons (account, downloads, settings) — so a
 * row's position here maps to where it sits on screen. Top buttons and sections
 * each reorder by drag (mirroring the sidebar's own drag-to-reorder); every row
 * toggles show/hide. A single `onReorder`/`onReorderChrome` is the only writer for
 * each order, so the dialog, the per-row menus, and the sidebar drag stay in sync.
 */
export function CustomizeSidebarDialog({
	bottomChromeItems,
	chromeHidden,
	fixedTopChromeItems,
	hidden,
	labels,
	onClose,
	onReorder,
	onReorderChrome,
	onReset,
	onSetChromeItemsHidden,
	onSetSectionsHidden,
	onToggleChromeHidden,
	onToggleHidden,
	open,
	order,
	topButtonItems,
}: {
	bottomChromeItems: ChromeItem[];
	chromeHidden: Set<string>;
	fixedTopChromeItems: ChromeItem[];
	hidden: Set<string>;
	labels: Record<string, string>;
	onClose: () => void;
	onReorder: (next: SectionKey[]) => void;
	onReorderChrome: (next: ChromeKey[]) => void;
	onReset: () => void;
	onSetChromeItemsHidden: (keys: string[], hidden: boolean) => void;
	onSetSectionsHidden: (keys: SectionKey[], hidden: boolean) => void;
	onToggleChromeHidden: (key: string) => void;
	onToggleHidden: (key: SectionKey) => void;
	open: boolean;
	order: SectionKey[];
	topButtonItems: ChromeItem[];
}) {
	const [sectionDraggingKey, setSectionDraggingKey] = useState<string | null>(
		null
	);
	const [sectionDragOverKey, setSectionDragOverKey] = useState<string | null>(
		null
	);
	const [chromeDraggingKey, setChromeDraggingKey] = useState<string | null>(
		null
	);
	const [chromeDragOverKey, setChromeDragOverKey] = useState<string | null>(
		null
	);

	const sectionDnd: RowDnd = {
		draggingKey: sectionDraggingKey,
		dragOverKey: sectionDragOverKey,
		order,
		onDragStart: setSectionDraggingKey,
		onDragEnd: () => {
			setSectionDraggingKey(null);
			setSectionDragOverKey(null);
		},
		onDragOver: (key) =>
			setSectionDragOverKey((prev) => (prev === key ? prev : key)),
		onDrop: (target) => {
			if (sectionDraggingKey && sectionDraggingKey !== target) {
				onReorder(reorder(order, sectionDraggingKey, target) as SectionKey[]);
			}
			setSectionDraggingKey(null);
			setSectionDragOverKey(null);
		},
	};

	const chromeOrder = topButtonItems.map((i) => i.key);
	const fixedTopChromeKeys = fixedTopChromeItems.map((item) => item.key);
	const bottomChromeKeys = bottomChromeItems.map((item) => item.key);
	const allChromeKeys = [
		...fixedTopChromeKeys,
		...chromeOrder,
		...bottomChromeKeys,
	];
	const chromeDnd: RowDnd = {
		draggingKey: chromeDraggingKey,
		dragOverKey: chromeDragOverKey,
		order: chromeOrder,
		onDragStart: setChromeDraggingKey,
		onDragEnd: () => {
			setChromeDraggingKey(null);
			setChromeDragOverKey(null);
		},
		onDragOver: (key) =>
			setChromeDragOverKey((prev) => (prev === key ? prev : key)),
		onDrop: (target) => {
			if (chromeDraggingKey && chromeDraggingKey !== target) {
				onReorderChrome(
					reorder(chromeOrder, chromeDraggingKey, target) as ChromeKey[]
				);
			}
			setChromeDraggingKey(null);
			setChromeDragOverKey(null);
		},
	};

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Customize sidebar</DialogTitle>
					<DialogDescription>
						Listed top to bottom, the same order as the sidebar. Drag to reorder
						the top buttons and the sections, and toggle the eye to show or hide
						a row.
					</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto py-2">
					<div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
						<p className="font-medium text-sm">Entire sidebar</p>
						<BulkVisibilityActions
							hideLabel="All off"
							onHideAll={() => {
								onSetChromeItemsHidden(allChromeKeys, true);
								onSetSectionsHidden(order, true);
							}}
							onShowAll={() => {
								onSetChromeItemsHidden(allChromeKeys, false);
								onSetSectionsHidden(order, false);
							}}
							showLabel="All on"
						/>
					</div>
					<div className="flex flex-col gap-0.5">
						<div className="flex items-center justify-between gap-2 px-2">
							<p className="font-medium text-muted-foreground text-xs">
								Top buttons
							</p>
							<BulkVisibilityActions
								onHideAll={() =>
									onSetChromeItemsHidden(
										[...fixedTopChromeKeys, ...chromeOrder],
										true
									)
								}
								onShowAll={() =>
									onSetChromeItemsHidden(
										[...fixedTopChromeKeys, ...chromeOrder],
										false
									)
								}
							/>
						</div>
						{fixedTopChromeItems.map((item) => (
							<ChromeRow
								hidden={chromeHidden.has(item.key)}
								item={item}
								key={item.key}
								onToggle={onToggleChromeHidden}
							/>
						))}
						{topButtonItems.map((item) => (
							<ReorderableRow
								dnd={chromeDnd}
								hidden={chromeHidden.has(item.key)}
								key={item.key}
								label={item.label}
								noun="button"
								onToggleHidden={onToggleChromeHidden}
								rowKey={item.key}
							/>
						))}
					</div>
					<div className="flex flex-col gap-0.5">
						<div className="flex items-center justify-between gap-2 px-2">
							<p className="font-medium text-muted-foreground text-xs">
								Sections
							</p>
							<BulkVisibilityActions
								onHideAll={() => onSetSectionsHidden(order, true)}
								onShowAll={() => onSetSectionsHidden(order, false)}
							/>
						</div>
						{order.map((key) => (
							<ReorderableRow
								dnd={sectionDnd}
								hidden={hidden.has(key)}
								key={key}
								label={labels[key] ?? key}
								noun="section"
								onToggleHidden={(k) => onToggleHidden(k as SectionKey)}
								rowKey={key}
							/>
						))}
					</div>
					<div className="flex flex-col gap-0.5">
						<div className="flex items-center justify-between gap-2 px-2">
							<p className="font-medium text-muted-foreground text-xs">
								Bottom buttons
							</p>
							<BulkVisibilityActions
								onHideAll={() => onSetChromeItemsHidden(bottomChromeKeys, true)}
								onShowAll={() =>
									onSetChromeItemsHidden(bottomChromeKeys, false)
								}
							/>
						</div>
						{bottomChromeItems.map((item) => (
							<ChromeRow
								hidden={chromeHidden.has(item.key)}
								item={item}
								key={item.key}
								onToggle={onToggleChromeHidden}
							/>
						))}
					</div>
				</div>
				<DialogFooter>
					<Button onClick={onReset} type="button" variant="ghost">
						Reset to default
					</Button>
					<Button onClick={onClose} type="button">
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
