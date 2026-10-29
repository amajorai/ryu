"use client";

import { AIChatPlugin } from "@platejs/ai/react";
import {
	type CursorData,
	type CursorOverlayState,
	useCursorOverlay,
} from "@platejs/selection/react";
import { getTableGridAbove } from "@platejs/table";
import { cn } from "@ryu/ui/lib/utils.ts";
import { RangeApi } from "platejs";
import { useEditorRef, usePluginOption } from "platejs/react";
import { type CSSProperties, createElement } from "react";
import editorStyles from "../editor-lint.module.css";

export function CursorOverlay() {
	const { cursors } = useCursorOverlay();

	return (
		<>
			{cursors.map((cursor) => (
				<Cursor key={cursor.id} {...cursor} />
			))}
		</>
	);
}

function Cursor({
	id,
	caretPosition,
	data,
	selection,
	selectionRects,
}: CursorOverlayState<CursorData>) {
	const editor = useEditorRef();
	const streaming = usePluginOption(AIChatPlugin, "streaming");
	const { style, selectionStyle = style }: Partial<CursorData> = data ?? {};
	const isCursor = RangeApi.isCollapsed(selection);

	if (streaming) {
		return null;
	}

	// Skip overlay for multi-cell table selection (table has its own selection UI)
	if (id === "selection" && selection) {
		const cellEntries = getTableGridAbove(editor, {
			at: selection,
			format: "cell",
		});

		if (cellEntries.length > 1) {
			return null;
		}
	}

	const caretVariables: CursorVariableStyle | undefined = caretPosition
		? {
				"--cursor-left": `${caretPosition.left}px`,
				"--cursor-top": `${caretPosition.top}px`,
				"--cursor-height": `${caretPosition.height}px`,
				...style,
			}
		: undefined;
	return (
		<>
			{selectionRects.map((position, i) => {
				const {
					top: _top,
					left: _left,
					width: _width,
					height: _height,
					...selectionOverrides
				} = selectionStyle ?? {};
				const selectionVariables: CursorVariableStyle = {
					...selectionOverrides,
					"--cursor-left": `${position.left}px`,
					"--cursor-top": `${position.top}px`,
					"--cursor-width": `${position.width}px`,
					"--cursor-height": `${position.height}px`,
				};
				// Native React preserves arbitrary cursor CSSProperties overrides, including numeric units and unitless values.
				return createElement("div", {
					className: cn(
						"pointer-events-none absolute z-10",
						editorStyles.cursorPosition,
						id === "selection" && "bg-primary/25",
						id === "selection" && isCursor && "bg-primary"
					),
					key: i,
					style: selectionVariables,
				});
			})}
			{caretPosition &&
				createElement("div", {
					className: cn(
						"pointer-events-none absolute z-10 w-0.5",
						editorStyles.cursorPosition,
						id === "drag" && "w-px bg-primary"
					),
					style: caretVariables,
				})}
		</>
	);
}

interface CursorVariableStyle extends CSSProperties {
	"--cursor-height"?: string;
	"--cursor-left"?: string;
	"--cursor-top"?: string;
	"--cursor-width"?: string;
}
