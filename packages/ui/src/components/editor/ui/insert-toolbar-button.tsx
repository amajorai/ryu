"use client";

import {
	insertBlock,
	insertInlineElement,
} from "@ryu/ui/components/editor/transforms.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import {
	CalendarIcon,
	ChevronRightIcon,
	Code2,
	Columns3Icon,
	FileCodeIcon,
	FilmIcon,
	Heading1Icon,
	Heading2Icon,
	Heading3Icon,
	ImageIcon,
	Link2Icon,
	ListIcon,
	ListOrderedIcon,
	MinusIcon,
	PenToolIcon,
	PilcrowIcon,
	PlusIcon,
	QuoteIcon,
	RadicalIcon,
	SquareIcon,
	SuperscriptIcon,
	TableIcon,
	TableOfContentsIcon,
} from "lucide-react";
import { KEYS } from "platejs";
import { type PlateEditor, useEditorRef } from "platejs/react";
import { type ComponentProps, type ReactNode, useState } from "react";

import { ToolbarButton, ToolbarMenuGroup } from "./toolbar.tsx";

interface Group {
	group: string;
	items: Item[];
}

interface Item {
	focusEditor?: boolean;
	icon: ReactNode;
	label?: string;
	onSelect: (editor: PlateEditor, value: string) => void;
	value: string;
}

const groups: Group[] = [
	{
		group: "Basic blocks",
		items: [
			{
				icon: <PilcrowIcon />,
				label: "Paragraph",
				value: KEYS.p,
			},
			{
				icon: <Heading1Icon />,
				label: "Heading 1",
				value: "h1",
			},
			{
				icon: <Heading2Icon />,
				label: "Heading 2",
				value: "h2",
			},
			{
				icon: <Heading3Icon />,
				label: "Heading 3",
				value: "h3",
			},
			{
				icon: <TableIcon />,
				label: "Table",
				value: KEYS.table,
			},
			{
				icon: <FileCodeIcon />,
				label: "Code",
				value: KEYS.codeBlock,
			},
			{
				icon: <QuoteIcon />,
				label: "Quote",
				value: KEYS.blockquote,
			},
			{
				icon: <MinusIcon />,
				label: "Divider",
				value: KEYS.hr,
			},
		].map((item) => ({
			...item,
			onSelect: (editor, value) => {
				insertBlock(editor, value);
			},
		})),
	},
	{
		group: "Lists",
		items: [
			{
				icon: <ListIcon />,
				label: "Bulleted list",
				value: KEYS.ul,
			},
			{
				icon: <ListOrderedIcon />,
				label: "Numbered list",
				value: KEYS.ol,
			},
			{
				icon: <SquareIcon />,
				label: "To-do list",
				value: KEYS.listTodo,
			},
			{
				icon: <ChevronRightIcon />,
				label: "Toggle list",
				value: KEYS.toggle,
			},
		].map((item) => ({
			...item,
			onSelect: (editor, value) => {
				insertBlock(editor, value);
			},
		})),
	},
	{
		group: "Media",
		items: [
			{
				icon: <ImageIcon />,
				label: "Image",
				value: KEYS.img,
			},
			{
				icon: <FilmIcon />,
				label: "Embed",
				value: KEYS.mediaEmbed,
			},
		].map((item) => ({
			...item,
			onSelect: (editor, value) => {
				insertBlock(editor, value);
			},
		})),
	},
	{
		group: "Advanced blocks",
		items: [
			{
				icon: <TableOfContentsIcon />,
				label: "Table of contents",
				value: KEYS.toc,
			},
			{
				icon: <Columns3Icon />,
				label: "3 columns",
				value: "action_three_columns",
			},
			{
				focusEditor: false,
				icon: <RadicalIcon />,
				label: "Equation",
				value: KEYS.equation,
			},
			{
				icon: <PenToolIcon />,
				label: "Excalidraw",
				value: KEYS.excalidraw,
			},
			{
				icon: <Code2 />,
				label: "Code Drawing",
				value: KEYS.codeDrawing,
			},
		].map((item) => ({
			...item,
			onSelect: (editor, value) => {
				insertBlock(editor, value);
			},
		})),
	},
	{
		group: "Inline",
		items: [
			{
				icon: <Link2Icon />,
				label: "Link",
				value: KEYS.link,
			},
			{
				focusEditor: true,
				icon: <CalendarIcon />,
				label: "Date",
				value: KEYS.date,
			},
			{
				focusEditor: true,
				icon: <SuperscriptIcon />,
				label: "Footnote",
				value: "action_footnote",
			},
			{
				focusEditor: false,
				icon: <RadicalIcon />,
				label: "Inline Equation",
				value: KEYS.inlineEquation,
			},
		].map((item) => ({
			...item,
			onSelect: (editor, value) => {
				insertInlineElement(editor, value);
			},
		})),
	},
];

export function InsertToolbarButton(
	props: ComponentProps<typeof DropdownMenu>
) {
	const editor = useEditorRef();
	const [open, setOpen] = useState(false);

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
			<DropdownMenuTrigger
				render={<ToolbarButton isDropdown pressed={open} tooltip="Insert" />}
			>
				<PlusIcon />
			</DropdownMenuTrigger>

			<DropdownMenuContent
				align="start"
				className="flex max-h-[500px] min-w-0 flex-col overflow-y-auto"
			>
				{groups.map(({ group, items: nestedItems }) => (
					<ToolbarMenuGroup key={group} label={group}>
						{nestedItems.map(({ icon, label, value, onSelect }) => (
							<DropdownMenuItem
								className="min-w-[180px]"
								key={value}
								onSelect={() => {
									onSelect(editor, value);
									editor.tf.focus();
								}}
							>
								{icon}
								{label}
							</DropdownMenuItem>
						))}
					</ToolbarMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
