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

/** Confirm step before a palette query is saved to memory. */
export function CommandPaletteRememberDialog({
	confirmRemember,
	pendingMemory,
	setPendingMemory,
}: {
	confirmRemember: () => Promise<void>;
	pendingMemory: string | null;
	setPendingMemory: (value: string | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<AlertDialog
			onOpenChange={(o) => {
				if (!o) {
					setPendingMemory(null);
				}
			}}
			open={pendingMemory !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Save this to memory?</AlertDialogTitle>
					<AlertDialogDescription>
						{pendingMemory
							? tl(
									'We\'ll remember "{pendingMemory}" so you can find it later.',
									{
										pendingMemory,
									}
								)
							: ""}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							confirmRemember();
						}}
					>
						Save
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
