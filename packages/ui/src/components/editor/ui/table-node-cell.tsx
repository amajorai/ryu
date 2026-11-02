"use client";

// Table rows and cells: the row drag handle and drop gap, per-cell borders
// and spans, and the block-selection overlay.

import { useDraggable, useDropLine } from "@platejs/dnd";
import {
	BlockSelectionPlugin,
	useBlockSelected,
} from "@platejs/selection/react";
import {
	TablePlugin,
	useCellIndices,
	useTableCellBorders,
	useTableValue,
} from "@platejs/table/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import { useDropNudge } from "@ryu/ui/hooks/use-drop-nudge.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { GripVertical } from "lucide-react";
import {
	KEYS,
	PathApi,
	type TElement,
	type TTableCellElement,
	type TTableRowElement,
} from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	useComposedRef,
	useEditorPlugin,
	useEditorRef,
	useElement,
	useElementSelector,
	usePluginOption,
	useReadOnly,
} from "platejs/react";
import {
	type ComponentProps,
	type CSSProperties,
	type Ref,
	type RefObject,
	useMemo,
} from "react";

import { blockSelectionVariants } from "./block-selection.tsx";
import { TableCellResizeControls } from "./table-node-resize-controls.tsx";

interface TableRowStyle extends CSSProperties {
	"--tableRowMinHeight"?: string;
}
interface TableCellStyle extends CSSProperties {
	"--cellBackground"?: TTableCellElement["background"];
	"--cellWidth"?: string;
}

export function TableRowElement({
	children,
	...props
}: PlateElementProps<TTableRowElement>) {
	const { element } = props;
	const readOnly = useReadOnly();
	const editor = useEditorRef();
	const rowIndex = useElementSelector(([, path]) => path.at(-1) ?? 0, [], {
		key: KEYS.tr,
	});
	const rowSize = useElementSelector(([node]) => node.size, [], {
		key: KEYS.tr,
	});
	const rowSizeOverrides = useTableValue("rowSizeOverrides");
	const rowMinHeight = rowSizeOverrides.get?.(rowIndex) ?? rowSize;
	const isSelectionAreaVisible = usePluginOption(
		BlockSelectionPlugin,
		"isSelectionAreaVisible"
	);
	const hasControls = !(readOnly || isSelectionAreaVisible);

	const { isDragging, nodeRef, previewRef, handleRef } = useDraggable({
		element,
		type: element.type,
		canDropNode: ({ dragEntry, dropEntry }) =>
			PathApi.equals(
				PathApi.parent(dragEntry[1]),
				PathApi.parent(dropEntry[1])
			),
		onDropHandler: (_, { dragItem }) => {
			// SAFETY: This row uses native useDraggable without a custom drag item. Its installed producer captures element from editor.api.node, and useDropNode routes file items away before this handler. The existing element guard is retained; this local producer bridge does not validate forged foreign drag payloads.
			const dragElement = (dragItem as { element: TElement }).element;

			if (dragElement) {
				editor.tf.select(dragElement);
			}
		},
	});

	const rowStyle: TableRowStyle = {
		...props.style,
		"--tableRowMinHeight": rowMinHeight ? `${rowMinHeight}px` : undefined,
	};
	return (
		<PlateElement
			{...props}
			as="tr"
			className={cn("group/row", isDragging && "opacity-50")}
			ref={useComposedRef(props.ref, previewRef, nodeRef)}
			style={rowStyle}
		>
			{hasControls && (
				<td
					className="w-2 min-w-2 max-w-2 select-none p-0"
					contentEditable={false}
				>
					<RowDragHandle dragRef={handleRef} />
					<RowDropGap rowRef={nodeRef} />
				</td>
			)}

			{children}
		</PlateElement>
	);
}

function useTableCellPresentation(element: TTableCellElement) {
	const { api } = useEditorPlugin(TablePlugin);
	const borders = useTableCellBorders({ element });
	const { col, row } = useCellIndices();

	const colSpan = api.table.getColSpan(element);
	const rowSpan = api.table.getRowSpan(element);
	const width = useMemo(() => {
		const terms = Array.from(
			{ length: colSpan },
			(_, offset) => `var(--table-col-${col + offset}, 120px)`
		);

		return terms.length === 1 ? terms[0]! : `calc(${terms.join(" + ")})`;
	}, [col, colSpan]);

	return {
		borders,
		colIndex: col + colSpan - 1,
		colSpan,
		rowIndex: row + rowSpan - 1,
		rowSpan,
		width,
	};
}

