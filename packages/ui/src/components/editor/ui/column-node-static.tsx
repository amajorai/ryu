import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import type { TColumnElement } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorcolumnNodeStatic1-width"?: string | number;
	"--editorcolumnNodeStatic2-width"?: string | number;
}

export function ColumnElementStatic(props: SlateElementProps<TColumnElement>) {
	const { width } = props.element;

	const editorcolumnNodeStatic1Style: EditorVariableStyle = {
		"--editorcolumnNodeStatic1-width": isNativeNumber(width ?? "100%")
			? `${width ?? "100%"}px`
			: (width ?? "100%"),
	};
	return (
		<div
			className={"group/column relative"}
			data-docx-style="editorcolumnNodeStatic1"
			style={editorcolumnNodeStatic1Style}
		>
			<SlateElement
				className="h-full px-2 pt-2 group-first/column:ps-0 group-last/column:pe-0"
				{...props}
			>
				<div className="relative h-full border border-transparent p-1.5">
					{props.children}
				</div>
			</SlateElement>
		</div>
	);
}

export function ColumnGroupElementStatic(props: SlateElementProps) {
	return (
		<SlateElement className="mb-2" {...props}>
			<div className="flex size-full rounded">{props.children}</div>
		</SlateElement>
	);
}

/**
 * DOCX-compatible column component using table cell.
 */
export function ColumnElementDocx(props: SlateElementProps<TColumnElement>) {
	const { width } = props.element;

	const editorcolumnNodeStatic2Style: EditorVariableStyle = {
		"--editorcolumnNodeStatic2-width": isNativeNumber(width ?? "auto")
			? `${width ?? "auto"}px`
			: (width ?? "auto"),
	};
	return (
		<SlateElement
			{...props}
			as="td"
			attributes={{
				...props.attributes,
				"data-docx-style": "editorcolumnNodeStatic2",
			}}
			style={editorcolumnNodeStatic2Style}
		>
			{props.children}
		</SlateElement>
	);
}

/**
 * DOCX-compatible column group component using table layout.
 */
export function ColumnGroupElementDocx(props: SlateElementProps) {
	return (
		<SlateElement {...props}>
			<table data-docx-style="editorcolumnNodeStatic3">
				<tbody>
					<tr>{props.children}</tr>
				</tbody>
			</table>
		</SlateElement>
	);
}
