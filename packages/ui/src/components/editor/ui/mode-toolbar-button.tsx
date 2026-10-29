"use client";

import { SuggestionPlugin } from "@platejs/suggestion/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { EyeIcon, PencilLineIcon, PenIcon } from "lucide-react";
import {
	useEditorReadOnly,
	useEditorRef,
	usePluginOption,
} from "platejs/react";
import { type ComponentProps, type ReactNode, useState } from "react";

import { ToolbarButton } from "./toolbar.tsx";

type ModeToolbarState = "editing" | "suggestion" | "viewing";

interface ModeToolbarItem {
	icon: ReactNode;
	label: string;
}

export function ModeToolbarButton(props: ComponentProps<typeof DropdownMenu>) {
	const editor = useEditorRef();
	const readOnly = useEditorReadOnly();
	const [open, setOpen] = useState(false);

	const isSuggesting = usePluginOption(SuggestionPlugin, "isSuggesting");

	let value: ModeToolbarState = "editing";

	if (readOnly) {
		value = "viewing";
	}

	if (isSuggesting) {
		value = "suggestion";
	}

	const item = {
		editing: {
			icon: <PenIcon />,
			label: "Editing",
		},
		suggestion: {
			icon: <PencilLineIcon />,
			label: "Suggestion",
		},
		viewing: {
			icon: <EyeIcon />,
			label: "Viewing",
		},
	} satisfies Record<ModeToolbarState, ModeToolbarItem>;
	const activeItem = item[value] ?? item.editing!;

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
			<DropdownMenuTrigger
				render={
					<ToolbarButton isDropdown pressed={open} tooltip="Editing mode" />
				}
			>
				{activeItem.icon}
				<span className="hidden lg:inline">{activeItem.label}</span>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start" className="min-w-[180px]">
				<DropdownMenuRadioGroup
					onValueChange={(newValue) => {
						if (newValue === "viewing") {
							editor.store.setReadOnly(true);

							return;
						}
						editor.store.setReadOnly(false);

						if (newValue === "suggestion") {
							editor.setOption(SuggestionPlugin, "isSuggesting", true);

							return;
						}
						editor.setOption(SuggestionPlugin, "isSuggesting", false);

						if (newValue === "editing") {
							editor.tf.focus();

							return;
						}
					}}
					value={value}
				>
					<DropdownMenuRadioItem
						className="ps-2 *:[svg]:text-muted-foreground"
						value="editing"
					>
						{item.editing!.icon}
						{item.editing!.label}
					</DropdownMenuRadioItem>

					<DropdownMenuRadioItem
						className="ps-2 *:[svg]:text-muted-foreground"
						value="viewing"
					>
						{item.viewing!.icon}
						{item.viewing!.label}
					</DropdownMenuRadioItem>

					<DropdownMenuRadioItem
						className="ps-2 *:[svg]:text-muted-foreground"
						value="suggestion"
					>
						{item.suggestion!.icon}
						{item.suggestion!.label}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
