import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { BudgetChargeInclusionFields } from "@/src/components/gateway/BudgetRuleFields.tsx";
import {
	budgetUsdToMicroUsd,
	microUsdToBudgetInput,
} from "@/src/components/gateway/budget-copy.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	BudgetAction,
	BudgetChargeInclusion,
	BudgetRule,
	GatewayAlertTier,
} from "@/src/lib/api/gateway.ts";
import {
	buildBudgetRule,
	DEFAULT_BUDGET_INCLUSION,
} from "@/src/lib/api/gateway.ts";
import {
	ACTION_DESCRIPTIONS,
	ACTION_LABELS,
	ALERT_TIER_TARGETS_NOTE,
	AlertTierSelect,
} from "./budget-form.tsx";

/**
 * The single global per-session charged-spend cap (#510). Unlike user/agent budgets
 * this is one rule, not a map, so it renders as an inline field set (limit +
 * action + conditional downgrade/restrict) with its own Save button.
 */
export function SessionBudgetEditor({
	rule,
	onSave,
	canConfigure,
	target,
}: {
	rule: BudgetRule;
	onSave: (rule: BudgetRule) => Promise<void>;
	/** When false the caller lacks `gateway.configure`; save disabled. */
	canConfigure: boolean;
	/** Node target — powers the "Downgrade to model" catalog picker. */
	target: ApiTarget;
}) {
	const [limitUsd, setLimitUsd] = useState(microUsdToBudgetInput(rule.limit));
	const [action, setAction] = useState<BudgetAction>(rule.action);
	const [include, setInclude] = useState<BudgetChargeInclusion>({
		...DEFAULT_BUDGET_INCLUSION,
		...rule.include,
	});
	// `SessionBudgetConfig.alert` exists in Rust (crates/gateway/budget/src/lib.rs)
	// and the pipeline folds a session decision's tier into the same `max_tier` as
	// user/agent rules, so leaving it out of this editor made the session cap's tier
	// reachable only by hand-editing gateway.toml — and wiped it on every save.
	const [alert, setAlert] = useState<GatewayAlertTier>(rule.alert ?? "silent");
	const [downgradeTo, setDowngradeTo] = useState(rule.downgrade_to ?? "");
	const [restrictMax, setRestrictMax] = useState(
		String(rule.restrict_max_tokens ?? 256)
	);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	const handleSave = async () => {
		const limitMicroUsd = budgetUsdToMicroUsd(limitUsd);
		if (limitMicroUsd === null) {
			setSaveError(
				"Spend cap must be a non-negative USD amount (up to 6 decimals)."
			);
			return;
		}
		const next = buildBudgetRule({
			limit: limitMicroUsd,
			action,
			alert,
			downgradeTo,
			include,
			restrictMaxTokens: restrictMax,
		});
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			await onSave(next);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save session budget."
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption="One cap for every chat session. Set it to 0 to turn it off."
			headerAction={
				<Button
					disabled={!canConfigure}
					loading={saving}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					Save
				</Button>
			}
			title="Per-session (global)"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Input
							className="w-32"
							id="session-budget-limit"
							min={0}
							onChange={(e) => {
								setLimitUsd(e.target.value);
								setSaveOk(false);
							}}
							placeholder="0 = off"
							step="0.01"
							type="number"
							value={limitUsd}
						/>
					}
					description="Lifetime charged spend per session. 0 = unlimited (off). The Gateway stores this as micro-USD."
					title={<Label htmlFor="session-budget-limit">Spend cap (USD)</Label>}
				/>
			</SettingsGroup>
			{/* The inclusion fields are a plain list of checkbox rows; the card
			    gives them the same surface as the rows above. */}
			<SettingsCard className="py-2">
				<BudgetChargeInclusionFields
					idPrefix="session-budget-include"
					onChange={(next) => {
						setInclude(next);
						setSaveOk(false);
					}}
					value={include}
				/>
			</SettingsCard>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={ACTION_LABELS}
							onValueChange={(v) => {
								if (v) {
									setAction(v);
									setSaveOk(false);
								}
							}}
							value={action}
						>
							<SelectTrigger id="session-budget-action">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{
									/* SAFETY: This authored complete string-label map is checked against its closed native domain key union; Object.entries returns its own keys but erases their literal-key types. */ (
										Object.entries(ACTION_LABELS) as [BudgetAction, string][]
									).map(([val, label]) => (
										<SelectItem key={val} value={val}>
											<span className="font-medium">{label}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {ACTION_DESCRIPTIONS[val]}
											</span>
										</SelectItem>
									))
								}
							</SelectContent>
						</Select>
					}
					title={
						<Label htmlFor="session-budget-action">
							Action when spend cap is reached
						</Label>
					}
				/>
				{action === "downgrade" ? (
					<SettingsItem
						actions={
							<AgentModelPickerField
								ariaLabel="Downgrade to model"
								mode="model"
								onChange={(next) => {
									setDowngradeTo(next);
									setSaveOk(false);
								}}
								placeholder="e.g. gpt-4o-mini"
								target={target}
								value={downgradeTo}
							/>
						}
						description="Model to route to once the session cap is exhausted. Falls back to Restrict if left empty."
						title={
							<Label htmlFor="session-budget-downgrade-to">
								Downgrade to model
							</Label>
						}
					/>
				) : null}
				{action === "restrict" ? (
					<SettingsItem
						actions={
							<Input
								className="w-32"
								id="session-budget-restrict-max"
								min={1}
								onChange={(e) => {
									setRestrictMax(e.target.value);
									setSaveOk(false);
								}}
								placeholder="256"
								type="number"
								value={restrictMax}
							/>
						}
						title={
							<Label htmlFor="session-budget-restrict-max">
								Max tokens cap
							</Label>
						}
					/>
				) : null}
				<SettingsItem
					actions={
						<AlertTierSelect
							id="session-budget-alert"
							onChange={(next) => {
								setAlert(next);
								setSaveOk(false);
							}}
							value={alert}
						/>
					}
					description={ALERT_TIER_TARGETS_NOTE}
					title={
						<Label htmlFor="session-budget-alert">
							Notify when this cap fires
						</Label>
					}
				/>
			</SettingsGroup>
			{saveError ? (
				<p className="px-3 text-sm text-status-destructive">{saveError}</p>
			) : null}
			{saveOk ? (
				<p className="px-3 text-sm text-status-success">
					Saved. Changes take effect immediately.
				</p>
			) : null}
		</SettingsSection>
	);
}
