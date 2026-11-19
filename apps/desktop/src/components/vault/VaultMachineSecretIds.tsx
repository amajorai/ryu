// The AppRole secret ids of one machine identity, and issuing a new one.
// Revoking asks once inline. A new secret id is shown once: it lives only in
// this component's state (never React Query's cache) and is dropped on close.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	issueVaultSecretId,
	listVaultSecretIds,
	revokeVaultSecretId,
	type VaultMachine,
} from "@/src/lib/api/vault-machines.ts";
import { type IssueState, useIssueOnce } from "./use-issue-once.ts";
import { VaultListRow } from "./VaultListRow.tsx";
import { VaultRevokeButton } from "./VaultRevokeButton.tsx";
import { VaultShownOnce } from "./VaultShownOnce.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import { type SecretIdForm, secretIdInput } from "./vault-machine-form.ts";
import { expiryText, usesText } from "./vault-machine-time.ts";

const EMPTY: SecretIdForm = { cidrs: "", ttl: "", uses: "" };

export function VaultMachineSecretIds({
	machine,
	onStateChange,
	target,
}: {
	machine: VaultMachine;
	/** Told while a request is in flight or a value is on screen. */
	onStateChange: (state: IssueState) => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const queryKey = ["vault", "machine-secret-ids", target.url, machine.id];
	const secretIdsQuery = useQuery({
		queryKey,
		queryFn: () => listVaultSecretIds(target, machine.id),
	});
	const [form, setForm] = useState<SecretIdForm>(EMPTY);
	const { done, issued, pending, run, submitRef } = useIssueOnce(onStateChange);
	const [problem, setProblem] = useState<string | null>(null);
	const field = (key: keyof SecretIdForm) => (value: string) =>
		setForm((current) => ({ ...current, [key]: value }));

	// Not a React Query mutation: its cache would keep the secret id.
	const issue = async () => {
		const parsed = secretIdInput(form);
		if ("problem" in parsed) {
			setProblem(parsed.problem);
			return;
		}
		setProblem(null);
		const ok = await run(
			async () => {
				const reply = await issueVaultSecretId(
					target,
					machine.id,
					parsed.input
				);
				return reply.secretId;
			},
			(caught) =>
				setProblem(
					vaultErrorMessage(caught, "Could not issue a secret ID.", tl)
				)
		);
		if (ok) {
			setForm(EMPTY);
			queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
		}
	};

	const revoke = async (accessor: string) => {
		try {
			await revokeVaultSecretId(target, accessor);
			sileo.success({ title: tl("Secret ID revoked") });
		} catch (caught) {
			sileo.error({
				title: tl("That did not work"),
				description: vaultErrorMessage(caught, "Try again.", tl),
			});
		}
		await queryClient.invalidateQueries({ queryKey });
	};

	const secretIds = secretIdsQuery.data ?? [];
	return (
		<section aria-labelledby="machine-secret-ids-title" className="space-y-3">
			<div className="space-y-1">
				<h3 className="font-medium text-sm" id="machine-secret-ids-title">
					Secret IDs
				</h3>
				<p className="text-muted-foreground text-xs">
					{tl("Role ID {roleId}", { roleId: machine.auth.role_id ?? "" })}
				</p>
			</div>
			{secretIdsQuery.error ? (
				<p className="text-sm text-status-destructive">
					{vaultErrorMessage(
						secretIdsQuery.error,
						"Could not load secret IDs.",
						tl
					)}
				</p>
			) : secretIds.length === 0 ? (
				<p className="text-muted-foreground text-sm">No secret IDs.</p>
			) : (
				<ul className="divide-y rounded-md border">
					{secretIds.map((secretId) => (
						<VaultListRow
							actions={
								<VaultRevokeButton
									labels={{
										ask: tl("Revoke secret ID {accessor}", {
											accessor: secretId.accessor,
										}),
										keep: tl("Keep secret ID {accessor}", {
											accessor: secretId.accessor,
										}),
										now: tl("Revoke secret ID {accessor} now", {
											accessor: secretId.accessor,
										}),
									}}
									onRevoke={() => revoke(secretId.accessor)}
								/>
							}
							detail={`${expiryText(secretId.expiresAt)} · ${usesText(secretId.usesRemaining)}`}
							key={secretId.accessor}
							title={
								<span className="font-mono text-xs">{secretId.accessor}</span>
							}
						/>
					))}
				</ul>
			)}
			{issued ? (
				<VaultShownOnce
					id="machine-issued-secret-id"
					label="New secret ID"
					onDone={done}
					value={issued}
				/>
			) : (
				<form
					className="grid gap-2 sm:grid-cols-3"
					onSubmit={(event) => {
						event.preventDefault();
						issue();
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor="machine-secret-id-ttl">Valid for</Label>
						<Input
							aria-describedby={
								problem ? "machine-secret-id-problem" : undefined
							}
							aria-invalid={problem ? true : undefined}
							id="machine-secret-id-ttl"
							onChange={(event) => field("ttl")(event.target.value)}
							placeholder={tl("Never expires")}
							value={form.ttl}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="machine-secret-id-uses">Use limit</Label>
						<Input
							aria-describedby={
								problem ? "machine-secret-id-problem" : undefined
							}
							aria-invalid={problem ? true : undefined}
							id="machine-secret-id-uses"
							inputMode="numeric"
							onChange={(event) => field("uses")(event.target.value)}
							placeholder={tl("Unlimited")}
							value={form.uses}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="machine-secret-id-cidrs">Login from</Label>
						<Input
							aria-describedby={
								problem ? "machine-secret-id-problem" : undefined
							}
							aria-invalid={problem ? true : undefined}
							id="machine-secret-id-cidrs"
							onChange={(event) => field("cidrs")(event.target.value)}
							placeholder={tl("Any address")}
							value={form.cidrs}
						/>
					</div>
					{problem ? (
						<p
							className="text-sm text-status-destructive sm:col-span-3"
							id="machine-secret-id-problem"
							role="alert"
						>
							{problem}
						</p>
					) : null}
					<div className="sm:col-span-3">
						<Button
							disabled={pending || machine.disabled}
							ref={submitRef}
							size="sm"
							type="submit"
						>
							Issue secret ID
						</Button>
					</div>
				</form>
			)}
		</section>
	);
}
