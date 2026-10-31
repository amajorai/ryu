// apps/desktop/src/components/gateway/PlanAccountRemoveDialog.tsx
//
// Confirms removing a plan account from Settings → "Run on your own plan". Removing
// deletes that account's CLI config folder (and its sign-in) on this node.

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
import type { PlanAccountView } from "@/src/lib/api/cloud-task-backends.ts";

export function PlanAccountRemoveDialog({
	account,
	onClose,
	onConfirm,
}: {
	account: PlanAccountView | null;
	onClose: () => void;
	onConfirm: (account: PlanAccountView) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<AlertDialog
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			open={account !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{account
							? tl("Remove {tag}?", { tag: account.tag })
							: tl("Remove this account?")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						Ryu deletes this account's sign-in folder on this node, so the CLI
						is signed out of it here. Conversations that ran on it keep their
						history but cannot continue.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault();
							onClose();
							if (account) {
								onConfirm(account);
							}
						}}
					>
						Remove
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
