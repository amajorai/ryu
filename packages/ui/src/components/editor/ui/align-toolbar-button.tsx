"use client";

import type { Alignment } from "@platejs/basic-styles";
import { TextAlignPlugin } from "@platejs/basic-styles/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import {
	AlignCenterIcon,
	AlignJustifyIcon,
	AlignLeftIcon,
	AlignRightIcon,
} from "lucide-react";
import { useEditorPlugin, useSelectionFragmentProp } from "platejs/react";
import { type ComponentProps, useState } from "react";

import { ToolbarButton } from "./toolbar.tsx";

const items = [
	{
		icon: AlignLeftIcon,
		value: "left",
	},
	{
		icon: AlignCenterIcon,
		value: "center",
	},
	{
		icon: AlignRightIcon,
		value: "right",
	},
	{
		icon: AlignJustifyIcon,
		value: "justify",
	},
];

export function AlignToolbarButton(props: ComponentProps<typeof DropdownMenu>) {
	const { editor, tf } = useEditorPlugin(TextAlignPlugin);
	const value =
		useSelectionFragmentProp({
			defaultValue: "start",
			getProp: (node) => node.align,
		}) ?? "left";

	const [open, setOpen] = useState(false);
	const IconValue =
		items.find((item) => item.value === value)?.icon ?? AlignLeftIcon;

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
			<DropdownMenuTrigger
				render={<ToolbarButton isDropdown pressed={open} tooltip="Align" />}
			>
				<IconValue />
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start" className="min-w-0">
				<DropdownMenuRadioGroup
					onValueChange={(value) => {
						tf.textAlign.setNodes(value as Alignment);
						editor.tf.focus();
					}}
					value={value}
				>
					{items.map(({ icon: Icon, value: itemValue }) => (
						<DropdownMenuRadioItem
							className="pl-2 data-checked:bg-accent *:first:[span]:hidden"
							key={itemValue}
							value={itemValue}
						>
							<Icon />
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
