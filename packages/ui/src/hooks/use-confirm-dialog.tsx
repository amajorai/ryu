"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

interface ConfirmationOptions {
	cancelLabel?: string;
	confirmLabel?: string;
	description?: ReactNode;
	destructive?: boolean;
}

/** Await a shared confirmation while keeping its modal in the caller's React tree. */
export function useConfirmDialog() {
	const [request, setRequest] = useState<{
		title: string;
		options: ConfirmationOptions;
	} | null>(null);
	const [open, setOpen] = useState(false);
	const pending = useRef<((accepted: boolean) => void) | null>(null);
	const focusTarget = useRef<HTMLElement | null>(null);
	const descriptionId = useId();

	useEffect(
		() => () => {
			pending.current?.(false);
			pending.current = null;
		},
		[]
	);

	const confirm = useCallback(
		(title: string, options: ConfirmationOptions = {}) =>
			new Promise<boolean>((resolve) => {
				if (
					!pending.current &&
					globalThis.document !== undefined &&
					document.activeElement instanceof HTMLElement
				) {
					focusTarget.current = document.activeElement;
				}
				pending.current?.(false);
				pending.current = resolve;
				setRequest({ title, options });
				setOpen(true);
			}),
		[]
	);

	const finish = useCallback((accepted: boolean) => {
		const resolve = pending.current;
		pending.current = null;
		setOpen(false);
		resolve?.(accepted);
	}, []);

	const confirmationDialog = (
		<AlertDialog
			onOpenChange={(open) => {
				if (!open) {
					finish(false);
				}
			}}
			open={open}
		>
			<AlertDialogContent
				aria-describedby={
					request?.options.description ? descriptionId : undefined
				}
				finalFocus={focusTarget}
			>
				<AlertDialogHeader>
					<AlertDialogTitle className="break-words">
						{request?.title ?? ""}
					</AlertDialogTitle>
					{request?.options.description ? (
						<AlertDialogDescription id={descriptionId}>
							{request.options.description}
						</AlertDialogDescription>
					) : null}
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel onClick={() => finish(false)}>
						{request?.options.cancelLabel ?? "Cancel"}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => finish(true)}
						variant={request?.options.destructive ? "destructive" : "default"}
					>
						{request?.options.confirmLabel ?? "Continue"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
	return { confirm, confirmationDialog };
}
