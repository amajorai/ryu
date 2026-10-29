// Reactive failover — "my agent just hit its cap; retry the turn on whichever
// plan still has room".
//
// Sits next to FallbackRulesSection because they share a home for a reason, but
// they answer different questions and the copy here has to keep them apart:
//
//   Fallback rules  -> PROACTIVE. You write a threshold ("Claude weekly under
//                      50%") and it fires BEFORE a turn, every turn.
//   Auto-retry      -> REACTIVE. No rule. Fires AFTER a turn failed, and only
//                      once Core has confirmed against the vendor's own windows
//                      that the plan is genuinely out of room.
//
// Kernel-owned rather than an apps-store app's settings tab, for the same reason
// spelled out in FallbackRulesSection: an app-registered tab inherits the app's
// enablement, so disabling the app would leave turns still being rerouted with
// no UI left to explain why. That trap is sharper here — this feature acts at
// the exact moment the user is least able to see what happened.
//
// One thing the copy must be honest about: an ACP agent owns its own session
// state on the vendor's side, so moving mid-thread continues from Ryu's replay
// of the conversation, not from the agent's own server-side thread. That is a
// real downgrade and it is why this ships off by default with a notify-only
// setting to try first.

import { Button } from "@ryu/ui/components/button.tsx";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useSubscriptions } from "@/src/hooks/useSubscriptions.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { RetryPolicy, RetryPolicyView } from "@/src/lib/api/routing.ts";
import {
	defaultRetryPolicy,
	fetchRetryPolicy,
	saveRetryPolicy,
} from "@/src/lib/api/routing.ts";

/** A human name for an agent id, mirroring Core's own note text. */
const AGENT_LABELS = new Map<string, string>([
	["acp:claude", "Claude"],
	["acp:codex", "Codex"],
	["acp:copilot", "Copilot"],
	["acp:glm", "GLM"],
	["acp:grok", "Grok"],
]);

/**
 * The candidate's name: Core's own label from the subscriptions listing when it
 * lists that id, else the static name, else the bare id.
 */
function agentLabel(id: string, listed: ReadonlyMap<string, string>): string {
	return listed.get(id) ?? AGENT_LABELS.get(id) ?? id.replace(/^acp:/, "");
}

/**
 * The auto-retry card for the Gateway dialog's "Model routing" section.
 *
 * Every control writes immediately — there is no save button — matching the
 * other cards in this dialog.
 */
