"use client";
import { ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ReactNode,
	type Ref,
	type TableHTMLAttributes,
	useRef,
	useState,
} from "react";
import {
	extractTableDataFromElement,
	tableDataToCSV,
	tableDataToMarkdown,
	tableDataToTSV,
} from "streamdown";
import { CopyFormatMenu, writeClipboardPayload } from "./copy-format-menu.tsx";
import styles from "./markdown.module.css";
import type { MarkdownTone } from "./markdown-content.ts";

export function ExpandableMarkdownTable({
	children,
	className,
	tone = "default",
	wide = false,
	...props
}: TableHTMLAttributes<HTMLTableElement> & {
	children?: ReactNode;
	tone?: MarkdownTone;
	wide?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const tableRef = useRef<HTMLTableElement>(null);
	const tableClassName = (tableTone: MarkdownTone) =>
		cn(
			styles.table,
			tableTone === "primary"
				? "[&>tbody>tr>td]:border-primary-foreground/20 [&>tbody>tr>td]:text-primary-foreground/90 [&>thead>tr>th]:bg-primary-foreground/10 [&>thead>tr>th]:text-primary-foreground"
				: "[&>thead>tr>th]:bg-muted [&>thead]:bg-muted",
			className
		);

	const table = (
		extraClassName?: string,
		ref?: Ref<HTMLTableElement>,
		tableTone: MarkdownTone = tone
	) => (
		<table
			{...props}
			className={cn(tableClassName(tableTone), extraClassName)}
			ref={ref}
		>
			{children}
		</table>
	);

	const handleCopy = async (format: string) => {
		const element = tableRef.current;
		if (!element) {
			throw new Error("Table is not ready");
		}
		const data = extractTableDataFromElement(element);
		if (format === "png") {
			const { default: html2canvas } = await import("html2canvas-pro");
			const canvas = await html2canvas(element, {
				backgroundColor: null,
				scale: Math.min(2, window.devicePixelRatio || 1),
				useCORS: true,
			});
			const blob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob((next) => {
					if (next) {
						resolve(next);
						return;
					}
					reject(new Error("Could not encode table as PNG"));
				}, "image/png");
			});
			await writeClipboardPayload({ "image/png": blob });
			return;
		}

		const text =
			format === "csv"
				? tableDataToCSV(data)
				: format === "tsv"
					? tableDataToTSV(data)
					: tableDataToMarkdown(data);
		await writeClipboardPayload(
			{ "text/plain": text, "text/html": element.outerHTML },
			text
		);
	};

	const copyMenu = (testId?: string) => (
		<CopyFormatMenu
			ariaLabel="Copy table"
			dataTestId={testId}
			onCopy={handleCopy}
			options={[
				{ id: "markdown", label: "Copy as Markdown" },
				{ id: "csv", label: "Copy as CSV" },
				{ id: "tsv", label: "Copy as TSV" },
				{ id: "png", label: "Copy as PNG" },
			]}
		/>
	);

	return (
		<>
			<div
				className={cn(
					"group/an-md-table relative my-3 w-full max-w-full",
					wide && "-mx-4 w-[calc(100%+2rem)] max-w-[calc(100vw-2rem)]"
				)}
				data-streamdown="table-wrapper"
			>
				<div className="scroll-fade-x overflow-x-auto rounded-(--radius)">
					{table(undefined, tableRef)}
				</div>
				<div className="pointer-events-none absolute top-1 right-1 z-10 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/an-md-table:opacity-100">
					<div className="pointer-events-auto">
						{copyMenu("markdown-table-copy")}
					</div>
					<Button
						appearance="markdown-table-expand"
						aria-label="Expand table"
						className="pointer-events-auto size-7"
						data-testid="markdown-table-expand"
						onClick={() => setOpen(true)}
						size="icon-xs"
						title="Expand table"
						variant="ghost-muted"
					>
						<HugeiconsIcon icon={ExpandIcon} size={14} />
					</Button>
				</div>
			</div>
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent
					render={(props) => (
						<div
							{...props}
							className={cn(
								props.className,
								"flex max-h-[min(90vh,60rem)] max-w-[min(95vw,90rem)] flex-col gap-3"
							)}
						/>
					)}
				>
					<div
						className="flex flex-row items-start justify-between gap-4"
						data-slot="dialog-header"
					>
						<div className="min-w-0">
							<DialogTitle>Expanded markdown table</DialogTitle>
							<DialogDescription>
								Scroll horizontally or vertically to inspect the full table.
							</DialogDescription>
						</div>
						{copyMenu("markdown-table-dialog-copy")}
					</div>
					<div className="min-h-0 overflow-auto rounded-(--radius) border border-border">
						{table("min-w-[72rem]", undefined, "default")}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
