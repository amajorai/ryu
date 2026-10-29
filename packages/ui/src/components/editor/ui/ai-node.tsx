"use client";

import { AIChatPlugin } from "@platejs/ai/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	PlateElement,
	type PlateElementProps,
	PlateText,
	type PlateTextProps,
	usePluginOption,
} from "platejs/react";

export function AILeaf(props: PlateTextProps) {
	const streaming = usePluginOption(AIChatPlugin, "streaming");
	const streamingLeaf = props.editor
		.getApi(AIChatPlugin)
		.aiChat.node({ streaming: true });

	const isLast = streamingLeaf?.[0] === props.text;

	return (
		<PlateText
			className={cn(
				"border-b-2 border-b-border bg-muted text-primary",
				"transition-[color,background-color,border-color] duration-200 ease-in-out",
				isLast &&
					streaming &&
					'after:ms-1.5 after:inline-block after:h-3 after:w-3 after:rounded-full after:bg-primary after:align-middle after:content-[""]'
			)}
			{...props}
		/>
	);
}

export function AIAnchorElement(props: PlateElementProps) {
	return (
		<PlateElement {...props}>
			<div className="h-[0.1px]" />
		</PlateElement>
	);
}
