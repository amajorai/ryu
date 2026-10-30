import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { BudgetRule, GatewayBudgetConfig } from "@/src/lib/api/gateway.ts";
import {
	DEFAULT_SESSION_BUDGET,
	fetchGatewayConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { formToRule } from "./budget-form.tsx";
import { BudgetRuleDialog } from "./budget-rule-dialog.tsx";
import { BudgetScopeSection } from "./budget-scope-section.tsx";
import { SessionBudgetEditor } from "./session-budget-editor.tsx";

export function BudgetsCard({
	target,
	canConfigure,
}: {
	target: ApiTarget;
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	const [budgets, setBudgets] = useState<GatewayBudgetConfig | null>(null);
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setErr(null);
		try {
			const [cfg, agentList] = await Promise.all([
				fetchGatewayConfig(target),
				fetchAgents(target).catch(() => []),
			]);
			setBudgets(cfg.budgets);
			setAgents(agentList);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to load config.");
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		load();
	}, [load]);

	// Every budgets PUT replaces the WHOLE BudgetConfig server-side, so each save
	// path must re-fetch and spread all three dimensions (users / agents /
	// session). Skipping one silently wipes it (e.g. an agent save clearing the
	// session cap).
	const saveRule = useCallback(
		async (scope: "users" | "agents", id: string, rule: BudgetRule) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...cfg.budgets.users },
				agents: { ...cfg.budgets.agents },
				session: cfg.budgets.session ?? DEFAULT_SESSION_BUDGET,
			};
			next[scope][id] = rule;
			await updateGatewayConfig(target, {
				budgets: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setBudgets(next);
		},
		[target]
	);

	const removeRule = useCallback(
		async (scope: "users" | "agents", id: string) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...cfg.budgets.users },
				agents: { ...cfg.budgets.agents },
				session: cfg.budgets.session ?? DEFAULT_SESSION_BUDGET,
			};
			delete next[scope][id];
			await updateGatewayConfig(target, {
				budgets: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setBudgets(next);
		},
		[target]
	);

	const saveSession = useCallback(
		async (rule: BudgetRule) => {
			const cfg = await fetchGatewayConfig(target);
			const next: GatewayBudgetConfig = {
				users: { ...cfg.budgets.users },
				agents: { ...cfg.budgets.agents },
				session: rule,
			};
			await updateGatewayConfig(target, {
				budgets: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setBudgets(next);
		},
		[target]
	);

	const userEntries = Object.entries(budgets?.users ?? {});
	const agentEntries = Object.entries(budgets?.agents ?? {});

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Choose whether model, media, or paid-tool charges count. When a cap is reached the gateway applies the configured action (notify / downgrade / restrict / stop) and, separately, the rule's notification tier decides who is told. Changes take effect immediately."
					}
				>
					{"Spend caps per user, per agent and per session."}
				</CaptionInfo>
			}
		>
			{loading ? (
				<SettingsCard>
					<SkeletonRows label="Loading…" spacing="panel" />
				</SettingsCard>
			) : null}
			{!loading && err ? (
				<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
					<p
						className="min-w-0 flex-1 break-words text-muted-foreground text-sm"
						role="alert"
					>
						{err}
					</p>
					<Button onClick={() => load()} size="sm" variant="secondary">
						Retry
					</Button>
				</SettingsCard>
			) : null}
			{loading || err ? null : (
				<div className="flex flex-col gap-6">
					<BudgetScopeSection
						addDialog={
							<BudgetRuleDialog
								description="Set a charged-spend cap and action for a user. The limit is in USD."
								idLabel="User ID"
								idPlaceholder="e.g. user_123 (the x-ryu-user-id value)"
								idRequiredError="User ID is required."
								onSave={async (form) => {
									await saveRule(
										"users",
										form.agentId.trim(),
										formToRule(form)
									);
								}}
								target={target}
								title="Add user budget"
								trigger={
									<Button disabled={!canConfigure} size="sm" variant="ghost">
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
										Add
									</Button>
								}
							/>
						}
						canConfigure={canConfigure}
						editIdLabel="User ID"
						emptyText="No per-user budgets set. Add one to cap a user's spend."
						entries={userEntries}
						label="Per-user"
						onRemove={(id) => removeRule("users", id)}
						onSave={(id, rule) => saveRule("users", id, rule)}
						target={target}
					/>
					<BudgetScopeSection
						addDialog={
							<BudgetRuleDialog
								agents={agents}
								description="Set a charged-spend cap and action for an agent. The limit is in USD."
								onSave={async (form) => {
									await saveRule(
										"agents",
										form.agentId.trim(),
										formToRule(form)
									);
								}}
								target={target}
								title="Add agent budget"
								trigger={
									<Button disabled={!canConfigure} size="sm" variant="ghost">
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
										Add
									</Button>
								}
							/>
						}
						canConfigure={canConfigure}
						editIdLabel="Agent ID"
						emptyText="No per-agent budgets set. Add one to cap an agent's spend."
						entries={agentEntries}
						label="Per-agent"
						onRemove={(id) => removeRule("agents", id)}
						onSave={(id, rule) => saveRule("agents", id, rule)}
						target={target}
					/>
					<SessionBudgetEditor
						canConfigure={canConfigure}
						onSave={saveSession}
						rule={budgets?.session ?? DEFAULT_SESSION_BUDGET}
						target={target}
					/>
				</div>
			)}
		</SettingsSection>
	);
}
