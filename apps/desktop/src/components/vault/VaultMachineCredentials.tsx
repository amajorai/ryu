// One machine identity's credentials: its AppRole secret ids (AppRole only)
// and its live tokens. The body mounts only while the dialog is open, and
// each section is keyed by the identity, so a secret id or token shown once
// is dropped when the dialog closes. The dialog will not close while an
// issue request is in flight (Core would mint a credential nobody sees), and
// asks first while a value is still on screen (Escape, Close, or a click
// outside would otherwise drop it).

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
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { VaultMachine } from "@/src/lib/api/vault-machines.ts";
import { IDLE, type IssueState } from "./use-issue-once.ts";
import { VaultMachineSecretIds } from "./VaultMachineSecretIds.tsx";
import { VaultMachineTokens } from "./VaultMachineTokens.tsx";
import { machineKindLabel, usesSecretIds } from "./vault-machine-form.ts";

type Section = "secretIds" | "tokens";

export function VaultMachineCredentials({
	machine,
	onOpenChange,
	target,
}: {
	machine: VaultMachine | null;
	onOpenChange: (open: boolean) => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [sections, setSections] = useState<Record<Section, IssueState>>({
		secretIds: IDLE,
		tokens: IDLE,
	});
	const [confirmClose, setConfirmClose] = useState(false);
	const states = Object.values(sections);
	const issuing = states.some((state) => state.issuing);
	const showing = states.some((state) => state.showing);
	const report = (section: Section) => (state: IssueState) =>
		setSections((current) => ({ ...current, [section]: state }));
	const close = () => {
		setConfirmClose(false);
		setSections({ secretIds: IDLE, tokens: IDLE });
		onOpenChange(false);
	};

	return (
		<Dialog
			onOpenChange={(open) => {
				if (open) {
					onOpenChange(true);
				} else if (issuing) {
					// Wait for the reply; the value is shown when it comes.
				} else if (showing) {
					setConfirmClose(true);
				} else {
					close();
				}
			}}
			open={machine !== null}
		>
			<DialogContent className="sm:max-w-2xl">
				{machine ? (
					<div className="space-y-5">
						<DialogHeader>
							<DialogTitle>{machine.name}</DialogTitle>
							<DialogDescription>
								{machine.disabled
									? tl(
											"{kind} identity. It is disabled, so it cannot log in or get new tokens or secret IDs.",
											{ kind: machineKindLabel(machine) }
										)
									: tl(
											"{kind} identity. Tokens carry its policies unless a role narrows them.",
											{ kind: machineKindLabel(machine) }
										)}
							</DialogDescription>
						</DialogHeader>
						{usesSecretIds(machine) ? (
							<VaultMachineSecretIds
								key={`secret-ids-${machine.id}`}
								machine={machine}
								onStateChange={report("secretIds")}
								target={target}
							/>
						) : null}
						<VaultMachineTokens
							key={`tokens-${machine.id}`}
							machine={machine}
							onStateChange={report("tokens")}
							target={target}
						/>
					</div>
				) : null}
			</DialogContent>
			<AlertDialog onOpenChange={setConfirmClose} open={confirmClose}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Close without copying?</AlertDialogTitle>
						<AlertDialogDescription>
							The new secret ID or token is not shown again. Copy it first if
							you still need it.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep open</AlertDialogCancel>
						<AlertDialogAction onClick={close}>Close anyway</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Dialog>
	);
}
