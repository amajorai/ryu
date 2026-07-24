"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { PasteDialogState } from "@ryu/ui/types/data-grid.ts";
import type { TableMeta } from "@tanstack/react-table";
import { type ComponentProps, memo, useCallback, useRef } from "react";

interface DataGridPasteDialogProps<TData> {
	pasteDialog: PasteDialogState;
	tableMeta: TableMeta<TData>;
}

export function DataGridPasteDialog<TData>({
	tableMeta,
	pasteDialog,
}: DataGridPasteDialogProps<TData>) {
	const onPasteDialogOpenChange = tableMeta?.onPasteDialogOpenChange;
	const onCellsPaste = tableMeta?.onCellsPaste;

	if (!pasteDialog.open) {
		return null;
	}

	return (
		<PasteDialog
			onCellsPaste={onCellsPaste}
			onPasteDialogOpenChange={onPasteDialogOpenChange}
			pasteDialog={pasteDialog}
		/>
	);
}

interface PasteDialogProps
	extends Pick<TableMeta<unknown>, "onPasteDialogOpenChange" | "onCellsPaste">,
		Required<Pick<TableMeta<unknown>, "pasteDialog">> {}

const PasteDialog = memo(PasteDialogImpl, (prev, next) => {
	if (prev.pasteDialog.open !== next.pasteDialog.open) {
		return false;
	}
	if (!next.pasteDialog.open) {
		return true;
	}
	if (prev.pasteDialog.rowsNeeded !== next.pasteDialog.rowsNeeded) {
		return false;
	}

	return true;
});

function PasteDialogImpl({
	pasteDialog,
	onPasteDialogOpenChange,
	onCellsPaste,
}: PasteDialogProps) {
	const propsRef = useAsRef({
		onPasteDialogOpenChange,
		onCellsPaste,
	});

	const expandRadioRef = useRef<HTMLInputElement | null>(null);

	const onOpenChange = useCallback(
		(open: boolean) => {
			propsRef.current.onPasteDialogOpenChange?.(open);
		},
		[propsRef]
	);

	const onCancel = useCallback(() => {
		propsRef.current.onPasteDialogOpenChange?.(false);
	}, [propsRef]);

	const onContinue = useCallback(() => {
		propsRef.current.onCellsPaste?.(expandRadioRef.current?.checked ?? false);
	}, [propsRef]);

	return (
		<Dialog onOpenChange={onOpenChange} open={pasteDialog.open}>
			<DialogContent data-grid-popover="">
				<DialogHeader>
					<DialogTitle>Do you want to add more rows?</DialogTitle>
					<DialogDescription>
						We need <strong>{pasteDialog.rowsNeeded}</strong> additional row
						{pasteDialog.rowsNeeded === 1 ? "" : "s"} to paste everything from
						your clipboard.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3 py-1">
					<label className="flex cursor-pointer items-start gap-3">
						<RadioItem
							defaultChecked
							name="expand-option"
							ref={expandRadioRef}
							value="expand"
						/>
						<div className="flex flex-col gap-1">
							<span className="font-medium text-sm leading-none">
								Create new rows
							</span>
							<span className="text-muted-foreground text-sm">
								Add {pasteDialog.rowsNeeded} new row
								{pasteDialog.rowsNeeded === 1 ? "" : "s"} to the table and paste
								all data
							</span>
						</div>
					</label>
					<label className="flex cursor-pointer items-start gap-3">
						<RadioItem name="expand-option" value="no-expand" />
						<div className="flex flex-col gap-1">
							<span className="font-medium text-sm leading-none">
								Keep current rows
							</span>
							<span className="text-muted-foreground text-sm">
								Paste only what fits in the existing rows
							</span>
						</div>
					</label>
				</div>
				<DialogFooter>
					<Button onClick={onCancel} variant="ghost">
						Cancel
					</Button>
					<Button onClick={onContinue}>Continue</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RadioItem({ className, ...props }: ComponentProps<"input">) {
	return (
		<input
			className={cn(
				"relative size-4 shrink-0 appearance-none rounded-full border border-input bg-background shadow-xs outline-none transition-[color,box-shadow]",
				"text-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				"disabled:cursor-not-allowed disabled:opacity-50",
				"checked:before:absolute checked:before:start-1/2 checked:before:top-1/2 checked:before:size-2 checked:before:-translate-x-1/2 checked:before:-translate-y-1/2 checked:before:rounded-full checked:before:bg-primary checked:before:content-['']",
				"dark:bg-input/30",
				className
			)}
			type="radio"
			{...props}
		/>
	);
}
