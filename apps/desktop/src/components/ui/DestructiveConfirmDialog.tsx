import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { CutToConfirm } from "@ryu/ui/components/cut-to-confirm.tsx";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

export function DestructiveConfirmDialog({
	description,
	label,
	onConfirm,
	onOpenChange,
	open,
	title,
	busy = false,
	error,
	impact,
}: {
	busy?: boolean;
	description: string;
	error?: string | null;
	impact?: ReactNode;
	label: string;
	onConfirm: () => boolean | Promise<boolean>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}) {
	const [confirming, setConfirming] = useState(false);
	const [resetKey, setResetKey] = useState(0);

	useEffect(() => {
		if (open) {
			setResetKey((key) => key + 1);
		}
	}, [open]);

	const handleConfirm = () => {
		if (confirming || busy) {
			return;
		}
		setConfirming(true);
		void Promise.resolve(onConfirm())
			.then((confirmed) => {
				if (confirmed) {
					onOpenChange(false);
				} else {
					setResetKey((key) => key + 1);
				}
			})
			.catch(() => {
				setResetKey((key) => key + 1);
			})
			.finally(() => setConfirming(false));
	};

	return (
		<AlertDialog onOpenChange={onOpenChange} open={open}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{error ? (
					<p
						aria-live="polite"
						className="text-sm text-status-destructive"
						role="alert"
					>
						{error}
					</p>
				) : null}
				{impact ? (
					<div className="rounded-lg border bg-muted/40 p-3 text-sm">
						{impact}
					</div>
				) : null}
				<CutToConfirm
					disabled={busy || confirming}
					label={label}
					onConfirm={handleConfirm}
					renderHint={(progress) => {
						if (progress >= 1) {
							return "Deleting…";
						}
						if (progress > 0) {
							return `${Math.round(progress * 5)} of 5 steps — keep sliding`;
						}
						return "Slide across the blade to confirm";
					}}
					resetKey={resetKey}
				>
					<div className="flex min-h-16 items-center justify-center px-4 text-center text-muted-foreground text-sm">
						{label}
					</div>
				</CutToConfirm>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy || confirming}>
						Cancel
					</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
