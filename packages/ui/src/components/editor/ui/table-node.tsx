"use client";

import {
	BlockSelectionPlugin,
	useBlockSelected,
} from "@platejs/selection/react";
import { getTableColumnCount } from "@platejs/table";
import {
	TableProvider,
	useTableColSizes,
	useTableElement,
	useTableSelectionDom,
} from "@platejs/table/react";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { KEYS, type TTableElement } from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	useElementSelector,
	usePluginOption,
	useReadOnly,
	withHOC,
} from "platejs/react";
import type { CSSProperties as ReactCSSProperties } from "react";
import { type CSSProperties, useMemo, useRef } from "react";
import editorStyles from "../editor-lint.module.css";
import { blockSelectionVariants } from "./block-selection.tsx";
import {
	TABLE_CONTROL_COLUMN_WIDTH,
	TABLE_DEFAULT_COLUMN_WIDTH,
	TABLE_DEFERRED_COLUMN_RESIZE_CELL_COUNT,
	TableResizeContext,
} from "./table-node-resize-context.ts";
import { useTableResizeController } from "./table-node-resize-controller.ts";
import { TableFloatingToolbar } from "./table-node-toolbar.tsx";

// Rows and cells live beside the table; re-exported so the kit's import path
// stays stable.
export {
	TableCellElement,
	TableCellHeaderElement,
	TableRowElement,
} from "./table-node-cell.tsx";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editortableNode1-padding-left"?: string | number;
	"--editortableNode2-max-width"?: string | number;
	"--editortableNode2-min-width"?: string | number;
	"--editortableNode2-width"?: string | number;
	"--editortableNode3-max-width"?: string | number;
	"--editortableNode3-min-width"?: string | number;
	"--editortableNode3-width"?: string | number;
}

interface TableLayoutStyle extends CSSProperties {
	"--table-width": string;
}
interface TableColumnStyle extends CSSProperties {
	[column: `--table-col-${number}`]: string;
}

