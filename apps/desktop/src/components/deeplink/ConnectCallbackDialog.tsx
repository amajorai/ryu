import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Field, FieldGroup, FieldLabel } from "@ryu/ui/components/field.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { normalizeRnpNodeUrl } from "@ryuhq/protocol/continuity";
import { useRef, useState } from "react";

export interface CallbackNode {
	name: string;
	url: string;
}

/** The opaque callback value stays in the controller, never rendered or persisted. */
export function ConnectCallbackDialog({
	nodes,
	onComplete,
	onClose,
}: {
	nodes: readonly CallbackNode[];
	onComplete: (node: CallbackNode) => Promise<void>;
	onClose: () => void;
}) {
	const [selected, setSelected] = useState<CallbackNode | null>(null);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [failed, setFailed] = useState(false);
	const submitting = useRef(false);
	const selectedUrl = selected ? normalizeRnpNodeUrl(selected.url) : null;
	async function finish() {
		if (!(selected && selectedUrl) || submitting.current || done || failed) {
			return;
		}
		submitting.current = true;
		setBusy(true);
		setFailed(false);
		try {
			await onComplete(selected);
			setDone(true);
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
			submitting.current = false;
		}
	}
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || submitting.current)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{done ? "Account connected" : "Finish connecting your account"}
					</DialogTitle>
					<DialogDescription>
						{done
							? "Return to Connections to review the account and its access policy."
							: "Continue only if you started this login. Choose the same Ryu node you used to connect the account. Ryu will verify the account for your signed-in identity."}
					</DialogDescription>
				</DialogHeader>
				{done ? null : (
					<FieldGroup>
						<Field data-disabled={busy}>
							<FieldLabel htmlFor="connect-callback-node">
								Configured node
							</FieldLabel>
							<NativeSelect
								disabled={busy}
								id="connect-callback-node"
								onChange={(event) => {
									const node = nodes.find(
										(node) => node.name === event.target.value
									);
									setSelected(node ? { name: node.name, url: node.url } : null);
								}}
								value={selected?.name ?? ""}
							>
								<NativeSelectOption value="">Choose a node</NativeSelectOption>
								{nodes.map((node) => (
									<NativeSelectOption key={node.name} value={node.name}>
										{node.name}
									</NativeSelectOption>
								))}
							</NativeSelect>
							{selected ? (
								<p className="break-all text-muted-foreground text-sm">
									{selectedUrl ?? "Invalid node address"}
								</p>
							) : null}
						</Field>
					</FieldGroup>
				)}
				{failed ? (
					<Alert variant="destructive">
						<AlertTitle>Connection could not be completed</AlertTitle>
						<AlertDescription>
							The session may have expired or the node may be unavailable. Check
							the node and your sign-in. If the result is uncertain, check
							Connections before starting another login.
						</AlertDescription>
					</Alert>
				) : null}
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="outline">
						{done ? "Done" : "Cancel"}
					</Button>
					{done ? null : (
						<Button
							disabled={!selectedUrl || busy || failed}
							onClick={finish}
							variant="mono"
						>
							{busy ? "Verifying account…" : "Verify and connect"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
