// Small seal-status indicator. Admins can seal the vault, and unseal it with a
// key share (Shamir mode) or the node's master key (auto mode). A share is held
// only in the dialog's input and cleared after every submit.

import {
	SquareLock01Icon,
	SquareUnlock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	sealVault,
	unsealVault,
	type VaultSealStatus,
} from "@/src/lib/api/vault.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

export function VaultSealControl({
	canManage,
	seal,
	target,
}: {
	canManage: boolean;
	seal: VaultSealStatus;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [confirmSeal, setConfirmSeal] = useState(false);
	const [unsealOpen, setUnsealOpen] = useState(false);
	const [share, setShare] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const shamir = seal.mode === "shamir";

	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: ["vault"] });
	};

	const doSeal = async () => {
		setPending(true);
		try {
			await sealVault(target);
			setConfirmSeal(false);
			await refresh();
			sileo.success({ title: "Vault sealed" });
		} catch (caught) {
			sileo.error({
				title: "Could not seal",
				description: vaultErrorMessage(caught, "Try again."),
			});
		} finally {
			setPending(false);
		}
	};

	const doUnseal = async () => {
		setError(null);
		setPending(true);
		try {
			const status = await unsealVault(
				target,
				shamir ? share.trim() : undefined
			);
			setShare("");
			await refresh();
			if (status.sealed) {
				sileo.success({
					title: tl("Share accepted ({progress}/{threshold})", {
						progress: status.progress,
						threshold: status.threshold,
					}),
				});
			} else {
				setUnsealOpen(false);
				sileo.success({ title: "Vault unsealed" });
			}
		} catch (caught) {
			setShare("");
			setError(vaultErrorMessage(caught, "Could not unseal."));
		} finally {
			setPending(false);
		}
	};

	const label = seal.sealed
		? shamir
			? `Sealed ${seal.progress}/${seal.threshold}`
			: "Sealed"
		: "Unsealed";
	let ariaLabel = tl("Vault unsealed");
	if (seal.sealed) {
		ariaLabel = shamir
			? tl("Vault sealed {progress}/{threshold}", {
					progress: seal.progress,
					threshold: seal.threshold,
				})
			: tl("Vault sealed");
	}

	return (
		<div className="flex items-center gap-1">
			<Badge
				aria-label={ariaLabel}
				variant={seal.sealed ? "destructive" : "secondary"}
			>
				<HugeiconsIcon
					className="size-3"
					icon={seal.sealed ? SquareLock01Icon : SquareUnlock01Icon}
				/>
				{label}
			</Badge>
			{canManage ? (
				seal.sealed ? (
					<Button onClick={() => setUnsealOpen(true)} size="sm" variant="ghost">
						Unseal
					</Button>
				) : (
					<Button
						onClick={() => setConfirmSeal(true)}
						size="sm"
						variant="ghost"
					>
						Seal
					</Button>
				)
			) : null}

			<AlertDialog onOpenChange={setConfirmSeal} open={confirmSeal}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Seal the vault?</AlertDialogTitle>
						<AlertDialogDescription>
							{shamir
								? tl(
										"MCP calls stop receiving secrets until the vault is unsealed. Unsealing needs key shares."
									)
								: tl(
										"MCP calls stop receiving secrets until the vault is unsealed."
									)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={pending}
							onClick={(event) => {
								event.preventDefault();
								doSeal();
							}}
						>
							{pending ? "Sealing…" : "Seal vault"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<Dialog
				onOpenChange={(open) => {
					setUnsealOpen(open);
					if (!open) {
						setShare("");
						setError(null);
					}
				}}
				open={unsealOpen}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Unseal the vault</DialogTitle>
						<DialogDescription>
							{shamir
								? tl("Enter a key share. {progress} of {threshold} received.", {
										progress: seal.progress,
										threshold: seal.threshold,
									})
								: "Unseal with this node's master key."}
						</DialogDescription>
					</DialogHeader>
					{shamir ? (
						<div className="space-y-1.5">
							<Label htmlFor="vault-unseal-share">Key share</Label>
							<Input
								autoComplete="off"
								id="vault-unseal-share"
								onChange={(event) => setShare(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && share.trim()) {
										doUnseal();
									}
								}}
								type="password"
								value={share}
							/>
						</div>
					) : null}
					{error ? (
						<p className="text-sm text-status-destructive">{error}</p>
					) : null}
					<DialogFooter>
						<Button
							disabled={pending || (shamir && share.trim() === "")}
							loading={pending}
							onClick={doUnseal}
							variant="mono"
						>
							{shamir ? "Submit share" : "Unseal"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
