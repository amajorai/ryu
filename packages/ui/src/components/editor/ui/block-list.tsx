"use client";

import { isOrderedList } from "@platejs/list";
import {
	useTodoListElement,
	useTodoListElementState,
} from "@platejs/list/react";
import { Checkbox } from "@ryu/ui/components/editor/ui/checkbox.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TListElement } from "platejs";
import {
	type PlateElementProps,
	type RenderNodeWrapper,
	useReadOnly,
} from "platejs/react";
import type React from "react";
import type { CSSProperties as ReactCSSProperties } from "react";
import editorStyles from "../editor-lint.module.css";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorblockList1-list-style-type"?: string | number;
}

const config = new Map([["todo", { Li: TodoLi, Marker: TodoMarker }]]);

export const BlockList: RenderNodeWrapper = (props) => {
	if (!props.element.listStyleType) {
		return;
	}
	if (!isOrderedList(props.element)) {
		return;
	}

	return (props) => <List {...props} />;
};

function List(props: PlateElementProps & { lineBreakBadge?: React.ReactNode }) {
	// SAFETY: BlockList only renders List after the native isOrderedList guard identifies the list element.
	// SAFETY: BlockList only renders List after the native isOrderedList guard identifies the list element.
	const { listStart, listStyleType } = props.element as TListElement;
	const { Li, Marker } = config.get(listStyleType) ?? {};
	const List = isOrderedList(props.element) ? "ol" : "ul";

	const editorblockList1Style: EditorVariableStyle = {
		"--editorblockList1-list-style-type": listStyleType,
	};
	return (
		<List
			className={cn("relative m-0 p-0", editorStyles.editorblockList1)}
			start={listStart}
			style={editorblockList1Style}
		>
			{Marker && <Marker {...props} />}
			{Li ? (
				<Li {...props} />
			) : (
				<li>
					{props.children}
					{props.lineBreakBadge}
				</li>
			)}
		</List>
	);
}

function TodoMarker(props: PlateElementProps) {
	const state = useTodoListElementState({ element: props.element });
	const { checkboxProps } = useTodoListElement(state);
	const readOnly = useReadOnly();

	return (
		<div contentEditable={false}>
			<Checkbox
				className={cn(
					"absolute -start-6 top-1",
					readOnly && "pointer-events-none"
				)}
				{...checkboxProps}
			/>
		</div>
	);
}

function TodoLi(
	props: PlateElementProps & { lineBreakBadge?: React.ReactNode }
) {
	return (
		<li
			className={cn(
				"list-none",
				!!props.element.checked && "text-muted-foreground line-through"
			)}
		>
			{props.children}
			{props.lineBreakBadge}
		</li>
	);
}
