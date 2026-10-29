import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import { isOrderedList } from "@platejs/list";
import { cn } from "@ryu/ui/lib/utils.ts";
import { CheckIcon } from "lucide-react";
import type { RenderStaticNodeWrapper, TListElement } from "platejs";
import type { SlateRenderElementProps } from "platejs/static";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorblockListStatic1-list-style-type"?: string | number;
	"--editorblockListStatic1-margin-left"?: string | number;
}

const config = new Map([
	["todo", { Li: TodoLiStatic, Marker: TodoMarkerStatic }],
]);

export const BlockListStatic: RenderStaticNodeWrapper = (props) => {
	if (!props.element.listStyleType) {
		return;
	}
	if (!isOrderedList(props.element)) {
		return;
	}

	return (props) => <List {...props} />;
};

function List(props: SlateRenderElementProps) {
	// SAFETY: BlockListStatic renders List only after native isOrderedList identifies the list node; indent is the native optional indentation field.
	const { indent, listStart, listStyleType } = props.element as TListElement & {
		indent?: number;
	};
	const { Li, Marker } = config.get(listStyleType) ?? {};
	const List = isOrderedList(props.element) ? "ol" : "ul";

	// Apply margin-left for indent (24px per level) for DOCX export compatibility
	const marginLeft = indent ? `${indent * 24}px` : undefined;

	const editorblockListStatic1Style: EditorVariableStyle = {
		"--editorblockListStatic1-list-style-type": listStyleType,
		"--editorblockListStatic1-margin-left": isNativeNumber(marginLeft)
			? `${marginLeft}px`
			: marginLeft,
	};
	return (
		<List
			className={"relative m-0 p-0"}
			data-docx-style="editorblockListStatic1"
			start={listStart}
			style={editorblockListStatic1Style}
		>
			{Marker && <Marker {...props} />}
			{Li ? <Li {...props} /> : <li>{props.children}</li>}
		</List>
	);
}

function TodoMarkerStatic(props: SlateRenderElementProps) {
	const checked = !!props.element.checked;

	return (
		<div contentEditable={false}>
			<button
				className={cn(
					"peer pointer-events-none absolute -start-6 top-1 size-4 shrink-0 rounded-sm border border-primary bg-background ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
					props.className
				)}
				data-state={checked ? "checked" : "unchecked"}
				type="button"
			>
				<div className={"flex items-center justify-center text-current"}>
					{checked && <CheckIcon className="size-4" />}
				</div>
			</button>
		</div>
	);
}

function TodoLiStatic(props: SlateRenderElementProps) {
	return (
		<li
			className={cn(
				"list-none",
				!!props.element.checked && "text-muted-foreground line-through"
			)}
		>
			{props.children}
		</li>
	);
}