function RowDragHandle({ dragRef }: { dragRef: Ref<any> }) {
	const editor = useEditorRef();
	const element = useElement();

	return (
		<Button
			className={cn(
				"absolute start-0 top-1/2 z-51 h-6 w-4 -translate-y-1/2 p-0 focus-visible:ring-0 focus-visible:ring-offset-0",
				"cursor-grab active:cursor-grabbing",
				"opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-data-[table-resizing=true]/row:opacity-0"
			)}
			onClick={() => {
				editor.tf.select(element);
			}}
			ref={dragRef}
			variant="outline"
		>
			<GripVertical className="text-muted-foreground" />
		</Button>
	);
}

/** Eases this row and its neighbour apart where a dragged row would drop, in
 *  place of a drawn drop line. */
function RowDropGap({ rowRef }: { rowRef: RefObject<HTMLElement | null> }) {
	const { dropLine } = useDropLine();
	useDropNudge(rowRef, dropLine);
	return null;
}

export function TableCellElement({
	isHeader,
	...props
}: PlateElementProps<TTableCellElement> & {
	isHeader?: boolean;
}) {
	const readOnly = useReadOnly();
	const element = props.element;

	// SAFETY: This selector forwards the raw table identity only to native
	// useBlockSelected/isSelected (truthiness and Set.has); it proves no string.
	const tableId = useElementSelector(([node]) => node.id as string, [], {
		key: KEYS.table,
	});
	// SAFETY: The raw row identity is consumed by the same native Set.has
	// selection path below. The narrower annotation does not validate its kind.
	const rowId = useElementSelector(([node]) => node.id as string, [], {
		key: KEYS.tr,
	});
	const isSelectingTable = useBlockSelected(tableId);
	const isSelectingRow = useBlockSelected(rowId) || isSelectingTable;
	const isSelectionAreaVisible = usePluginOption(
		BlockSelectionPlugin,
		"isSelectionAreaVisible"
	);

	const { borders, colIndex, colSpan, rowIndex, rowSpan, width } =
		useTableCellPresentation(element);

	const cellStyle: TableCellStyle = {
		"--cellBackground": element.background,
		"--cellWidth": `${width}px`,
	};
	return (
		<PlateElement
			{...props}
			as={isHeader ? "th" : "td"}
			attributes={{
				...props.attributes,
				colSpan,
				"data-table-cell-id": element.id,
				rowSpan,
			}}
			className={cn(
				"relative h-full min-w-(--cellWidth) max-w-(--cellWidth) overflow-visible border-none bg-background p-0",
				element.background ? "bg-(--cellBackground)" : "bg-background",
				isHeader && "text-start *:m-0",
				"before:size-full",
				"data-[table-cell-selected=true]:before:z-10",
				"data-[table-cell-selected=true]:before:bg-primary/5",
				"before:absolute before:box-border before:select-none before:content-['']",
				borders.bottom?.size && "before:border-b before:border-b-border",
				borders.right?.size && "before:border-e before:border-e-border",
				borders.left?.size && "before:border-s before:border-s-border",
				borders.top?.size && "before:border-t before:border-t-border"
			)}
			style={cellStyle}
		>
			<div
				className={cn(
					"relative z-20 box-border h-full px-3 py-2",
					rowSpan === 1 && "min-h-(--tableRowMinHeight,0px)"
				)}
			>
				{props.children}
			</div>

			{!(readOnly || isSelectionAreaVisible) && (
				<TableCellResizeControls colIndex={colIndex} rowIndex={rowIndex} />
			)}

			{isSelectingRow && (
				<div className={blockSelectionVariants()} contentEditable={false} />
			)}
		</PlateElement>
	);
}

export function TableCellHeaderElement(
	props: ComponentProps<typeof TableCellElement>
) {
	return <TableCellElement {...props} isHeader />;
}
