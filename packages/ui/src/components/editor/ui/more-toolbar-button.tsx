"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import {
	KeyboardIcon,
	MoreHorizontalIcon,
	SubscriptIcon,
	SuperscriptIcon,
} from "lucide-react";
import { KEYS } from "platejs";
import { useEditorRef } from "platejs/react";
import { type ComponentProps, useState } from "react";

import { ToolbarButton } from "./toolbar.tsx";

export function MoreToolbarButton(props: ComponentProps<typeof DropdownMenu>) {
	const editor = useEditorRef();
	const [open, setOpen] = useState(false);

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
			<DropdownMenuTrigger
				render={<ToolbarButton pressed={open} tooltip="Insert" />}
			>
				<MoreHorizontalIcon />
			</DropdownMenuTrigger>

			<DropdownMenuContent
				align="start"
				className="ignore-click-outside/toolbar flex max-h-[500px] min-w-[180px] flex-col overflow-y-auto"
			>
				<DropdownMenuGroup>
					<DropdownMenuItem
						onSelect={() => {
							editor.tf.toggleMark(KEYS.kbd);
							editor.tf.collapse({ edge: "end" });
							editor.tf.focus();
						}}
					>
						<KeyboardIcon />
						Keyboard input
					</DropdownMenuItem>

					<DropdownMenuItem
						onSelect={() => {
							editor.tf.toggleMark(KEYS.sup, {
								remove: KEYS.sub,
							});
							editor.tf.focus();
						}}
					>
						<SuperscriptIcon />
						Superscript
						{/* (⌘+,) */}
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() => {
							editor.tf.toggleMark(KEYS.sub, {
								remove: KEYS.sup,
							});
							editor.tf.focus();
						}}
					>
						<SubscriptIcon />
						Subscript
						{/* (⌘+.) */}
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
