// apps/desktop/src/components/gateway/SubscriptionBackendsSettings.tsx
//
// Settings → Cloud environments → "Run on your own plan". The node owner chooses
// whether cloud tasks for the Claude Code and Codex agents may run on their own
// Claude or ChatGPT plan instead of a Ryu Box. It covers the default order, an
// order per agent, and each environment's local checkout (Claude cloud, and runs on
// this computer for Claude or Codex) or Codex environment ID.
//
// The plan's sign-in belongs to the provider CLI on the node. "Sign in" asks Core to
// start that CLI's own sign-in, which opens the provider's page; Ryu never sees a
// code or token. See docs/subscription-cloud-sessions.md.

import { CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG } from "@ryu/auth/lib/feature-flags";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useState } from "react";
import { PlanAccountsSettings } from "@/src/components/gateway/PlanAccountsSettings.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	CLOUD_TASK_BACKEND_LABELS,
	type CloudTaskBackendId,
	type CloudTaskBackendsView,
	type CloudTaskBackendView,
	type CloudTaskRoutingSettings,
	clearCloudTaskBackendCooldown,
	fetchCloudTaskBackends,
	saveCloudTaskRouting,
	startCloudTaskBackendSignIn,
} from "@/src/lib/api/cloud-task-backends.ts";

interface EnvironmentOption {
	id: string;
	name: string;
}

/** The orders a person picks from; Core always keeps the Ryu Box as the last fallback. */
const ORDER_PRESETS: { label: string; order: CloudTaskBackendId[] }[] = [
	{
		label:
			"Your plan in the provider's cloud first, then on this computer, then Ryu Box",
		order: [
			"anthropic-subscription-cli",
			"anthropic-subscription-sdk",
			"openai-subscription-cli",
			"openai-subscription-sdk",
			"ryu-box",
		],
	},
	{
		label: "Your plan on this computer first, then Ryu Box",
		order: [
			"anthropic-subscription-sdk",
			"anthropic-subscription-cli",
			"openai-subscription-sdk",
			"openai-subscription-cli",
			"ryu-box",
		],
	},
	{ label: "Ryu Box only", order: ["ryu-box"] },
];

const presetIndex = (order: readonly CloudTaskBackendId[]): number => {
	const index = ORDER_PRESETS.findIndex(
		(preset) => preset.order.join() === order.join()
	);
	return index === -1 ? 0 : index;
};

function signInLabel(backend: CloudTaskBackendView): string {
	if (!backend.installed) {
		return "Not installed on this node";
	}
	switch (backend.signIn) {
		case "subscription":
			return "Signed in with your plan";
		case "other_method":
			return "Signed in with an API key, not your plan";
		default:
			return "Not signed in";
	}
}

const errorText = (failure: unknown): string => {
	if (failure instanceof ApiError) {
		return failure.serverMessage ?? failure.message;
	}
	return failure instanceof Error ? failure.message : "Something went wrong.";
};

