import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { SlideCommit } from "@ryu/ui/components/slide-commit.tsx";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/** How long the "Deleted" pill stays visible before the dialog closes. */
const CLOSE_AFTER_DONE_MS = 600;

class DeclinedConfirmation extends Error {}

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
	const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined
	);

	useEffect(() => {
		if (open) {
			setResetKey((key) => key + 1);
		}
	}, [open]);

	useEffect(() => () => clearTimeout(closeTimer.current), []);

	// SlideCommit shows a spinner while this promise is pending, unfurls the
	// done pill when it resolves, and springs the handle home when it rejects.
	const handleConfirm = async () => {
		setConfirming(true);
		try {
			const confirmed = await onConfirm();
			if (!confirmed) {
				throw new DeclinedConfirmation();
			}
		} finally {
			setConfirming(false);
		}
	};

	const handleDone = () => {
		clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(
			() => onOpenChange(false),
			CLOSE_AFTER_DONE_MS
		);
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
				<SlideCommit
					disabled={busy}
					doneLabel="Deleted"
					errorLabel="Couldn't delete — slide to retry"
					holdMs={0}
					key={resetKey}
					keyboardSteps={5}
					label={label}
					onConfirm={handleConfirm}
					onDone={handleDone}
					width="100%"
				/>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy || confirming}>
						Cancel
					</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
