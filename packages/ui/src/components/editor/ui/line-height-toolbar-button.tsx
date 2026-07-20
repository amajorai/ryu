"use client";

import { LineHeightPlugin } from "@platejs/basic-styles/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { WrapText } from "lucide-react";
import { useEditorRef, useSelectionFragmentProp } from "platejs/react";
import { type ComponentProps, useState } from "react";

import { ToolbarButton } from "./toolbar.tsx";

export function LineHeightToolbarButton(
	props: ComponentProps<typeof DropdownMenu>
) {
	const editor = useEditorRef();
	const { defaultNodeValue, validNodeValues: values = [] } =
		editor.getInjectProps(LineHeightPlugin);

	const value = useSelectionFragmentProp({
		defaultValue: defaultNodeValue,
		getProp: (node) => node.lineHeight,
	});

	const [open, setOpen] = useState(false);

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
			<DropdownMenuTrigger
				render={
					<ToolbarButton isDropdown pressed={open} tooltip="Line height" />
				}
			>
				<WrapText />
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start" className="min-w-0">
				<DropdownMenuRadioGroup
					onValueChange={(newValue) => {
						editor
							.getTransforms(LineHeightPlugin)
							.lineHeight.setNodes(Number(newValue));
						editor.tf.focus();
					}}
					value={value}
				>
					{values.map((value) => (
						<DropdownMenuRadioItem
							className="min-w-[180px] pl-2"
							key={value}
							value={value}
						>
							{value}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
