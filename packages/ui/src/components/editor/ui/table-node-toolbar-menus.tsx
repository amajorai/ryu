"use client";

// The table toolbar's cell-border and background-colour menus.

import { setCellBackground } from "@platejs/table";
import {
	TablePlugin,
	useTableBordersDropdownMenuContentState,
} from "@platejs/table/react";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
} from "@ryu/ui/components/color-picker.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { EraserIcon } from "lucide-react";
import { useEditorRef } from "platejs/react";
import {
	type ComponentProps,
	type ReactNode,
	useCallback,
	useState,
} from "react";

import {
	BorderAllIcon,
	BorderBottomIcon,
	BorderLeftIcon,
	BorderNoneIcon,
	BorderRightIcon,
	BorderTopIcon,
} from "./table-icons.tsx";
import { ToolbarButton } from "./toolbar.tsx";

export function TableBordersDropdownMenuContent(
	props: ComponentProps<typeof DropdownMenuContent>
) {
	const editor = useEditorRef();
	const {
		getOnSelectTableBorder,
		hasBottomBorder,
		hasLeftBorder,
		hasNoBorders,
		hasOuterBorders,
		hasRightBorder,
		hasTopBorder,
	} = useTableBordersDropdownMenuContentState();

	return (
		<DropdownMenuContent
			align="start"
			className="min-w-[220px]"
			onCloseAutoFocus={(e) => {
				e.preventDefault();
				editor.tf.focus();
			}}
			side="right"
			sideOffset={0}
			{...props}
		>
			<DropdownMenuGroup>
				<DropdownMenuCheckboxItem
					checked={hasTopBorder}
					onCheckedChange={getOnSelectTableBorder("top")}
				>
					<BorderTopIcon />
					<div>Top Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasRightBorder}
					onCheckedChange={getOnSelectTableBorder("right")}
				>
					<BorderRightIcon />
					<div>Right Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasBottomBorder}
					onCheckedChange={getOnSelectTableBorder("bottom")}
				>
					<BorderBottomIcon />
					<div>Bottom Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasLeftBorder}
					onCheckedChange={getOnSelectTableBorder("left")}
				>
					<BorderLeftIcon />
					<div>Left Border</div>
				</DropdownMenuCheckboxItem>
			</DropdownMenuGroup>

			<DropdownMenuGroup>
				<DropdownMenuCheckboxItem
					checked={hasNoBorders}
					onCheckedChange={getOnSelectTableBorder("none")}
				>
					<BorderNoneIcon />
					<div>No Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasOuterBorders}
					onCheckedChange={getOnSelectTableBorder("outer")}
				>
					<BorderAllIcon />
					<div>Outside Borders</div>
				</DropdownMenuCheckboxItem>
			</DropdownMenuGroup>
		</DropdownMenuContent>
	);
}

export function ColorDropdownMenu({
	children,
	tooltip,
}: {
	children: ReactNode;
	tooltip: string;
}) {
	const [open, setOpen] = useState(false);

	const editor = useEditorRef();

	const onUpdateColor = useCallback(
		(color: string) => {
			setCellBackground(editor, {
				color,
				selectedCells:
					editor.getApi(TablePlugin).table.getSelectedCells() ?? [],
			});
		},
		[editor]
	);

	const onClearColor = useCallback(() => {
		setOpen(false);
		setCellBackground(editor, {
			color: null,
			selectedCells: editor.getApi(TablePlugin).table.getSelectedCells() ?? [],
		});
	}, [editor]);

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
			<DropdownMenuTrigger render={<ToolbarButton tooltip={tooltip} />}>
				{children}
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start">
				<ColorPicker
					defaultValue="#000000"
					inline
					onValueChange={onUpdateColor}
					swatches={["#000000", "#ffffff", "#ff3b30", "#f0f0f0"]}
				>
					<ColorPickerContent className="w-[340px] border-0 bg-transparent p-0 shadow-none">
						<ColorPickerPanel />
					</ColorPickerContent>
				</ColorPicker>
				<DropdownMenuGroup>
					<DropdownMenuItem className="p-2" onClick={onClearColor}>
						<EraserIcon />
						<span>Clear</span>
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
