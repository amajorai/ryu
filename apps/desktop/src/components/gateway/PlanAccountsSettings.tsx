// apps/desktop/src/components/gateway/PlanAccountsSettings.tsx
//
// The node owner's plan accounts, inside Settings → "Run on your own plan": the CLI's
// own sign-in plus any linked Claude or ChatGPT accounts, each with its own CLI config
// folder. Here the owner links ("Add account" starts the CLI's own sign-in for a new
// folder), signs in, picks a default per provider and per agent, lists the accounts to
// try after a usage limit (never automatic), and removes an account (after confirming;
// its folder and sign-in are deleted). It also lists sessions across all accounts.
//
// Ryu never sees a plan credential: Core reads only each CLI's status.
// See docs/subscription-cloud-sessions.md §0b.

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
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useCallback, useEffect, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	addPlanAccount,
	type CloudTaskRoutingSettings,
	clearPlanAccountCooldown,
	DEFAULT_ACCOUNT_ID,
	fetchPlanAccounts,
	fetchPlanSessions,
	PLAN_PROVIDERS,
	type PlanAccountView,
	type PlanProvider,
	type PlanSession,
	removePlanAccount,
	signInPlanAccount,
} from "@/src/lib/api/cloud-task-backends.ts";

const PROVIDER_NAMES: Record<PlanProvider, string> = {
	anthropic: "Claude",
	openai: "ChatGPT",
};

const errorText = (failure: unknown): string => {
	if (failure instanceof ApiError) {
		return failure.serverMessage ?? failure.message;
	}
	return failure instanceof Error ? failure.message : "Something went wrong.";
};

function signInText(account: PlanAccountView): string {
	if (!account.installed) {
		return "CLI not installed on this node";
	}
	switch (account.signIn) {
		case "subscription":
			return "Signed in with the plan";
		case "other_method":
			return "Signed in with an API key, not the plan";
		default:
			return "Not signed in";
	}
}

