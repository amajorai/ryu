import { Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BudgetRuleFields } from "@/src/components/gateway/BudgetRuleFields.tsx";
import {
	ACTION_LABELS,
	type BudgetFormState,
	budgetFormToRule,
	budgetRuleToForm,
	budgetUsdToMicroUsd,
	formatBudgetUsd,
} from "@/src/components/gateway/budget-copy.ts";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useGatewayConfigurable } from "@/src/hooks/useGatewayConfigurable.ts";
import { ApiError, toTarget } from "@/src/lib/api/client.ts";
import {
	type BudgetRule,
	type BudgetSpend,
	fetchBudgetSpend,
	fetchGatewayConfig,
	updateGatewayConfig,
	withAgentBudget,
} from "@/src/lib/api/gateway.ts";

const SPEND_POLL_MS = 5000;

export function AgentBudgetPanel({
	agentId,
	disabled = false,
}: {
	agentId: string;
	disabled?: boolean;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const canConfigure = useGatewayConfigurable();
	const [rule, setRule] = useState<BudgetRule | null>(null);
	const [form, setForm] = useState<BudgetFormState>(() =>
		budgetRuleToForm(agentId)
	);
	const [spend, setSpend] = useState<BudgetSpend | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const loadConfig = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const config = await fetchGatewayConfig(target);
			const nextRule = config.budgets.agents[agentId] ?? null;
			setRule(nextRule);
			setForm(budgetRuleToForm(agentId, nextRule));
		} catch (cause) {
			setError(
				cause instanceof ApiError && cause.serverMessage
					? cause.serverMessage
					: cause instanceof Error
						? cause.message
						: "Gateway budget configuration is unavailable."
			);
		} finally {
			setLoading(false);
		}
	}, [agentId, target]);

	const loadSpend = useCallback(async () => {
		try {
			setSpend(await fetchBudgetSpend(target, { agentId }));
		} catch {
			// The configuration error above owns the actionable state. Spend is a
			// secondary readout and may be unavailable while the Gateway starts.
		}
	}, [agentId, target]);

	useEffect(() => {
		loadConfig().catch(() => undefined);
	}, [loadConfig]);

	useEffect(() => {
		// Core serves live spend only to callers who hold gateway.configure, so
		// polling without it would just repeat a refused request every few
		// seconds. The note below explains the missing readout instead.
		if (!canConfigure) {
			setSpend(null);
			return;
		}
		loadSpend().catch(() => undefined);
		const timer = setInterval(() => {
			loadSpend().catch(() => undefined);
		}, SPEND_POLL_MS);
		return () => clearInterval(timer);
	}, [canConfigure, loadSpend]);

	const handleSave = async () => {
		setSaved(false);
		if (budgetUsdToMicroUsd(form.limitUsd) === null) {
			setError(
				"Spend cap must be a non-negative USD amount (up to 6 decimals)."
			);
			return;
		}
		setSaving(true);
		setSaved(false);
		setError(null);
		try {
			const config = await fetchGatewayConfig(target);
			const nextRule = budgetFormToRule(form);
			await updateGatewayConfig(target, {
				budgets: withAgentBudget(config.budgets, agentId, nextRule),
				expectedRevision: config.configRevision ?? undefined,
			});
			setRule(nextRule);
			setForm(budgetRuleToForm(agentId, nextRule));
			setSaved(true);
			await loadSpend();
		} catch (cause) {
			setError(
				cause instanceof ApiError && cause.serverMessage
					? cause.serverMessage
					: cause instanceof Error
						? cause.message
						: "Failed to save agent budget."
			);
		} finally {
			setSaving(false);
		}
	};

	const handleRemove = async () => {
		if (!rule) {
			return;
		}
		setSaving(true);
		setSaved(false);
		setError(null);
		try {
			const config = await fetchGatewayConfig(target);
			await updateGatewayConfig(target, {
				budgets: withAgentBudget(config.budgets, agentId, null),
				expectedRevision: config.configRevision ?? undefined,
			});
			setRule(null);
			setForm(budgetRuleToForm(agentId));
			setSpend(null);
			setSaved(true);
		} catch (cause) {
			setError(
				cause instanceof ApiError && cause.serverMessage
					? cause.serverMessage
					: cause instanceof Error
						? cause.message
						: "Failed to remove agent budget."
			);
		} finally {
			setSaving(false);
		}
	};

	const readOnly = disabled || !canConfigure;
	const spent = spend?.agents[agentId] ?? 0;
	const configuredLimit = spend?.limits.agents[agentId] ?? rule?.limit ?? 0;

	return (
		<SettingsSection
			caption="This agent's lifetime spend cap, and which charges count toward it."
			title="Budget"
		>
			{loading ? (
				<SkeletonRows label="Loading budget…" spacing="comfortable" />
			) : (
				<SettingsCard className="flex flex-col gap-4">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div>
							<p className="font-medium text-sm">This agent's Gateway budget</p>
							<p className="text-muted-foreground text-xs">
								{rule
									? tl("{limit} spend cap · {action}", {
											action: tl(ACTION_LABELS[rule.action]),
											limit: formatBudgetUsd(rule.limit),
										})
									: "No cap configured yet."}
							</p>
						</div>
						{spend?.reachable && rule ? (
							<Badge variant="secondary">
								{configuredLimit > 0
									? tl("Live spend: {spent} / {limit}", {
											limit: formatBudgetUsd(configuredLimit),
											spent: formatBudgetUsd(spent),
										})
									: tl("Live spend: {spent}", {
											spent: formatBudgetUsd(spent),
										})}{" "}
							</Badge>
						) : null}
					</div>

					<BudgetRuleFields
						disabled={readOnly || saving}
						form={form}
						idPrefix="agent-budget"
						onChange={setForm}
						target={target}
					/>

					<div className="flex flex-wrap items-center justify-end gap-2">
						{rule ? (
							<Button
								disabled={readOnly || saving}
								onClick={() => handleRemove()}
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Delete01Icon} />
								Remove cap
							</Button>
						) : null}
						<Button
							disabled={readOnly || saving}
							loading={saving}
							onClick={() => handleSave()}
							type="button"
						>
							Save budget
						</Button>
					</div>

					{canConfigure ? null : (
						<p className="text-muted-foreground text-xs">
							You need the <span className="font-mono">gateway.configure</span>{" "}
							permission to change this rule or see its live spend.
						</p>
					)}
					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
					{saved ? (
						<p className="text-muted-foreground text-xs">
							Budget updated. Changes take effect immediately.
						</p>
					) : null}
				</SettingsCard>
			)}
		</SettingsSection>
	);
}
