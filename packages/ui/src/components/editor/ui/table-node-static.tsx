import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import { BaseTablePlugin } from "@platejs/table";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TTableCellElement, TTableElement } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

interface EditorVariableStyle extends ReactCSSProperties {
	"--cellBackground"?: string;
	"--cellMaxWidth"?: string;
	"--cellMinWidth"?: string;
	"--editortableNodeStatic1-padding-left"?: string | number;
	"--editortableNodeStatic3-min-height"?: string | number;
}

export function TableElementStatic({
	children,
	...props
}: SlateElementProps<TTableElement>) {
	const { disableMarginLeft } = props.editor.getOptions(BaseTablePlugin);
	const marginLeft = disableMarginLeft ? 0 : props.element.marginLeft;

	const editortableNodeStatic1Style: EditorVariableStyle = {
		"--editortableNodeStatic1-padding-left": isNativeNumber(marginLeft)
			? `${marginLeft}px`
			: marginLeft,
	};
	return (
		<SlateElement
			{...props}
			attributes={{
				...props.attributes,
				"data-docx-style": "editortableNodeStatic1",
			}}
			className={"overflow-x-auto py-5"}
			style={editortableNodeStatic1Style}
		>
			<div className="group/table relative w-fit">
				<table
					className={"ms-px me-0 table h-px table-fixed border-collapse"}
					data-docx-style="editortableNodeStatic2"
				>
					<tbody className="min-w-full">{children}</tbody>
				</table>
			</div>
		</SlateElement>
	);
}

export function TableRowElementStatic(props: SlateElementProps) {
	return (
		<SlateElement {...props} as="tr" className="h-full">
			{props.children}
		</SlateElement>
	);
}

export function TableCellElementStatic({
	isHeader,
	...props
}: SlateElementProps<TTableCellElement> & {
	isHeader?: boolean;
}) {
	const { editor, element } = props;
	const { api } = editor.getPlugin(BaseTablePlugin);

	const { minHeight, width } = api.table.getCellSize({ element });
	const borders = api.table.getCellBorders({ element });

	const editortableNodeStatic3Style: EditorVariableStyle = {
		"--editortableNodeStatic3-min-height": isNativeNumber(minHeight)
			? `${minHeight}px`
			: minHeight,
	};
	const cellStyle: EditorVariableStyle = {
		"--cellBackground": element.background,
		"--cellMinWidth": `${width || 120}px`,
		"--cellMaxWidth": `${width || 240}px`,
	};
	return (
		<SlateElement
			{...props}
			as={isHeader ? "th" : "td"}
			attributes={{
				...props.attributes,
				colSpan: api.table.getColSpan(element),
				rowSpan: api.table.getRowSpan(element),
				"data-docx-cell": "true",
			}}
			className={cn(
				"h-full min-w-(--cellMinWidth) max-w-(--cellMaxWidth) overflow-visible border-none bg-background p-0",
				element.background ? "bg-(--cellBackground)" : "bg-background",
				isHeader && "text-start font-normal *:m-0",
				"before:size-full",
				"before:absolute before:box-border before:select-none before:content-['']",
				borders &&
					cn(
						borders.bottom?.size && "before:border-b before:border-b-border",
						borders.right?.size && "before:border-r before:border-r-border",
						borders.left?.size && "before:border-l before:border-l-border",
						borders.top?.size && "before:border-t before:border-t-border"
					)
			)}
			style={cellStyle}
		>
			<div
				className={"relative z-20 box-border h-full px-4 py-2"}
				data-docx-style="editortableNodeStatic3"
				style={editortableNodeStatic3Style}
			>
				{props.children}
			</div>
		</SlateElement>
	);
}

export function TableCellHeaderElementStatic(
	props: SlateElementProps<TTableCellElement>
) {
	return <TableCellElementStatic {...props} isHeader />;
}