export function PlanAccountsSettings({
	busy,
	draft,
	save,
	target,
}: {
	busy: boolean;
	draft: CloudTaskRoutingSettings;
	save: (next: CloudTaskRoutingSettings) => Promise<void>;
	target: ApiTarget;
}) {
	const [accounts, setAccounts] = useState<PlanAccountView[] | null>(null);
	const [sessions, setSessions] = useState<PlanSession[]>([]);
	const [newProvider, setNewProvider] = useState<PlanProvider>("anthropic");
	const [newLabel, setNewLabel] = useState("");
	const [removing, setRemoving] = useState<PlanAccountView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const { url, token, userJwt } = target;

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const node = { url, token, userJwt };
			try {
				const [nextAccounts, nextSessions] = await Promise.all([
					fetchPlanAccounts(node, signal),
					fetchPlanSessions(node, signal).catch(() => []),
				]);
				if (!signal?.aborted) {
					setAccounts(nextAccounts);
					setSessions(nextSessions);
				}
			} catch (failure) {
				if (!signal?.aborted) {
					setError(errorText(failure));
				}
			}
		},
		[url, token, userJwt]
	);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	if (!accounts) {
		return null;
	}

	const act = async (work: () => Promise<void>, done?: string) => {
		setError(null);
		try {
			await work();
			if (done) {
				setNotice(done);
			}
			await load();
		} catch (failure) {
			setError(errorText(failure));
		}
	};

	const addAccount = () =>
		act(async () => {
			await addPlanAccount(target, newProvider, newLabel);
			setNewLabel("");
		}, "Finish signing in on the page that opened in your browser, then refresh.");

	const fallbacksFor = (provider: PlanProvider) =>
		draft.accountFallbacks[provider] ?? [];

	const toggleFallback = (provider: PlanProvider, id: string, on: boolean) => {
		const current = fallbacksFor(provider).filter((other) => other !== id);
		save({
			...draft,
			accountFallbacks: {
				...draft.accountFallbacks,
				[provider]: on ? [...current, id] : current,
			},
		});
	};

	const makeDefault = (account: PlanAccountView) =>
		save({
			...draft,
			defaultAccounts: {
				...draft.defaultAccounts,
				[account.provider]: account.id,
			},
		});

	return (
		<div className="space-y-4">
			{PLAN_PROVIDERS.map((provider) => {
				const own = accounts.filter((account) => account.provider === provider);
				const defaultId = draft.defaultAccounts[provider] ?? DEFAULT_ACCOUNT_ID;
				const fallbacks = fallbacksFor(provider);
				return (
					<div className="space-y-2" key={provider}>
						<p className="font-medium text-sm">
							{PROVIDER_NAMES[provider]} accounts
						</p>
						<SettingsGroup>
							{own.map((account) => (
								<SettingsItem
									actions={
										<div className="flex flex-wrap items-center justify-end gap-2">
											{account.cooldownSecondsRemaining ? (
												<Button
													onClick={() =>
														act(() =>
															clearPlanAccountCooldown(
																target,
																provider,
																account.id
															)
														)
													}
													size="sm"
													variant="ghost"
												>
													Try again now
												</Button>
											) : null}
											{account.installed &&
											account.signIn !== "subscription" ? (
												<Button
													onClick={() =>
														act(
															() =>
																signInPlanAccount(target, provider, account.id),
															"Finish signing in on the page that opened in your browser, then refresh."
														)
													}
													size="sm"
													variant="outline"
												>
													Sign in
												</Button>
											) : null}
											{account.id === defaultId ? null : (
												<Button
													disabled={busy}
													onClick={() => makeDefault(account)}
													size="sm"
													variant="ghost"
												>
													Make default
												</Button>
											)}
											{account.builtin ? null : (
												<Button
													onClick={() => setRemoving(account)}
													size="sm"
													variant="ghost"
												>
													Remove
												</Button>
											)}
										</div>
									}
									description={`${signInText(account)}${
										account.id === defaultId ? " · Default" : ""
									}${
										account.cooldownSecondsRemaining
											? ` · Usage limit reached; skipped for ${Math.ceil(account.cooldownSecondsRemaining / 60)} min`
											: ""
									}`}
									key={account.id}
									title={account.tag}
								/>
							))}
						</SettingsGroup>
						{own.length > 1 ? (
							<div className="space-y-1">
								<p className="text-muted-foreground text-xs">
									When the account a task starts on reaches its usage limit, try
									these accounts, in the order you tick them. Untick them all to
									send the task to a Ryu Box instead. Ryu never switches
									accounts unless you list them here.
								</p>
								{own.map((account) => {
									const position = fallbacks.indexOf(account.id);
									const id = `fallback-${provider}-${account.id}`;
									return (
										<div className="flex items-center gap-2" key={account.id}>
											<Checkbox
												checked={position >= 0}
												disabled={busy}
												id={id}
												onCheckedChange={(checked) =>
													toggleFallback(provider, account.id, checked === true)
												}
											/>
											<Label className="text-xs" htmlFor={id}>
												{position >= 0
													? `${position + 1}. ${account.label}`
													: account.label}
											</Label>
										</div>
									);
								})}
							</div>
						) : null}
					</div>
				);
			})}
			<div className="flex flex-wrap items-end gap-2">
				<div className="space-y-1">
					<Label htmlFor="plan-account-provider">Add account</Label>
					<NativeSelect
						id="plan-account-provider"
						onChange={(event) => {
							const picked = PLAN_PROVIDERS.find(
								(provider) => provider === event.target.value
							);
							if (picked) {
								setNewProvider(picked);
							}
						}}
						value={newProvider}
					>
						{PLAN_PROVIDERS.map((provider) => (
							<NativeSelectOption key={provider} value={provider}>
								{PROVIDER_NAMES[provider]}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-1">
					<Label htmlFor="plan-account-label">Label</Label>
					<Input
						id="plan-account-label"
						maxLength={40}
						onChange={(event) => setNewLabel(event.target.value)}
						placeholder="work"
						value={newLabel}
					/>
				</div>
				<Button
					disabled={newLabel.trim() === ""}
					onClick={addAccount}
					size="sm"
					variant="outline"
				>
					Add and sign in
				</Button>
			</div>
			<AgentAccounts
				accounts={accounts}
				busy={busy}
				draft={draft}
				save={save}
			/>
			{sessions.length > 0 ? (
				<div className="space-y-1">
					<p className="font-medium text-sm">Sessions on your plans</p>
					<ul className="space-y-1 text-xs">
						{sessions.map((session) => (
							<li
								className="flex flex-wrap items-center gap-2"
								key={`${session.tag}:${session.externalId ?? session.conversationId}`}
							>
								<span className="font-medium">{session.tag}</span>
								<span className="text-muted-foreground">
									{session.title ??
										session.conversationId ??
										session.externalId}
								</span>
								{session.status ? (
									<span className="text-muted-foreground">
										{session.status}
									</span>
								) : null}
								{session.url ? (
									<a
										className="underline underline-offset-2"
										href={session.url}
										rel="noopener noreferrer"
										target="_blank"
									>
										Open
									</a>
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{notice ? (
				<p className="text-muted-foreground text-xs" role="status">
					{notice}
				</p>
			) : null}
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setRemoving(null);
					}
				}}
				open={removing !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Remove {removing ? removing.tag : "this account"}?
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
								const account = removing;
								setRemoving(null);
								if (account) {
									act(() =>
										removePlanAccount(target, account.provider, account.id)
									);
								}
							}}
						>
							Remove
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** The account each agent starts its tasks on, when the owner has several. */
function AgentAccounts({
	accounts,
	busy,
	draft,
	save,
}: {
	accounts: PlanAccountView[];
	busy: boolean;
	draft: CloudTaskRoutingSettings;
	save: (next: CloudTaskRoutingSettings) => Promise<void>;
}) {
	const { agents } = useAgents();
	const providers = PLAN_PROVIDERS.filter(
		(provider) =>
			accounts.filter((account) => account.provider === provider).length > 1
	);
	if (agents.length === 0 || providers.length === 0) {
		return null;
	}
	const choose = (agentId: string, provider: PlanProvider, id: string) => {
		const current = { ...(draft.agentAccounts[agentId] ?? {}) };
		if (id === "") {
			delete current[provider];
		} else {
			current[provider] = id;
		}
		save({
			...draft,
			agentAccounts: { ...draft.agentAccounts, [agentId]: current },
		});
	};
	return (
		<div className="space-y-2">
			<p className="font-medium text-sm">Account per agent</p>
			{agents.map((agent) =>
				providers.map((provider) => {
					const id = `agent-account-${agent.id}-${provider}`;
					return (
						<div
							className="flex items-center gap-2"
							key={`${agent.id}:${provider}`}
						>
							<Label
								className="min-w-32 truncate"
								htmlFor={id}
								title={agent.name}
							>
								{`${agent.name} · ${PROVIDER_NAMES[provider]}`}
							</Label>
							<NativeSelect
								disabled={busy}
								id={id}
								onChange={(event) =>
									choose(agent.id, provider, event.target.value)
								}
								value={draft.agentAccounts[agent.id]?.[provider] ?? ""}
							>
								<NativeSelectOption value="">
									Use the default account
								</NativeSelectOption>
								{accounts
									.filter((account) => account.provider === provider)
									.map((account) => (
										<NativeSelectOption key={account.id} value={account.id}>
											{account.label}
										</NativeSelectOption>
									))}
							</NativeSelect>
						</div>
					);
				})
			)}
		</div>
	);
}
