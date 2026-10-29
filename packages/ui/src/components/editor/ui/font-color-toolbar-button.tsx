"use client";

import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
} from "@ryu/ui/components/color-picker.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { EraserIcon } from "lucide-react";
import {
	type PlateEditor,
	useEditorRef,
	useEditorSelector,
} from "platejs/react";
import React from "react";
import { isNativeText } from "../../../lib/native-primitive-observation.ts";

import { ToolbarButton, ToolbarMenuGroup } from "./toolbar.tsx";

function getEditorColorMarks(editor: PlateEditor, nodeType: string): string[] {
	const colors = new Set<string>();
	for (const [node] of editor.api.nodes({
		at: [],
		match: (candidate) =>
			"text" in candidate && isNativeText(candidate[nodeType]),
		mode: "all",
	})) {
		const value = node[nodeType];
		if (isNativeText(value)) {
			colors.add(value);
		}
	}
	return [...colors];
}

export function FontColorToolbarButton({
	children,
	nodeType,
	tooltip,
}: {
	nodeType: string;
	tooltip?: string;
	children?: React.ReactNode;
} & Omit<React.ComponentProps<typeof DropdownMenu>, "children">) {
	const editor = useEditorRef();

	const selectionDefined = useEditorSelector(
		(editor) => !!editor.selection,
		[]
	);

	const color = useEditorSelector(
		(editor) => {
			const mark = editor.api.mark(nodeType);
			// Only string marks are valid ColorPicker input; malformed marks are absent.
			return isNativeText(mark) ? mark : undefined;
		},
		[nodeType]
	);

	const [selectedColor, setSelectedColor] = React.useState<string>();
	const [open, setOpen] = React.useState(false);
	const [documentColors, setDocumentColors] = React.useState<string[]>([]);

	const onToggle = React.useCallback(
		(value = !open) => {
			setOpen(value);
			if (value) {
				setDocumentColors(getEditorColorMarks(editor, nodeType));
			}
			if (!value && editor.selection) {
				setTimeout(() => {
					editor.tf.focus();
				}, 100);
			}
		},
		[open, editor, nodeType]
	);

	const updateColor = React.useCallback(
		(value: string) => {
			if (editor.selection) {
				setSelectedColor(value);

				editor.tf.select(editor.selection);
				editor.tf.addMarks({ [nodeType]: value });
			}
		},
		[editor, nodeType]
	);

	const clearColor = React.useCallback(() => {
		if (editor.selection) {
			editor.tf.select(editor.selection);
			editor.tf.removeMarks(nodeType);
			onToggle(false);
		}
	}, [editor, onToggle, nodeType]);

	React.useEffect(() => {
		if (selectionDefined) {
			// eslint-disable-next-line react-hooks/set-state-in-effect -- Preserve the mark color while menu focus clears editor selection.
			setSelectedColor(color);
		}
	}, [color, selectionDefined]);

	return (
		<DropdownMenu modal onOpenChange={onToggle} open={open}>
			<DropdownMenuTrigger
				render={<ToolbarButton pressed={open} tooltip={tooltip} />}
			>
				{children}
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start">
				<ColorPicker
					defaultValue={selectedColor || color || "#000000"}
					inline
					onValueChange={updateColor}
					swatches={[
						...DEFAULT_COLORS.slice(0, 20).map((item) => item.value),
						...documentColors,
					]}
					value={selectedColor || color || "#000000"}
				>
					<ColorPickerContent className="w-[340px] border-0 bg-transparent p-0 shadow-none">
						<ColorPickerPanel />
					</ColorPickerContent>
				</ColorPicker>
				{color && (
					<ToolbarMenuGroup>
						<DropdownMenuItem className="mt-3 p-2" onClick={clearColor}>
							<EraserIcon />
							<span>Clear</span>
						</DropdownMenuItem>
					</ToolbarMenuGroup>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export const DEFAULT_COLORS = [
	{
		isBrightColor: false,
		name: "black",
		value: "#000000",
	},
	{
		isBrightColor: false,
		name: "dark grey 4",
		value: "#434343",
	},
	{
		isBrightColor: false,
		name: "dark grey 3",
		value: "#666666",
	},
	{
		isBrightColor: false,
		name: "dark grey 2",
		value: "#999999",
	},
	{
		isBrightColor: false,
		name: "dark grey 1",
		value: "#B7B7B7",
	},
	{
		isBrightColor: false,
		name: "grey",
		value: "#CCCCCC",
	},
	{
		isBrightColor: false,
		name: "light grey 1",
		value: "#D9D9D9",
	},
	{
		isBrightColor: true,
		name: "light grey 2",
		value: "#EFEFEF",
	},
	{
		isBrightColor: true,
		name: "light grey 3",
		value: "#F3F3F3",
	},
	{
		isBrightColor: true,
		name: "white",
		value: "#FFFFFF",
	},
	{
		isBrightColor: false,
		name: "red berry",
		value: "#980100",
	},
	{
		isBrightColor: false,
		name: "red",
		value: "#FE0000",
	},
	{
		isBrightColor: false,
		name: "orange",
		value: "#FE9900",
	},
	{
		isBrightColor: true,
		name: "yellow",
		value: "#FEFF00",
	},
	{
		isBrightColor: false,
		name: "green",
		value: "#00FF00",
	},
	{
		isBrightColor: false,
		name: "cyan",
		value: "#00FFFF",
	},
	{
		isBrightColor: false,
		name: "cornflower blue",
		value: "#4B85E8",
	},
	{
		isBrightColor: false,
		name: "blue",
		value: "#1300FF",
	},
	{
		isBrightColor: false,
		name: "purple",
		value: "#9900FF",
	},
	{
		isBrightColor: false,
		name: "magenta",
		value: "#FF00FF",
	},

	{
		isBrightColor: false,
		name: "light red berry 3",
		value: "#E6B8AF",
	},
	{
		isBrightColor: false,
		name: "light red 3",
		value: "#F4CCCC",
	},
	{
		isBrightColor: true,
		name: "light orange 3",
		value: "#FCE4CD",
	},
	{
		isBrightColor: true,
		name: "light yellow 3",
		value: "#FFF2CC",
	},
	{
		isBrightColor: true,
		name: "light green 3",
		value: "#D9EAD3",
	},
	{
		isBrightColor: false,
		name: "light cyan 3",
		value: "#D0DFE3",
	},
	{
		isBrightColor: false,
		name: "light cornflower blue 3",
		value: "#C9DAF8",
	},
	{
		isBrightColor: true,
		name: "light blue 3",
		value: "#CFE1F3",
	},
	{
		isBrightColor: true,
		name: "light purple 3",
		value: "#D9D2E9",
	},
	{
		isBrightColor: true,
		name: "light magenta 3",
		value: "#EAD1DB",
	},

	{
		isBrightColor: false,
		name: "light red berry 2",
		value: "#DC7E6B",
	},
	{
		isBrightColor: false,
		name: "light red 2",
		value: "#EA9999",
	},
	{
		isBrightColor: false,
		name: "light orange 2",
		value: "#F9CB9C",
	},
	{
		isBrightColor: true,
		name: "light yellow 2",
		value: "#FFE598",
	},
	{
		isBrightColor: false,
		name: "light green 2",
		value: "#B7D6A8",
	},
	{
		isBrightColor: false,
		name: "light cyan 2",
		value: "#A1C4C9",
	},
	{
		isBrightColor: false,
		name: "light cornflower blue 2",
		value: "#A4C2F4",
	},
	{
		isBrightColor: false,
		name: "light blue 2",
		value: "#9FC5E8",
	},
	{
		isBrightColor: false,
		name: "light purple 2",
		value: "#B5A7D5",
	},
	{
		isBrightColor: false,
		name: "light magenta 2",
		value: "#D5A6BD",
	},

	{
		isBrightColor: false,
		name: "light red berry 1",
		value: "#CC4125",
	},
	{
		isBrightColor: false,
		name: "light red 1",
		value: "#E06666",
	},
	{
		isBrightColor: false,
		name: "light orange 1",
		value: "#F6B26B",
	},
	{
		isBrightColor: false,
		name: "light yellow 1",
		value: "#FFD966",
	},
	{
		isBrightColor: false,
		name: "light green 1",
		value: "#93C47D",
	},
	{
		isBrightColor: false,
		name: "light cyan 1",
		value: "#76A5AE",
	},
	{
		isBrightColor: false,
		name: "light cornflower blue 1",
		value: "#6C9EEB",
	},
	{
		isBrightColor: false,
		name: "light blue 1",
		value: "#6FA8DC",
	},
	{
		isBrightColor: false,
		name: "light purple 1",
		value: "#8D7CC3",
	},
	{
		isBrightColor: false,
		name: "light magenta 1",
		value: "#C27BA0",
	},

	{
		isBrightColor: false,
		name: "dark red berry 1",
		value: "#A61B00",
	},
	{
		isBrightColor: false,
		name: "dark red 1",
		value: "#CC0000",
	},
	{
		isBrightColor: false,
		name: "dark orange 1",
		value: "#E59138",
	},
	{
		isBrightColor: false,
		name: "dark yellow 1",
		value: "#F1C231",
	},
	{
		isBrightColor: false,
		name: "dark green 1",
		value: "#6AA74F",
	},
	{
		isBrightColor: false,
		name: "dark cyan 1",
		value: "#45818E",
	},
	{
		isBrightColor: false,
		name: "dark cornflower blue 1",
		value: "#3B78D8",
	},
	{
		isBrightColor: false,
		name: "dark blue 1",
		value: "#3E84C6",
	},
	{
		isBrightColor: false,
		name: "dark purple 1",
		value: "#664EA6",
	},
	{
		isBrightColor: false,
		name: "dark magenta 1",
		value: "#A64D78",
	},

	{
		isBrightColor: false,
		name: "dark red berry 2",
		value: "#84200D",
	},
	{
		isBrightColor: false,
		name: "dark red 2",
		value: "#990001",
	},
	{
		isBrightColor: false,
		name: "dark orange 2",
		value: "#B45F05",
	},
	{
		isBrightColor: false,
		name: "dark yellow 2",
		value: "#BF9002",
	},
	{
		isBrightColor: false,
		name: "dark green 2",
		value: "#38761D",
	},
	{
		isBrightColor: false,
		name: "dark cyan 2",
		value: "#124F5C",
	},
	{
		isBrightColor: false,
		name: "dark cornflower blue 2",
		value: "#1155CB",
	},
	{
		isBrightColor: false,
		name: "dark blue 2",
		value: "#0C5394",
	},
	{
		isBrightColor: false,
		name: "dark purple 2",
		value: "#351C75",
	},
	{
		isBrightColor: false,
		name: "dark magenta 2",
		value: "#741B47",
	},

	{
		isBrightColor: false,
		name: "dark red berry 3",
		value: "#5B0F00",
	},
	{
		isBrightColor: false,
		name: "dark red 3",
		value: "#660000",
	},
	{
		isBrightColor: false,
		name: "dark orange 3",
		value: "#783F04",
	},
	{
		isBrightColor: false,
		name: "dark yellow 3",
		value: "#7E6000",
	},
	{
		isBrightColor: false,
		name: "dark green 3",
		value: "#274E12",
	},
	{
		isBrightColor: false,
		name: "dark cyan 3",
		value: "#0D343D",
	},
	{
		isBrightColor: false,
		name: "dark cornflower blue 3",
		value: "#1B4487",
	},
	{
		isBrightColor: false,
		name: "dark blue 3",
		value: "#083763",
	},
	{
		isBrightColor: false,
		name: "dark purple 3",
		value: "#1F124D",
	},
	{
		isBrightColor: false,
		name: "dark magenta 3",
		value: "#4C1130",
	},
];
