import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TCalloutElement } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorcalloutNodeStatic1-background-color"?: string | number;
	"--editorcalloutNodeStatic3-background-color"?: string | number;
}

export function CalloutElementStatic({
	children,
	className,
	...props
}: SlateElementProps<TCalloutElement>) {
	const backgroundColor = props.element.backgroundColor;
	const editorcalloutNodeStatic1Style: EditorVariableStyle = {
		"--editorcalloutNodeStatic1-background-color": backgroundColor,
	};
	// The global docx-nodes rule is unlayered and outranks `bg-muted`, so tag the
	// element only when the callout carries its own color.
	const attributes = backgroundColor
		? { ...props.attributes, "data-docx-style": "editorcalloutNodeStatic1" }
		: props.attributes;
	return (
		<SlateElement
			className={cn(cn("my-1 flex rounded-sm bg-muted p-4 ps-3", className))}
			style={editorcalloutNodeStatic1Style}
			{...props}
			attributes={attributes}
		>
			<div className="flex w-full gap-2 rounded-md">
				<div
					className={"size-6 select-none text-[18px]"}
					data-docx-style="editorcalloutNodeStatic2"
				>
					<span data-plate-prevent-deserialization>
						{props.element.icon || "💡"}
					</span>
				</div>
				<div className="w-full">{children}</div>
			</div>
		</SlateElement>
	);
}

/**
 * DOCX-compatible callout component using table layout for side-by-side icon and content.
 */
export function CalloutElementDocx({
	children,
	...props
}: SlateElementProps<TCalloutElement>) {
	const backgroundColor = props.element.backgroundColor;
	const icon = props.element.icon || "💡";

	const editorcalloutNodeStatic3Style: EditorVariableStyle = {
		"--editorcalloutNodeStatic3-background-color": backgroundColor,
	};
	return (
		<SlateElement {...props}>
			<table
				data-docx-style="editorcalloutNodeStatic3"
				style={editorcalloutNodeStatic3Style}
			>
				<tbody>
					<tr>
						<td data-docx-style="editorcalloutNodeStatic4">
							<span data-plate-prevent-deserialization>{icon}</span>
						</td>
						<td data-docx-style="editorcalloutNodeStatic5">{children}</td>
					</tr>
				</tbody>
			</table>
		</SlateElement>
	);
}
