/**
 * Confirms a save that edits the system prompt (goals, instructions, tone,
 * output style, brief replies, skills). Providers cache the prompt as one
 * prefix, so the change is a one-time cache miss for every affected thread.
 * The copy comes from `promptEditCacheWarning` so every editor says the same
 * thing.
 */

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

export interface PromptCacheConfirmation {
	description: string;
	title: string;
}

export function PromptCacheConfirmDialog({
	confirmation,
	onApply,
	onCancel,
}: {
	confirmation: PromptCacheConfirmation | null;
	onApply: () => void;
	onCancel: () => void;
}) {
	return (
		<AlertDialog
			onOpenChange={(open) => !open && onCancel()}
			open={confirmation !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
					<AlertDialogDescription>
						{confirmation?.description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onApply}>Apply now</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
