"use client";

import { importDocx } from "@platejs/docx-io";
import { MarkdownPlugin } from "@platejs/markdown";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { ArrowUpToLineIcon } from "lucide-react";
import { useEditorRef } from "platejs/react";
import { getEditorDOMFromHtmlString } from "platejs/static";
import { type ComponentProps, useState } from "react";
import { useFilePicker } from "use-file-picker";

import { ToolbarButton } from "./toolbar.tsx";

type ImportType = "html" | "markdown";

export function ImportToolbarButton(
	props: ComponentProps<typeof DropdownMenu>
) {
	const editor = useEditorRef();
	const [open, setOpen] = useState(false);

	const getFileNodes = (text: string, type: ImportType) => {
		if (type === "html") {
			const editorNode = getEditorDOMFromHtmlString(text);
			const nodes = editor.api.html.deserialize({
				element: editorNode,
			});

			return nodes;
		}

		if (type === "markdown") {
			return editor.getApi(MarkdownPlugin).markdown.deserialize(text);
		}

		return [];
	};

	const { openFilePicker: openMdFilePicker } = useFilePicker({
		accept: [".md", ".mdx"],
		multiple: false,
		onFilesSelected: async ({ plainFiles }) => {
			const text = await plainFiles[0].text();

			const nodes = getFileNodes(text, "markdown");

			editor.tf.insertNodes(nodes);
		},
	});

	const { openFilePicker: openHtmlFilePicker } = useFilePicker({
		accept: ["text/html"],
		multiple: false,
		onFilesSelected: async ({ plainFiles }) => {
			const text = await plainFiles[0].text();

			const nodes = getFileNodes(text, "html");

			editor.tf.insertNodes(nodes);
		},
	});

	const { openFilePicker: openDocxFilePicker } = useFilePicker({
		accept: [".docx"],
		multiple: false,
		onFilesSelected: async ({ plainFiles }) => {
			const arrayBuffer = await plainFiles[0].arrayBuffer();
			const result = await importDocx(editor, arrayBuffer);

			editor.tf.insertNodes(result.nodes as typeof editor.children);
		},
	});

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
			<DropdownMenuTrigger
				render={<ToolbarButton isDropdown pressed={open} tooltip="Import" />}
			>
				<ArrowUpToLineIcon className="size-4" />
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start">
				<DropdownMenuGroup>
					<DropdownMenuItem
						onSelect={() => {
							openHtmlFilePicker();
						}}
					>
						Import from HTML
					</DropdownMenuItem>

					<DropdownMenuItem
						onSelect={() => {
							openMdFilePicker();
						}}
					>
						Import from Markdown
					</DropdownMenuItem>

					<DropdownMenuItem
						onSelect={() => {
							openDocxFilePicker();
						}}
					>
						Import from Word
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
