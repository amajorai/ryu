"use client";

// The floating toolbar over a focused table: cell colour, merge/split,
// borders, and the row/column insert and delete actions.

import { TablePlugin, useTableMergeState } from "@platejs/table/react";
import { DIRECTIONAL_ICON_CLASS } from "@ryu/ui/components/directional-icon.tsx";
import {
	DropdownMenu,
	DropdownMenuPortal,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	CombineIcon,
	Grid2X2Icon,
	PaintBucketIcon,
	SquareSplitHorizontalIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import type { TTableElement } from "platejs";
import {
	useEditorPlugin,
	useEditorSelector,
	useElement,
	useFocusedLast,
	useRemoveNodeButton,
	useSelected,
} from "platejs/react";
import { type ComponentProps, useEffect, useState } from "react";

import { TABLE_MULTI_SELECTION_TOOLBAR_DELAY_MS } from "./table-node-resize-context.ts";
import {
	ColorDropdownMenu,
	TableBordersDropdownMenuContent,
} from "./table-node-toolbar-menus.tsx";
import { Toolbar, ToolbarButton, ToolbarGroup } from "./toolbar.tsx";

export function TableFloatingToolbar({
	children,
	...props
}: ComponentProps<typeof PopoverContent>) {
	const selectedCellCount = useEditorSelector(
		(editor) =>
			editor.getApi(TablePlugin).table.getSelectedCellIds()?.length ?? 0,
		[]
	);
	const selected = useSelected();
	const collapsedInside = useEditorSelector(
		(editor) => selected && editor.api.isCollapsed(),
		[selected]
	);
	const isFocusedLast = useFocusedLast();
	const [isExpandedSelectionToolbarReady, setIsExpandedSelectionToolbarReady] =
		useState(false);
	const isCollapsedToolbarOpen = isFocusedLast && collapsedInside;
	const isExpandedSelectionPending =
		isFocusedLast && !collapsedInside && selectedCellCount > 1;

	useEffect(() => {
		if (!isExpandedSelectionPending) {
			// eslint-disable-next-line react-hooks/set-state-in-effect -- Reset the delayed toolbar gate when selection is no longer expanded.
			setIsExpandedSelectionToolbarReady(false);

			return;
		}

		const timeoutId = window.setTimeout(() => {
			setIsExpandedSelectionToolbarReady(true);
		}, TABLE_MULTI_SELECTION_TOOLBAR_DELAY_MS);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [isExpandedSelectionPending]);

	const shouldRenderExpandedSelectionToolbar =
		isExpandedSelectionToolbarReady && isExpandedSelectionPending;
	const isToolbarOpen =
		isCollapsedToolbarOpen || shouldRenderExpandedSelectionToolbar;

	return (
		<Popover modal={false} open={isToolbarOpen}>
			<PopoverAnchor>{children}</PopoverAnchor>
			{isCollapsedToolbarOpen && (
				<CollapsedTableFloatingToolbarContent {...props} />
			)}
			{shouldRenderExpandedSelectionToolbar && (
				<ExpandedSelectionTableFloatingToolbarContent {...props} />
			)}
		</Popover>
	);
}

function ExpandedSelectionTableFloatingToolbarContent(
	props: ComponentProps<typeof PopoverContent>
) {
	const { tf } = useEditorPlugin(TablePlugin);
	const { canMerge, canSplit } = useTableMergeState();

	if (!(canMerge || canSplit)) {
		return null;
	}

	return (
		<TableFloatingToolbarContent
			canMerge={canMerge}
			canSplit={canSplit}
			onMerge={() => tf.table.merge()}
			onSplit={() => tf.table.split()}
			{...props}
		/>
	);
}

function CollapsedTableFloatingToolbarContent(
	props: ComponentProps<typeof PopoverContent>
) {
	const { tf } = useEditorPlugin(TablePlugin);
	const element = useElement<TTableElement>();
	const { props: buttonProps } = useRemoveNodeButton({ element });
	const { canSplit } = useTableMergeState();

	return (
		<TableFloatingToolbarContent
			buttonProps={buttonProps}
			canSplit={canSplit}
			collapsedInside
			onDeleteColumn={() => {
				tf.remove.tableColumn();
			}}
			onDeleteRow={() => {
				tf.remove.tableRow();
			}}
			onInsertColumnAfter={() => {
				tf.insert.tableColumn();
			}}
			onInsertColumnBefore={() => {
				tf.insert.tableColumn({ before: true });
			}}
			onInsertRowAfter={() => {
				tf.insert.tableRow();
			}}
			onInsertRowBefore={() => {
				tf.insert.tableRow({ before: true });
			}}
			onSplit={() => tf.table.split()}
			{...props}
		/>
	);
}

function TableFloatingToolbarContent({
	buttonProps,
	canMerge = false,
	canSplit = false,
	collapsedInside = false,
	onDeleteColumn,
	onDeleteRow,
	onInsertColumnAfter,
	onInsertColumnBefore,
	onInsertRowAfter,
	onInsertRowBefore,
	onMerge,
	onSplit,
	...props
}: ComponentProps<typeof PopoverContent> & {
	buttonProps?: ComponentProps<typeof ToolbarButton>;
	canMerge?: boolean;
	canSplit?: boolean;
	collapsedInside?: boolean;
	onDeleteColumn?: () => void;
	onDeleteRow?: () => void;
	onInsertColumnAfter?: () => void;
	onInsertColumnBefore?: () => void;
	onInsertRowAfter?: () => void;
	onInsertRowBefore?: () => void;
	onMerge?: () => void;
	onSplit?: () => void;
}) {
	return (
		<PopoverContent
			contentEditable={false}
			onOpenAutoFocus={(e) => e.preventDefault()}
			{...props}
			render={
				<Toolbar
					className="scrollbar-hide flex w-auto max-w-[80vw] flex-row overflow-x-auto rounded-md border bg-popover p-1 shadow-md print:hidden"
					contentEditable={false}
				/>
			}
		>
			<ToolbarGroup>
				<ColorDropdownMenu tooltip="Background color">
					<PaintBucketIcon />
				</ColorDropdownMenu>
				{canMerge && onMerge && (
					<ToolbarButton
						onClick={onMerge}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Merge cells"
					>
						<CombineIcon />
					</ToolbarButton>
				)}
				{canSplit && onSplit && (
					<ToolbarButton
						onClick={onSplit}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Split cell"
					>
						<SquareSplitHorizontalIcon />
					</ToolbarButton>
				)}

				<DropdownMenu modal={false}>
					<DropdownMenuTrigger
						render={<ToolbarButton tooltip="Cell borders" />}
					>
						<Grid2X2Icon />
					</DropdownMenuTrigger>

					<DropdownMenuPortal>
						<TableBordersDropdownMenuContent />
					</DropdownMenuPortal>
				</DropdownMenu>

				{collapsedInside && (
					<ToolbarGroup>
						<ToolbarButton tooltip="Delete table" {...buttonProps}>
							<Trash2Icon />
						</ToolbarButton>
					</ToolbarGroup>
				)}
			</ToolbarGroup>
			{collapsedInside && (
				<ToolbarGroup>
					<ToolbarButton
						onClick={onInsertRowBefore}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert row before"
					>
						<ArrowUp />
					</ToolbarButton>
					<ToolbarButton
						onClick={onInsertRowAfter}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert row after"
					>
						<ArrowDown />
					</ToolbarButton>
					<ToolbarButton
						onClick={onDeleteRow}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Delete row"
					>
						<XIcon />
					</ToolbarButton>
				</ToolbarGroup>
			)}
			{collapsedInside && (
				<ToolbarGroup>
					<ToolbarButton
						onClick={onInsertColumnBefore}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert column before"
					>
						{/* Before/after follow the reading direction, so the arrows mirror in RTL. */}
						<ArrowLeft
							className={DIRECTIONAL_ICON_CLASS}
							data-directional-icon=""
						/>
					</ToolbarButton>
					<ToolbarButton
						onClick={onInsertColumnAfter}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert column after"
					>
						<ArrowRight
							className={DIRECTIONAL_ICON_CLASS}
							data-directional-icon=""
						/>
					</ToolbarButton>
					<ToolbarButton
						onClick={onDeleteColumn}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Delete column"
					>
						<XIcon />
					</ToolbarButton>
				</ToolbarGroup>
			)}
		</PopoverContent>
	);
}
