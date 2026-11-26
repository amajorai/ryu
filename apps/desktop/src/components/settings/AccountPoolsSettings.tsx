// apps/desktop/src/components/settings/AccountPoolsSettings.tsx
//
// Custom account pools: named sets of saved provider accounts. An agent that
// is limited to a pool rotates only over that pool's accounts, so accounts
// that lack a model never serve an agent that needs it. This section creates,
// renames and deletes pools and picks their accounts; the agent's own settings
// choose which pool the agent uses (`AgentAccountPoolPanel`).
//
// Everything is stored and enforced by Core
// (`/api/pi-config/providers/account-pools`). A pool holds account ids only.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SubmitEvent, useId, useMemo, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type AccountPool,
	type AccountPoolMember,
	accountPoolsQueryKey,
	accountPoolsUnsupported,
	createAccountPool,
	deleteAccountPool,
	fetchAccountPools,
	memberKey,
	toggleMember,
	updateAccountPool,
} from "@/src/lib/api/account-pools.ts";
import { ApiError, toTarget } from "@/src/lib/api/client.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

interface Draft {
	members: AccountPoolMember[];
	name: string;
	/** `null` while a new pool is being written. */
	poolId: string | null;
}

interface AccountGroup {
	accounts: { accountId: string; label: string }[];
	label: string;
	providerId: string;
}

/** The saved accounts a pool can hold, grouped by the provider that lists them. */
export function poolAccountGroups(providers: PiProvider[]): AccountGroup[] {
	return providers.flatMap((provider) => {
		const kinds = provider.accountRouting?.credentialKinds ?? [];
		const accounts = (provider.accounts ?? []).filter((account) =>
			kinds.some((kind) => kind === account.kind)
		);
		return accounts.length > 0
			? [{ accounts, label: provider.label, providerId: provider.id }]
			: [];
	});
}

function serverText<TError>(cause: TError, fallback: string): string {
	return cause instanceof ApiError && cause.serverMessage
		? cause.serverMessage
		: fallback;
}

