"use client";

import { toUnitLess } from "@platejs/basic-styles";
import { FontSizePlugin } from "@platejs/basic-styles/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Minus, Plus } from "lucide-react";
import type { TElement } from "platejs";
import { KEYS } from "platejs";
import { useEditorPlugin, useEditorSelector } from "platejs/react";
import { useState } from "react";

import { ToolbarButton } from "./toolbar.tsx";

const DEFAULT_FONT_SIZE = "16";

const FONT_SIZE_MAP = new Map([
	["h1", "36"],
	["h2", "24"],
	["h3", "20"],
]);

const FONT_SIZES = [
	"8",
	"9",
	"10",
	"12",
	"14",
	"16",
	"18",
	"24",
	"30",
	"36",
	"48",
	"60",
	"72",
	"96",
] as const;

export function FontSizeToolbarButton() {
	const [inputValue, setInputValue] = useState(DEFAULT_FONT_SIZE);
	const [isFocused, setIsFocused] = useState(false);
	const { editor, tf } = useEditorPlugin(FontSizePlugin);

	const cursorFontSize = useEditorSelector((editor) => {
		const fontSize = editor.api.marks()?.[KEYS.fontSize];

		// Malformed non-string marks use the existing block/default sizing path.
		if (fontSize && isNativeText(fontSize)) {
			return toUnitLess(fontSize);
		}

		const [block] = editor.api.block<TElement>() || [];

		if (!block?.type) {
			return DEFAULT_FONT_SIZE;
		}

		// Keep the selected native field reads; a missing final key uses the default.
		return FONT_SIZE_MAP.has(block.type)
			? (FONT_SIZE_MAP.get(block.type) ?? DEFAULT_FONT_SIZE)
			: DEFAULT_FONT_SIZE;
	}, []);

	const handleInputChange = () => {
		const newSize = toUnitLess(inputValue);

		if (
			Number.parseInt(newSize, 10) < 1 ||
			Number.parseInt(newSize, 10) > 100
		) {
			editor.tf.focus();

			return;
		}
		if (newSize !== toUnitLess(cursorFontSize)) {
			tf.fontSize.addMark(`${newSize}px`);
		}

		editor.tf.focus();
	};

	const handleFontSizeChange = (delta: number) => {
		const newSize = Number(displayValue) + delta;
		tf.fontSize.addMark(`${newSize}px`);
		editor.tf.focus();
	};

	const displayValue = isFocused ? inputValue : cursorFontSize;

	return (
		<div className="flex h-7 items-center gap-1 rounded-md bg-muted/60 p-0">
			<ToolbarButton onClick={() => handleFontSizeChange(-1)}>
				<Minus />
			</ToolbarButton>

			<Popover modal={false} open={isFocused}>
				<PopoverTrigger
					render={
						<input
							className={cn(
								"h-full w-10 shrink-0 bg-transparent px-1 text-center text-sm hover:bg-muted"
							)}
							data-plate-focus="true"
							onBlur={() => {
								setIsFocused(false);
								handleInputChange();
							}}
							onChange={(e) => setInputValue(e.target.value)}
							onFocus={() => {
								setIsFocused(true);
								setInputValue(toUnitLess(cursorFontSize));
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									handleInputChange();
								}
							}}
							type="text"
							value={displayValue}
						/>
					}
				/>
				<PopoverContent
					className="w-10 px-px py-1"
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					{FONT_SIZES.map((size) => (
						<button
							className={cn(
								"flex h-8 w-full items-center justify-center text-sm hover:bg-accent data-[highlighted=true]:bg-accent"
							)}
							data-highlighted={size === displayValue}
							key={size}
							onClick={() => {
								tf.fontSize.addMark(`${size}px`);
								setIsFocused(false);
							}}
							type="button"
						>
							{size}
						</button>
					))}
				</PopoverContent>
			</Popover>

			<ToolbarButton onClick={() => handleFontSizeChange(1)}>
				<Plus />
			</ToolbarButton>
		</div>
	);
}
