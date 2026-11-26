// Machine identities (`admin` on `sys/machines`): what each logs in with, its
// policies, and whether it is disabled. Credentials opens its secret ids and
// tokens. Disabling and deleting ask first and say what Core does: both send
// every token through the revoke tree (children, cubbyholes, leases);
// disabling keeps secret ids, deleting removes them and the bindings. If a
// provider refuses a lease, Core fails with its id and the identity stays
// disabled, so the list is refreshed on failure too. AppRole
// identities can be created here; other kinds come from `ryu-cli secrets
// machine create`.

import { Add01Icon } from "@hugeicons/core-free-icons";
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
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteVaultMachine,
	listVaultMachines,
	setVaultMachineDisabled,
	type VaultMachine,
} from "@/src/lib/api/vault-machines.ts";
import { VaultAppRoleDialog } from "./VaultAppRoleDialog.tsx";
import { VaultListRow } from "./VaultListRow.tsx";
import { VaultMachineCredentials } from "./VaultMachineCredentials.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import { machineKindLabel } from "./vault-machine-form.ts";
import { formatTtl } from "./vault-ttl.ts";

interface Pending {
	action: "delete" | "disable";
	machine: VaultMachine;
}

export function VaultMachinesPanel({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [creating, setCreating] = useState(false);
	const [openId, setOpenId] = useState<string | null>(null);
	const [asking, setAsking] = useState<Pending | null>(null);
	const machinesQuery = useQuery({
		queryKey: ["vault", "machines", target.url],
		queryFn: () => listVaultMachines(target),
	});
	const failed = (error: unknown) =>
		sileo.error({
			title: tl("That did not work"),
			description: vaultErrorMessage(error, tl("Try again."), tl),
		});
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["vault", "machines"] });
	const toggle = useMutation({
		mutationFn: ({ id, disabled }: { disabled: boolean; id: string }) =>
			setVaultMachineDisabled(target, id, disabled),
		onSuccess: async (machine) => {
			setAsking((current) =>
				current?.machine.id === machine.id ? null : current
			);
			await refresh();
			sileo.success({
				title: machine.disabled
					? tl("Disabled {name}", { name: machine.name })
					: tl("Enabled {name}", { name: machine.name }),
			});
		},
		onError: async (error) => {
			failed(error);
			await refresh();
		},
	});
	const remove = useMutation({
		mutationFn: (machine: VaultMachine) =>
			deleteVaultMachine(target, machine.id),
		onSuccess: async (_deleted, machine) => {
			setAsking((current) =>
				current?.machine.id === machine.id ? null : current
			);
			await refresh();
			sileo.success({ title: tl("Deleted {name}", { name: machine.name }) });
		},
		onError: async (error) => {
			failed(error);
			await refresh();
		},
	});
	const machines = machinesQuery.data ?? [];
	// Read from the list, so the dialog shows a disable made elsewhere.
	const open = machines.find((machine) => machine.id === openId) ?? null;
	const deciding = remove.isPending || toggle.isPending;
	const detail = (machine: VaultMachine) =>
		[
			machine.policies.length ? machine.policies.join(", ") : tl("No policies"),
			tl("Token lifetime {ttl}", { ttl: formatTtl(machine.tokenTtlSecs) }),
		].join(" · ");

	return (
		<SettingsSection
			caption="Services and CI jobs that log in to the vault. Each gets tokens that carry its policies."
			headerAction={
				<Button onClick={() => setCreating(true)} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					New AppRole
				</Button>
			}
			title="Machine identities"
		>
			<SettingsCard className="p-0">
				{machinesQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : machinesQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							machinesQuery.error,
							"Could not load machine identities.",
							tl
						)}
					</p>
				) : machines.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No machine identities yet.
					</p>
				) : (
					<ul className="divide-y">
						{machines.map((machine) => (
							<VaultListRow
								actions={
									<>
										<Button
											aria-label={tl("Credentials for {name}", {
												name: machine.name,
											})}
											onClick={() => setOpenId(machine.id)}
											size="sm"
											variant="ghost"
										>
											Credentials
										</Button>
										{machine.disabled ? (
											<Button
												aria-label={tl("Enable {name}", { name: machine.name })}
												disabled={toggle.isPending}
												onClick={() =>
													toggle.mutate({ id: machine.id, disabled: false })
												}
												size="sm"
												variant="ghost"
											>
												Enable
											</Button>
										) : (
											<Button
												aria-label={tl("Disable {name}", {
													name: machine.name,
												})}
												onClick={() =>
													setAsking({ action: "disable", machine })
												}
												size="sm"
												variant="ghost"
											>
												Disable
											</Button>
										)}
										<Button
											aria-label={tl("Delete {name}", { name: machine.name })}
											onClick={() => setAsking({ action: "delete", machine })}
											size="sm"
											variant="ghost"
										>
											Delete
										</Button>
									</>
								}
								detail={detail(machine)}
								key={machine.id}
								title={
									<>
										<span className="font-medium">{machine.name}</span>
										<Badge variant="outline">{machineKindLabel(machine)}</Badge>
										{machine.disabled ? (
											<Badge variant="outline">Disabled</Badge>
										) : null}
									</>
								}
							/>
						))}
					</ul>
				)}
			</SettingsCard>
			<VaultAppRoleDialog
				onCreated={(machine) => {
					setCreating(false);
					setOpenId(machine.id);
				}}
				onOpenChange={setCreating}
				open={creating}
				target={target}
			/>
			{/* Keyed by the identity on screen: if it drops out of the list
			    mid-issue (and even if it comes back), the next dialog starts clean
			    instead of inheriting "issuing" or "showing". */}
			<VaultMachineCredentials
				key={open?.id ?? "none"}
				machine={open}
				onOpenChange={(next) => {
					if (!next) {
						setOpenId(null);
					}
				}}
				target={target}
			/>
			<AlertDialog
				onOpenChange={(next) => {
					if (!(next || deciding)) {
						setAsking(null);
					}
				}}
				open={asking !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{asking?.action === "delete"
								? tl("Delete {name}?", { name: asking.machine.name })
								: tl("Disable {name}?", { name: asking?.machine.name ?? "" })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{asking?.action === "delete"
								? tl(
										"Its tokens are revoked with their child tokens and the dynamic credential leases they hold, and its secret IDs and policy bindings are removed. This cannot be undone."
									)
								: tl(
										"Its tokens are revoked with their child tokens and the dynamic credential leases they hold, and it cannot log in until you enable it again. Its secret IDs are kept and work again after that."
									)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deciding}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={deciding}
							onClick={(event) => {
								event.preventDefault();
								if (asking?.action === "delete") {
									remove.mutate(asking.machine);
								} else if (asking) {
									toggle.mutate({ id: asking.machine.id, disabled: true });
								}
							}}
						>
							{asking?.action === "delete" ? "Delete" : "Disable"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsSection>
	);
}
