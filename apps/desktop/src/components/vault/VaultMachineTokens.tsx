// The live tokens of one machine identity, and minting a new one. Revoking
// asks once inline. A minted token is shown once: it lives only in this
// component's state (never React Query's cache) and is dropped on close.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	issueVaultMachineToken,
	listVaultMachineTokens,
	revokeVaultMachineToken,
	type VaultMachine,
} from "@/src/lib/api/vault-machines.ts";
import { listVaultTokenRoles } from "@/src/lib/api/vault-token-roles.ts";
import { type IssueState, useIssueOnce } from "./use-issue-once.ts";
import { VaultListRow } from "./VaultListRow.tsx";
import { VaultRevokeButton } from "./VaultRevokeButton.tsx";
import { VaultShownOnce } from "./VaultShownOnce.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import {
	type MachineTokenForm,
	machineTokenInput,
} from "./vault-machine-form.ts";
import { expiryText, usesText } from "./vault-machine-time.ts";

const EMPTY: MachineTokenForm = { role: "", ttl: "", uses: "" };

export function VaultMachineTokens({
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
	const queryKey = ["vault", "machine-tokens", target.url, machine.id];
	const tokensQuery = useQuery({
		queryKey,
		queryFn: () => listVaultMachineTokens(target, machine.id),
	});
	const rolesQuery = useQuery({
		queryKey: ["vault", "token-roles", target.url],
		queryFn: () => listVaultTokenRoles(target),
	});
	const [form, setForm] = useState<MachineTokenForm>(EMPTY);
	const { done, issued, pending, run, submitRef } = useIssueOnce(onStateChange);
	const [problem, setProblem] = useState<string | null>(null);
	const field = (key: keyof MachineTokenForm) => (value: string) =>
		setForm((current) => ({ ...current, [key]: value }));

	// Not a React Query mutation: its cache would keep the token.
	const issue = async () => {
		const parsed = machineTokenInput(form);
		if ("problem" in parsed) {
			setProblem(parsed.problem);
			return;
		}
		setProblem(null);
		const ok = await run(
			async () => {
				const minted = await issueVaultMachineToken(
					target,
					machine.id,
					parsed.input
				);
				return minted.token;
			},
			(caught) =>
				setProblem(vaultErrorMessage(caught, "Could not issue a token.", tl))
		);
		if (ok) {
			setForm(EMPTY);
			queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
		}
	};

	const revoke = async (accessor: string) => {
		try {
			await revokeVaultMachineToken(target, accessor);
			sileo.success({ title: tl("Token revoked") });
		} catch (caught) {
			sileo.error({
				title: tl("That did not work"),
				description: vaultErrorMessage(caught, tl("Try again."), tl),
			});
		}
		await queryClient.invalidateQueries({ queryKey });
	};

	const tokens = (tokensQuery.data ?? []).filter(
		(token) => token.revokedAt === null
	);
	return (
		<section aria-labelledby="machine-tokens-title" className="space-y-3">
			<h3 className="font-medium text-sm" id="machine-tokens-title">
				Tokens
			</h3>
			{tokensQuery.error ? (
				<p className="text-sm text-status-destructive">
					{vaultErrorMessage(tokensQuery.error, "Could not load tokens.", tl)}
				</p>
			) : tokens.length === 0 ? (
				<p className="text-muted-foreground text-sm">No live tokens.</p>
			) : (
				<ul className="divide-y rounded-md border">
					{tokens.map((token) => (
						<VaultListRow
							actions={
								<VaultRevokeButton
									labels={{
										ask: tl("Revoke token {accessor}", {
											accessor: token.accessor,
										}),
										keep: tl("Keep token {accessor}", {
											accessor: token.accessor,
										}),
										now: tl("Revoke token {accessor} now", {
											accessor: token.accessor,
										}),
									}}
									onRevoke={() => revoke(token.accessor)}
								/>
							}
							detail={[
								expiryText(token.expiresAt),
								usesText(token.numUsesRemaining),
								token.policies.join(", "),
							]
								.filter(Boolean)
								.join(" · ")}
							key={token.accessor}
							title={
								<span className="font-mono text-xs">{token.accessor}</span>
							}
						/>
					))}
				</ul>
			)}
			{issued ? (
				<VaultShownOnce
					id="machine-issued-token"
					label="New token"
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
						<Label htmlFor="machine-token-role">Role</Label>
						<NativeSelect
							aria-describedby={problem ? "machine-token-problem" : undefined}
							aria-invalid={problem ? true : undefined}
							id="machine-token-role"
							onChange={(event) => field("role")(event.target.value)}
							value={form.role}
						>
							<NativeSelectOption value="">No role</NativeSelectOption>
							{(rolesQuery.data ?? []).map((role) => (
								<NativeSelectOption key={role.name} value={role.name}>
									{role.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="machine-token-ttl">Valid for</Label>
						<Input
							aria-describedby={problem ? "machine-token-problem" : undefined}
							aria-invalid={problem ? true : undefined}
							id="machine-token-ttl"
							onChange={(event) => field("ttl")(event.target.value)}
							placeholder={tl("Default")}
							value={form.ttl}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="machine-token-uses">Use limit</Label>
						<Input
							aria-describedby={problem ? "machine-token-problem" : undefined}
							aria-invalid={problem ? true : undefined}
							id="machine-token-uses"
							inputMode="numeric"
							onChange={(event) => field("uses")(event.target.value)}
							placeholder={tl("Unlimited")}
							value={form.uses}
						/>
					</div>
					{problem ? (
						<p
							className="text-sm text-status-destructive sm:col-span-3"
							id="machine-token-problem"
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
							Issue token
						</Button>
					</div>
				</form>
			)}
		</section>
	);
}