export function SubscriptionBackendsSettings({
	environments,
	target,
}: {
	environments: EnvironmentOption[];
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const flagEnabled = useFeatureFlag(CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG);
	const [view, setView] = useState<CloudTaskBackendsView | null>(null);
	const [draft, setDraft] = useState<CloudTaskRoutingSettings | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const { url, token, userJwt } = target;
	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const next = await fetchCloudTaskBackends(
					{ url, token, userJwt },
					signal
				);
				if (signal?.aborted) {
					return;
				}
				setView(next);
				setDraft(next?.settings ?? null);
				setError(null);
			} catch (failure) {
				if (!signal?.aborted) {
					setError(errorText(failure));
				}
			}
		},
		[url, token, userJwt]
	);

	useEffect(() => {
		if (!flagEnabled) {
			return;
		}
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [flagEnabled, load]);

	if (!(flagEnabled && view?.owner && view.rollout && draft)) {
		return null;
	}

	const save = async (next: CloudTaskRoutingSettings) => {
		setBusy(true);
		setError(null);
		try {
			const saved = await saveCloudTaskRouting(target, next);
			setDraft(saved);
			setNotice("Saved.");
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	};

	const signIn = async (backend: Exclude<CloudTaskBackendId, "ryu-box">) => {
		setError(null);
		try {
			await startCloudTaskBackendSignIn(target, backend);
			setNotice(
				"Finish signing in on the page that opened in your browser, then refresh."
			);
		} catch (failure) {
			setError(errorText(failure));
		}
	};

	const clearCooldown = async (
		backend: Exclude<CloudTaskBackendId, "ryu-box">
	) => {
		try {
			await clearCloudTaskBackendCooldown(target, backend);
			await load();
		} catch (failure) {
			setError(errorText(failure));
		}
	};

	const linkFor = (environmentId: string) =>
		draft.environments[environmentId] ?? {};
	const setLink = (
		environmentId: string,
		field: "claudeCheckout" | "codexEnvironmentId",
		value: string
	) => {
		const link = { ...linkFor(environmentId), [field]: value || undefined };
		setDraft({
			...draft,
			environments: { ...draft.environments, [environmentId]: link },
		});
	};

	const planBackends = view.backends.filter(
		(backend) => backend.billing === "user-plan"
	);

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Cloud tasks for the Claude Code and Codex agents can run on your own Claude or ChatGPT plan, through the official CLI you signed in on this node: in the provider's cloud, or (Claude) on this computer in a separate worktree of your checkout. They count toward that plan's usage limits and use no Ryu credits. When the plan is unavailable or reaches its limit, the task runs on a Ryu Box instead, and Ryu tells you. Ryu never stores your plan's sign-in."
					}
				>
					{
						"Run Claude Code and Codex cloud tasks on your own Claude or ChatGPT plan."
					}
				</CaptionInfo>
			}
			title="Run on your own plan"
		>
			<div className="space-y-4 px-3">
				<div className="flex items-center gap-2">
					<Switch
						checked={draft.enabled}
						disabled={busy}
						id="subscription-backends-enabled"
						onCheckedChange={(enabled) => save({ ...draft, enabled })}
					/>
					<Label htmlFor="subscription-backends-enabled">
						Use my own plan for cloud tasks when I can
					</Label>
				</div>
				<SettingsGroup>
					{planBackends.map((backend) => {
						const id = backend.backend as Exclude<
							CloudTaskBackendId,
							"ryu-box"
						>;
						return (
							<SettingsItem
								actions={
									<div className="flex flex-wrap items-center justify-end gap-2">
										{backend.cooldownSecondsRemaining ? (
											<Button
												onClick={() => clearCooldown(id)}
												size="sm"
												variant="ghost"
											>
												Try again now
											</Button>
										) : null}
										{backend.installed && backend.signIn !== "subscription" ? (
											<Button
												onClick={() => signIn(id)}
												size="sm"
												variant="outline"
											>
												Sign in
											</Button>
										) : null}
									</div>
								}
								description={`${signInLabel(backend)}${
									backend.cooldownSecondsRemaining
										? ` · Usage limit reached; skipped for ${Math.ceil(backend.cooldownSecondsRemaining / 60)} min`
										: ""
								}${backend.installed ? "" : ` · Install it, then run \`${backend.signInCommand ?? ""}\``}`}
								key={backend.backend}
								title={CLOUD_TASK_BACKEND_LABELS[backend.backend]}
							/>
						);
					})}
				</SettingsGroup>
				<PlanAccountsSettings
					busy={busy}
					draft={draft}
					save={save}
					target={target}
				/>
				<div className="space-y-1">
					<Label htmlFor="subscription-default-order">Default order</Label>
					<NativeSelect
						disabled={busy}
						id="subscription-default-order"
						onChange={(event) => {
							const preset = ORDER_PRESETS[Number(event.target.value)];
							if (preset) {
								save({ ...draft, defaultOrder: [...preset.order] });
							}
						}}
						value={String(presetIndex(draft.defaultOrder))}
					>
						{ORDER_PRESETS.map((preset, index) => (
							<NativeSelectOption key={preset.label} value={String(index)}>
								{preset.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<AgentOverrides busy={busy} draft={draft} save={save} />
				{environments.length > 0 ? (
					<div className="space-y-3">
						<p className="font-medium text-sm">Environments</p>
						<p className="text-muted-foreground text-xs">
							Claude runs <code>claude --cloud</code> in a local checkout, and
							its cloud session clones that checkout's GitHub remote at its
							current branch. Runs on this computer, for Claude or Codex, work
							in their own branch of the same checkout. Codex cloud submits to
							the Codex environment you name.
						</p>
						{environments.map((environment) => (
							<div className="grid gap-2 sm:grid-cols-2" key={environment.id}>
								<div className="space-y-1">
									<Label htmlFor={`claude-checkout-${environment.id}`}>
										{tl("{environmentName}: local checkout", {
											environmentName: environment.name,
										})}
									</Label>
									<Input
										disabled={busy}
										id={`claude-checkout-${environment.id}`}
										onChange={(event) =>
											setLink(
												environment.id,
												"claudeCheckout",
												event.target.value
											)
										}
										placeholder="/Users/you/code/repo"
										value={linkFor(environment.id).claudeCheckout ?? ""}
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor={`codex-environment-${environment.id}`}>
										{tl("{environmentName}: Codex environment ID", {
											environmentName: environment.name,
										})}
									</Label>
									<Input
										disabled={busy}
										id={`codex-environment-${environment.id}`}
										onChange={(event) =>
											setLink(
												environment.id,
												"codexEnvironmentId",
												event.target.value
											)
										}
										placeholder="Run `codex cloud` to list them"
										value={linkFor(environment.id).codexEnvironmentId ?? ""}
									/>
								</div>
							</div>
						))}
						<Button
							disabled={busy}
							onClick={() => save(draft)}
							size="sm"
							variant="outline"
						>
							Save environments
						</Button>
					</div>
				) : null}
				<p className="text-muted-foreground text-xs">
					Claude Max and Team plans also include monthly API credits. Link a
					Claude Console organization to your plan, then bind that
					organization's API key as <code>ANTHROPIC_API_KEY</code> in an
					environment: a Ryu Box run then spends those credits on the model, and
					its Box time still uses Ryu credits.
				</p>
				<p className="text-muted-foreground text-xs">
					No live screen. Provider's cloud: review and stop on the provider's
					site. This computer: run log, diff and Stop in Ryu; edits only, no
					shell commands.
				</p>
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
			</div>
		</SettingsSection>
	);
}

/** The per-agent order. Mounted only once the card shows, because it loads agents. */
function AgentOverrides({
	busy,
	draft,
	save,
}: {
	busy: boolean;
	draft: CloudTaskRoutingSettings;
	save: (next: CloudTaskRoutingSettings) => Promise<void>;
}) {
	const { agents } = useAgents();
	if (agents.length === 0) {
		return null;
	}
	return (
		<div className="space-y-2">
			<p className="font-medium text-sm">Per agent</p>
			{agents.map((agent) => {
				const override = draft.agentOverrides[agent.id];
				return (
					<div className="flex items-center gap-2" key={agent.id}>
						<Label
							className="min-w-32 truncate"
							htmlFor={`subscription-agent-${agent.id}`}
							title={agent.name}
						>
							{agent.name}
						</Label>
						<NativeSelect
							disabled={busy}
							id={`subscription-agent-${agent.id}`}
							onChange={(event) => {
								const preset = ORDER_PRESETS[Number(event.target.value)];
								const overrides = Object.fromEntries(
									Object.entries(draft.agentOverrides).filter(
										([id]) => id !== agent.id
									)
								);
								if (preset) {
									overrides[agent.id] = [...preset.order];
								}
								save({ ...draft, agentOverrides: overrides });
							}}
							value={override ? String(presetIndex(override)) : "default"}
						>
							<NativeSelectOption value="default">
								Use the default order
							</NativeSelectOption>
							{ORDER_PRESETS.map((preset, index) => (
								<NativeSelectOption key={preset.label} value={String(index)}>
									{preset.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				);
			})}
		</div>
	);
}
