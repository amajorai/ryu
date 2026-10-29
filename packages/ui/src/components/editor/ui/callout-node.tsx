"use client";

import { useCalloutEmojiPicker } from "@platejs/callout/react";
import { useEmojiDropdownMenuState } from "@platejs/emoji/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TCalloutElement } from "platejs";
import { PlateElement, type PlateElementProps } from "platejs/react";
import type { CSSProperties as ReactCSSProperties } from "react";
import editorStyles from "../editor-lint.module.css";
import { EmojiPicker, EmojiPopover } from "./emoji-toolbar-button.tsx";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorcalloutNode1-background-color"?: string | number;
}

export function CalloutElement({
	attributes,
	children,
	className,
	...props
}: PlateElementProps<TCalloutElement>) {
	const { emojiPickerState, isOpen, setIsOpen } = useEmojiDropdownMenuState({
		closeOnSelect: true,
	});

	const { emojiToolbarDropdownProps, props: calloutProps } =
		useCalloutEmojiPicker({
			isOpen,
			setIsOpen,
		});

	// The unlayered module rule outranks `bg-muted`, so attach it only when the
	// callout carries its own color; default callouts keep the muted fill.
	const backgroundColor = props.element.backgroundColor;
	const editorcalloutNode1Style: EditorVariableStyle = {
		"--editorcalloutNode1-background-color": backgroundColor,
	};
	return (
		<PlateElement
			attributes={{
				...attributes,
				"data-plate-open-context-menu": true,
			}}
			className={cn(
				cn("my-1 flex rounded-sm bg-muted p-4 ps-3", className),
				backgroundColor && editorStyles.editorcalloutNode1
			)}
			style={editorcalloutNode1Style}
			{...props}
		>
			<div className="flex w-full gap-2 rounded-md">
				<EmojiPopover
					{...emojiToolbarDropdownProps}
					control={
						<Button
							className={cn(
								"size-6 select-none p-1 text-[18px] hover:bg-muted-foreground/15",
								editorStyles.editorcalloutNode2
							)}
							contentEditable={false}
							variant="ghost"
						>
							{props.element.icon || "💡"}
						</Button>
					}
				>
					<EmojiPicker {...emojiPickerState} {...calloutProps} />
				</EmojiPopover>
				<div className="w-full">{children}</div>
			</div>
		</PlateElement>
	);
}