export const TableElement = withHOC(
	TableProvider,
	function TableElement({
		children,
		...props
	}: PlateElementProps<TTableElement>) {
		const readOnly = useReadOnly();
		const isSelectionAreaVisible = usePluginOption(
			BlockSelectionPlugin,
			"isSelectionAreaVisible"
		);
		const hasControls = !(readOnly || isSelectionAreaVisible);
		const { marginLeft, props: tableProps } = useTableElement();
		const colSizes = useTableColSizes();
		const controlColumnWidth = hasControls ? TABLE_CONTROL_COLUMN_WIDTH : 0;
		const dragIndicatorRef = useRef<HTMLDivElement>(null);
		const hoverIndicatorRef = useRef<HTMLDivElement>(null);
		const deferColumnResize =
			colSizes.length * props.element.children.length >
			TABLE_DEFERRED_COLUMN_RESIZE_CELL_COUNT;
		const tablePath = useElementSelector(([, path]) => path, [], {
			key: KEYS.table,
		});
		const tableRef = useRef<HTMLTableElement>(null);
		const wrapperRef = useRef<HTMLDivElement>(null);
		useTableSelectionDom(tableRef);
		const resizeController = useTableResizeController({
			controlColumnWidth,
			deferColumnResize,
			dragIndicatorRef,
			hoverIndicatorRef,
			marginLeft,
			tablePath,
			tableRef,
			wrapperRef,
		});
		const resolvedColSizes = useMemo(() => {
			if (colSizes.length > 0) {
				return colSizes.map((colSize) => colSize || TABLE_DEFAULT_COLUMN_WIDTH);
			}

			return Array.from(
				{ length: getTableColumnCount(props.element) },
				() => TABLE_DEFAULT_COLUMN_WIDTH
			);
		}, [colSizes, props.element]);
		const tableVariableStyle: TableColumnStyle = {};
		resolvedColSizes.forEach((colSize, index) => {
			tableVariableStyle[`--table-col-${index}`] = `${colSize}px`;
		});
		const tableStyle: TableLayoutStyle = {
			"--table-width": `${resolvedColSizes.reduce((total, colSize) => total + colSize, 0) + controlColumnWidth}px`,
		};

		// SAFETY: Native useBlockSelected forwards this id to isSelected, which
		// uses truthiness and Set.has on the original identity, not string APIs.
		const isSelectingTable = useBlockSelected(props.element.id as string);

		const editortableNode1Style: EditorVariableStyle = {
			"--editortableNode1-padding-left": isNativeNumber(marginLeft)
				? `${marginLeft}px`
				: marginLeft,
		};
		const editortableNode2Style: EditorVariableStyle = {
			"--editortableNode2-max-width": isNativeNumber(TABLE_CONTROL_COLUMN_WIDTH)
				? `${TABLE_CONTROL_COLUMN_WIDTH}px`
				: TABLE_CONTROL_COLUMN_WIDTH,
			"--editortableNode2-min-width": isNativeNumber(TABLE_CONTROL_COLUMN_WIDTH)
				? `${TABLE_CONTROL_COLUMN_WIDTH}px`
				: TABLE_CONTROL_COLUMN_WIDTH,
			"--editortableNode2-width": isNativeNumber(TABLE_CONTROL_COLUMN_WIDTH)
				? `${TABLE_CONTROL_COLUMN_WIDTH}px`
				: TABLE_CONTROL_COLUMN_WIDTH,
		};
		const content = (
			<PlateElement
				{...props}
				className={cn(
					cn(
						"overflow-x-auto py-5",
						hasControls && "-ms-2 *:data-[slot=block-selection]:start-2"
					),
					editorStyles.editortableNode1
				)}
				style={editortableNode1Style}
			>
				<TableResizeContext.Provider value={resizeController}>
					<div
						className="group/table relative w-fit"
						ref={(element) => {
							wrapperRef.current = element;
							if (!element) {
								return;
							}
							for (const [property, value] of Object.entries(
								tableVariableStyle
							)) {
								element.style.setProperty(property, value);
							}
							return () => {
								for (const property of Object.keys(tableVariableStyle)) {
									element.style.removeProperty(property);
								}
							};
						}}
					>
						<div
							className="pointer-events-none absolute inset-y-0 z-36 hidden w-[3px] -translate-x-[1.5px] bg-ring/70 rtl:translate-x-[1.5px]"
							contentEditable={false}
							ref={dragIndicatorRef}
						/>
						<div
							className="pointer-events-none absolute inset-y-0 z-35 hidden w-[3px] -translate-x-[1.5px] bg-ring/80 rtl:translate-x-[1.5px]"
							contentEditable={false}
							ref={hoverIndicatorRef}
						/>
						<table
							className={cn(
								"ms-px me-0 table h-px w-(--table-width) table-fixed border-collapse",
								"data-[table-selecting=true]:[&_*::selection]:!bg-transparent",
								"data-[table-selecting=true]:[&_*::selection]:!text-inherit",
								"data-[table-selecting=true]:[&_*::-moz-selection]:!bg-transparent",
								"data-[table-selecting=true]:[&_*::-moz-selection]:!text-inherit",
								"data-[table-selecting=true]:[&_*]:!caret-transparent"
							)}
							ref={tableRef}
							style={tableStyle}
							{...tableProps}
						>
							{resolvedColSizes.length > 0 && (
								<colgroup>
									{hasControls && (
										<col
											className={editorStyles.editortableNode2}
											style={editortableNode2Style}
										/>
									)}
									{resolvedColSizes.map((colSize, index) => {
										const editortableNode3Style: EditorVariableStyle = {
											"--editortableNode3-max-width": isNativeNumber(colSize)
												? `${colSize}px`
												: colSize,
											"--editortableNode3-min-width": isNativeNumber(colSize)
												? `${colSize}px`
												: colSize,
											"--editortableNode3-width": isNativeNumber(colSize)
												? `${colSize}px`
												: colSize,
										};
										return (
											<col
												className={editorStyles.editortableNode3}
												key={index}
												style={editortableNode3Style}
											/>
										);
									})}
								</colgroup>
							)}
							<tbody className="min-w-full">{children}</tbody>
						</table>

						{isSelectingTable && (
							<div
								className={blockSelectionVariants()}
								contentEditable={false}
							/>
						)}
					</div>
				</TableResizeContext.Provider>
			</PlateElement>
		);

		if (readOnly) {
			return content;
		}

		return <TableFloatingToolbar>{content}</TableFloatingToolbar>;
	}
);
