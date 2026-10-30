import { useLiteralMessages } from "@ryu/i18n/react";
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
import type { Memory } from "@/src/lib/api/memory.ts";

/** Confirms deleting one memory, quoting the start of its content. */
export function MemoryDeleteDialog({
	onConfirm,
	pendingDelete,
	setPendingDelete,
}: {
	onConfirm: () => void;
	pendingDelete: Memory | null;
	setPendingDelete: (memory: Memory | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<AlertDialog
			onOpenChange={(o) => {
				if (!o) {
					setPendingDelete(null);
				}
			}}
			open={pendingDelete !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete this memory?</AlertDialogTitle>
					<AlertDialogDescription>
						{pendingDelete
							? tl(
									'"{content}{ellipsis}" will be permanently removed. This cannot be undone.',
									{
										content: pendingDelete.content.slice(0, 120),
										ellipsis: pendingDelete.content.length > 120 ? "…" : "",
									}
								)
							: ""}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm} variant="destructive">
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