export function AccountPoolsSettings({
	providers,
}: {
	providers: PiProvider[];
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryClient = useQueryClient();
	const queryKey = accountPoolsQueryKey(target);
	const query = useQuery({
		queryKey,
		queryFn: () => fetchAccountPools(target),
	});
	const formId = useId();
	const [draft, setDraft] = useState<Draft | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const groups = useMemo(() => poolAccountGroups(providers), [providers]);

	const refresh = () => {
		queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
	};
	const save = useMutation({
		mutationFn: async (input: Draft) => {
			const body = { accounts: input.members, name: input.name.trim() };
			return input.poolId === null
				? await createAccountPool(target, body)
				: await updateAccountPool(target, input.poolId, body);
		},
		onError: (cause) => {
			setError(serverText(cause, tl("Could not save the account pool.")));
		},
		onSuccess: () => {
			setDraft(null);
			setError(null);
			refresh();
		},
	});
	const remove = useMutation({
		mutationFn: async (poolId: string) => {
			await deleteAccountPool(target, poolId);
		},
		onError: (cause) => {
			setError(serverText(cause, tl("Could not delete the account pool.")));
		},
		onSuccess: () => {
			setConfirmDelete(null);
			setError(null);
			refresh();
		},
	});
	const busy = save.isPending || remove.isPending;

	const startEdit = (pool: AccountPool | null) => {
		setError(null);
		setConfirmDelete(null);
		setDraft(
			pool
				? { members: pool.accounts, name: pool.name, poolId: pool.id }
				: { members: [], name: "", poolId: null }
		);
	};
	const submit = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (draft && draft.name.trim() !== "") {
			save.mutate(draft);
		}
	};

	const renderBody = () => {
		if (query.isError) {
			return (
				<p className="text-detail text-status-destructive" role="alert">
					Could not load account pools.
				</p>
			);
		}
		if (query.isPending) {
			return (
				<SkeletonRows label="Loading account pools…" spacing="comfortable" />
			);
		}
		const catalog = query.data;
		const selected = new Set((draft?.members ?? []).map(memberKey));
		return (
			<SettingsCard className="flex flex-col gap-4">
				{catalog.pools.length === 0 ? (
					<p className="text-muted-foreground text-sm">No account pools yet.</p>
				) : (
					<ul className="flex flex-col gap-3">
						{catalog.pools.map((pool) => (
							<li
								className="flex flex-wrap items-center justify-between gap-3"
								data-pool-id={pool.id}
								key={pool.id}
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-sm">{pool.name}</p>
									<p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs">
										<span>
											{tl("Accounts: {count}", {
												count: pool.accounts.length,
											})}
										</span>
										<span>
											{tl("Agents: {count}", {
												count: Object.values(catalog.agents).filter(
													(poolId) => poolId === pool.id
												).length,
											})}
										</span>
									</p>
								</div>
								{confirmDelete === pool.id ? (
									<div className="flex flex-wrap items-center gap-2">
										<p className="text-sm">
											Delete this pool? Agents that use it go back to all
											accounts.
										</p>
										<Button
											disabled={busy}
											onClick={() => remove.mutate(pool.id)}
											size="sm"
											type="button"
											variant="destructive"
										>
											Delete pool
										</Button>
										<Button
											disabled={busy}
											onClick={() => setConfirmDelete(null)}
											size="sm"
											type="button"
											variant="outline"
										>
											Cancel
										</Button>
									</div>
								) : (
									<div className="flex gap-2">
										<Button
											disabled={busy}
											onClick={() => startEdit(pool)}
											size="sm"
											type="button"
											variant="outline"
										>
											Edit
										</Button>
										<Button
											disabled={busy}
											onClick={() => {
												setDraft(null);
												setError(null);
												setConfirmDelete(pool.id);
											}}
											size="sm"
											type="button"
											variant="outline"
										>
											Delete
										</Button>
									</div>
								)}
							</li>
						))}
					</ul>
				)}
				{draft ? (
					<form
						className="flex flex-col gap-4 rounded-md border p-3"
						onSubmit={submit}
					>
						<div className="space-y-1.5">
							<Label htmlFor={`${formId}-name`}>Pool name</Label>
							<Input
								disabled={busy}
								id={`${formId}-name`}
								maxLength={64}
								onChange={(event) =>
									setDraft({ ...draft, name: event.target.value })
								}
								value={draft.name}
							/>
						</div>
						<fieldset className="flex flex-col gap-3">
							<legend className="font-medium text-sm">
								Accounts in this pool
							</legend>
							{groups.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									No saved accounts yet. Connect an account first.
								</p>
							) : (
								groups.map((group) => (
									<div className="flex flex-col gap-1.5" key={group.providerId}>
										<p className="text-detail text-muted-foreground">
											{group.label}
										</p>
										{group.accounts.map((account) => {
											const member = {
												accountId: account.accountId,
												providerId: group.providerId,
											};
											const checkId = `${formId}-${group.providerId}-${account.accountId}`;
											return (
												<div
													className="flex items-center gap-2"
													key={account.accountId}
												>
													<Checkbox
														checked={selected.has(memberKey(member))}
														disabled={busy}
														id={checkId}
														onCheckedChange={() =>
															setDraft({
																...draft,
																members: toggleMember(draft.members, member),
															})
														}
													/>
													<Label htmlFor={checkId}>{account.label}</Label>
												</div>
											);
										})}
									</div>
								))
							)}
						</fieldset>
						<div className="flex gap-2">
							<Button
								disabled={busy || draft.name.trim() === ""}
								size="sm"
								type="submit"
							>
								Save pool
							</Button>
							<Button
								disabled={busy}
								onClick={() => setDraft(null)}
								size="sm"
								type="button"
								variant="outline"
							>
								Cancel
							</Button>
						</div>
					</form>
				) : null}
				{error ? (
					<p className="text-detail text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				{draft === null && catalog.pools.length < catalog.maxPools ? (
					<div>
						<Button
							disabled={busy}
							onClick={() => startEdit(null)}
							size="sm"
							type="button"
							variant="outline"
						>
							New pool
						</Button>
					</div>
				) : null}
			</SettingsCard>
		);
	};

	// A node on an older Core has no account pools: show nothing.
	if (accountPoolsUnsupported(query.error)) {
		return null;
	}

	return (
		<SettingsSection
			caption="An agent with a pool rotates only over the accounts of that pool. Choose the pool of an agent in the agent's settings."
			title="Account pools"
		>
			{renderBody()}
		</SettingsSection>
	);
}
