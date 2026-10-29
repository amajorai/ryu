"use client";

import { MarkdownPlugin } from "@platejs/markdown";
import { BaseEditorKit } from "@ryu/ui/components/editor/editor-base-kit.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { ArrowDownToLineIcon } from "lucide-react";
import { createSlateEditor } from "platejs";
import { useEditorRef } from "platejs/react";
import { serializeHtml } from "platejs/static";
import { type ComponentProps, useState } from "react";
import { exportEditorDocx } from "../lib/export-editor-docx.ts";
import { buildStandaloneEditorHtml } from "../lib/standalone-editor-html.ts";
import { EditorStatic } from "./editor-static.tsx";
import { ToolbarButton } from "./toolbar.tsx";

export function ExportToolbarButton(
	props: ComponentProps<typeof DropdownMenu>
) {
	const editor = useEditorRef();
	const [open, setOpen] = useState(false);

	const getCanvas = async () => {
		const { default: html2canvas } = await import("html2canvas-pro");

		const style = document.createElement("style");
		document.head.append(style);

		const canvas = await html2canvas(editor.api.toDOMNode(editor)!, {
			onclone: (document: Document) => {
				const editorElement = document.querySelector(
					'[contenteditable="true"]'
				);
				if (editorElement) {
					Array.from(editorElement.querySelectorAll("*")).forEach((element) => {
						const existingStyle = element.getAttribute("style") || "";
						element.setAttribute(
							"style",
							`${existingStyle}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important`
						);
					});
				}
			},
		});
		style.remove();

		return canvas;
	};

	const downloadFile = async (url: string, filename: string) => {
		const response = await fetch(url);

		const blob = await response.blob();
		const blobUrl = window.URL.createObjectURL(blob);

		const link = document.createElement("a");
		link.href = blobUrl;
		link.download = filename;
		document.body.append(link);
		link.click();
		link.remove();

		// Clean up the blob URL
		window.URL.revokeObjectURL(blobUrl);
	};

	const exportToPdf = async () => {
		const canvas = await getCanvas();

		const PDFLib = await import("pdf-lib");
		const pdfDoc = await PDFLib.PDFDocument.create();
		const page = pdfDoc.addPage([canvas.width, canvas.height]);
		const imageEmbed = await pdfDoc.embedPng(canvas.toDataURL("PNG"));
		const { height, width } = imageEmbed.scale(1);
		page.drawImage(imageEmbed, {
			height,
			width,
			x: 0,
			y: 0,
		});
		const pdfBase64 = await pdfDoc.saveAsBase64({ dataUri: true });

		await downloadFile(pdfBase64, "plate.pdf");
	};

	const exportToImage = async () => {
		const canvas = await getCanvas();
		await downloadFile(canvas.toDataURL("image/png"), "plate.png");
	};

	const exportToHtml = async () => {
		const editorStatic = createSlateEditor({
			plugins: BaseEditorKit,
			value: editor.children,
		});

		const editorHtml = await serializeHtml(editorStatic, {
			editorComponent: EditorStatic,
			props: { style: { padding: "0 calc(50% - 350px)", paddingBottom: "" } },
		});

		const html = buildStandaloneEditorHtml(editorHtml);

		const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

		await downloadFile(url, "plate.html");
	};

	const exportToMarkdown = async () => {
		const md = editor.getApi(MarkdownPlugin).markdown.serialize();
		const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`;
		await downloadFile(url, "plate.md");
	};

	const exportToWord = async () => {
		const blob = await exportEditorDocx(editor.children);

		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "plate.docx";
		document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	};

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
			<DropdownMenuTrigger
				render={<ToolbarButton isDropdown pressed={open} tooltip="Export" />}
			>
				<ArrowDownToLineIcon className="size-4" />
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start">
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={exportToHtml}>
						Export as HTML
					</DropdownMenuItem>
					<DropdownMenuItem onClick={exportToPdf}>
						Export as PDF
					</DropdownMenuItem>
					<DropdownMenuItem onClick={exportToImage}>
						Export as Image
					</DropdownMenuItem>
					<DropdownMenuItem onClick={exportToMarkdown}>
						Export as Markdown
					</DropdownMenuItem>
					<DropdownMenuItem onClick={exportToWord}>
						Export as Word
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