export function AutoRetrySection({
	canConfigure,
	target,
}: {
	canConfigure: boolean;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const { agents } = useAgents();
	const installed = new Set(agents.map((a) => a.id));
	// Product names only (never account names), so the listing skips usage.
	const subscriptions = useSubscriptions({ target, usage: "none" });
	const listedLabels = new Map(
		(subscriptions.data?.providers ?? []).map((provider) => [
			provider.providerId,
			provider.label,
		])
	);

	const policyQuery = useQuery({
		queryKey: ["retry-policy", target.url],
		queryFn: () => fetchRetryPolicy(target),
		refetchOnWindowFocus: false,
	});

	const save = useMutation({
		mutationFn: (policy: RetryPolicy) => saveRetryPolicy(target, policy),
		onSuccess: (_data, policy) => {
			// Merge, don't replace: the cached value also carries
			// `subscription_agents`, which Core serves and a save does not round-trip.
			queryClient.setQueryData<RetryPolicyView>(
				["retry-policy", target.url],
				(prev) =>
					prev ? { ...prev, policy } : { policy, subscription_agents: [] }
			);
		},
		onError: (error: Error) => {
			sileo.error({
				title: "Could not save auto-retry settings",
				description: error.message,
			});
		},
	});

	const policy = policyQuery.data?.policy ?? defaultRetryPolicy();
	// Which agents may be named as candidates — served by Core, which owns the
	// window readers, so this form can never offer a plan whose headroom cannot
	// actually be read. Narrowed to the ones this node has installed: an agent
	// you never set up would report "not logged in" and never be picked anyway.
	const pool = (policyQuery.data?.subscription_agents ?? [])
		.filter((id) => installed.has(id))
		.sort((left, right) => {
			const leftOrder = policy.candidates.indexOf(left);
			const rightOrder = policy.candidates.indexOf(right);
			return (
				(leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) -
				(rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder)
			);
		});
	const disabled = !canConfigure || save.isPending || !policyQuery.isSuccess;

	const commit = useCallback(
		(patch: Partial<RetryPolicy>) => save.mutate({ ...policy, ...patch }),
		[policy, save]
	);

	const toggleCandidate = (id: string) => {
		const next = policy.candidates.includes(id)
			? policy.candidates.filter((c) => c !== id)
			: [...policy.candidates, id];
		commit({ candidates: next });
	};

	return (
		<SettingsSection
			caption="Only runs when a turn actually fails, and only after Core re-reads the vendor's own 5-hour and weekly windows to confirm the plan really is out of room, so an unrelated failure never moves you off your agent."
			title="Auto-retry on another plan"
		>
			{policyQuery.isError ? (
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								onClick={() => void policyQuery.refetch()}
								size="sm"
								variant="ghost"
							>
								Retry auto-retry settings
							</Button>
						}
						title={
							<span role="alert">Could not load auto-retry settings.</span>
						}
					/>
				</SettingsGroup>
			) : null}
			{policyQuery.isLoading ? (
				<SettingsCard>
					<SkeletonRows />
				</SettingsCard>
			) : (
				<>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Switch
									aria-label="Retry a capped turn on another subscription"
									checked={policy.enabled}
									disabled={disabled}
									id="auto-retry-enabled"
									onCheckedChange={(enabled) => commit({ enabled })}
								/>
							}
							description="When the plan running a turn hits its cap, run that turn again on whichever of your other subscriptions has the most room left. The retry continues from Ryu's copy of the conversation, not the agent's own session, so it can lose vendor-side context."
							title={
								<label htmlFor="auto-retry-enabled">
									Retry on another subscription
								</label>
							}
						/>
						{policy.enabled ? (
							<SettingsItem
								actions={
									<Switch
										aria-label="Notify only, do not retry"
										checked={policy.notify_only}
										disabled={disabled}
										id="auto-retry-notify-only"
										onCheckedChange={(notify_only) => commit({ notify_only })}
									/>
								}
								description="Show which plan had room (or when the first window reopens) and leave the turn failed. Worth running for a few days before letting it rewrite turns."
								title={
									<label htmlFor="auto-retry-notify-only">
										Just tell me — don't retry
									</label>
								}
							/>
						) : null}
						{policy.enabled ? (
							<SettingsItem
								description={
									pool.length === 0
										? "No subscription agents with readable usage windows are set up on this node yet."
										: "Pick none to use any plan with room. Picking some makes them a priority order. The first one listed that has room wins."
								}
								title="Plans it may move to"
							>
								{pool.length > 0 ? (
									<div className="flex flex-wrap gap-2 pb-1">
										{pool.map((id) => {
											const picked = policy.candidates.includes(id);
											const order = policy.candidates.indexOf(id) + 1;
											return (
												<button
													aria-pressed={picked}
													className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
														picked
															? "border-primary bg-primary/10 text-foreground"
															: "border-border text-muted-foreground hover:text-foreground"
													}`}
													disabled={disabled}
													key={id}
													onClick={() => toggleCandidate(id)}
													type="button"
												>
													{picked ? `${order}. ` : ""}
													{agentLabel(id, listedLabels)}
												</button>
											);
										})}
									</div>
								) : null}
							</SettingsItem>
						) : null}
					</SettingsGroup>

					{policy.enabled ? (
						<div className="space-y-1.5">
							<SettingsCard>
								<FluidSlider
									aria-label="Percent left below which a window counts as spent"
									disabled={disabled}
									format={(v) => `${v}% left`}
									label="Count a window as spent below"
									max={25}
									min={0}
									onValueChange={(spent_below_percent) =>
										commit({ spent_below_percent })
									}
									step={1}
									value={policy.spent_below_percent}
								/>
							</SettingsCard>
							<p className="px-3.5 text-muted-foreground text-xs leading-snug">
								Also the bar a plan has to clear to receive a retry, so raising
								it both catches a cap sooner and refuses plans that are nearly
								out themselves.
							</p>
						</div>
					) : null}
				</>
			)}
		</SettingsSection>
	);
}
