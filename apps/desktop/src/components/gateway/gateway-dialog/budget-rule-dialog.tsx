import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { ReactElement } from "react";
import { useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { BudgetChargeInclusionFields } from "@/src/components/gateway/BudgetRuleFields.tsx";
import { budgetUsdToMicroUsd } from "@/src/components/gateway/budget-copy.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { BudgetAction } from "@/src/lib/api/gateway.ts";
import {
	ACTION_DESCRIPTIONS,
	ACTION_LABELS,
	ALERT_TIER_TARGETS_NOTE,
	AlertTierSelect,
	type BudgetFormState,
	DEFAULT_FORM,
} from "./budget-form.tsx";

export function BudgetRuleDialog({
	trigger,
	title,
	description,
	initial,
	agentIdReadOnly,
	agents,
	target,
	idLabel = "Agent ID",
	idPlaceholder = "e.g. claude or my-agent",
	idRequiredError = "Agent ID is required.",
	onSave,
}: {
	trigger: ReactElement;
	title: string;
	description: string;
	initial?: BudgetFormState;
	agentIdReadOnly?: boolean;
	agents?: AgentSummary[];
	/** Node target — powers the "Downgrade to model" catalog picker. */
	target: ApiTarget;
	/** Field label for the identity input (e.g. "Agent ID" or "User ID"). */
	idLabel?: string;
	/** Placeholder for the free-text identity input. */
	idPlaceholder?: string;
	/** Validation message when the identity is left blank. */
	idRequiredError?: string;
	onSave: (form: BudgetFormState) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<BudgetFormState>(initial ?? DEFAULT_FORM);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setForm(initial ?? DEFAULT_FORM);
			setErr(null);
		}
		setOpen(next);
	};

	const handleSave = async () => {
		if (!form.agentId.trim()) {
			setErr(idRequiredError);
			return;
		}
		if (budgetUsdToMicroUsd(form.limitUsd) === null) {
			setErr("Spend cap must be a non-negative USD amount (up to 6 decimals).");
			return;
		}
		if (form.action === "restrict") {
			const maxTokens = Number(form.restrict_max_tokens.trim());
			if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
				setErr("Max tokens cap must be a positive whole number.");
				return;
			}
		}
		setSaving(true);
		setErr(null);
		try {
			await onSave(form);
			setOpen(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to save budget rule.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-agent-id">{idLabel}</Label>
						{!agentIdReadOnly && agents && agents.length > 0 ? (
							<Select
								items={agents.map((a) => ({ value: a.id, label: a.name }))}
								onValueChange={(v) =>
									v && setForm((f) => ({ ...f, agentId: v }))
								}
								value={form.agentId}
							>
								<SelectTrigger id="budget-agent-id">
									<SelectValue placeholder="Select an agent" />
								</SelectTrigger>
								<SelectContent>
									{agents.map((a) => (
										<SelectItem key={a.id} value={a.id}>
											<span className="font-medium">{a.name}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {a.id}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : (
							<Input
								disabled={agentIdReadOnly}
								id="budget-agent-id"
								onChange={(e) =>
									setForm((f) => ({ ...f, agentId: e.target.value }))
								}
								placeholder={idPlaceholder}
								value={form.agentId}
							/>
						)}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-limit">Spend cap (USD)</Label>
						<Input
							id="budget-limit"
							min={0}
							onChange={(e) =>
								setForm((f) => ({ ...f, limitUsd: e.target.value }))
							}
							placeholder="1.00"
							step="0.000001"
							type="number"
							value={form.limitUsd}
						/>
						<p className="text-muted-foreground text-xs">
							Lifetime charged spend. 0 = unlimited. The Gateway stores this as
							micro-USD.
						</p>
					</div>
					<BudgetChargeInclusionFields
						idPrefix="budget-include"
						onChange={(include) => setForm((f) => ({ ...f, include }))}
						value={form.include}
					/>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-action">
							Action when spend cap is reached
						</Label>
						<Select
							items={ACTION_LABELS}
							onValueChange={(v) => v && setForm((f) => ({ ...f, action: v }))}
							value={form.action}
						>
							<SelectTrigger id="budget-action">
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
					</div>
					{form.action === "downgrade" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="budget-downgrade-to">Downgrade to model</Label>
							<AgentModelPickerField
								ariaLabel="Downgrade to model"
								mode="model"
								onChange={(next) =>
									setForm((f) => ({ ...f, downgrade_to: next }))
								}
								placeholder="e.g. gpt-4o-mini"
								target={target}
								value={form.downgrade_to}
							/>
							<p className="text-muted-foreground text-xs">
								Model to route to when the budget is exhausted. Falls back to
								Restrict if left empty.
							</p>
						</div>
					) : null}
					{form.action === "restrict" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="budget-restrict-max">Max tokens cap</Label>
							<Input
								id="budget-restrict-max"
								min={1}
								onChange={(e) =>
									setForm((f) => ({
										...f,
										restrict_max_tokens: e.target.value,
									}))
								}
								placeholder="256"
								type="number"
								value={form.restrict_max_tokens}
							/>
						</div>
					) : null}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="budget-alert">Notify when this rule fires</Label>
						<AlertTierSelect
							id="budget-alert"
							onChange={(next) => setForm((f) => ({ ...f, alert: next }))}
							value={form.alert}
						/>
						<p className="text-muted-foreground text-xs">
							{ALERT_TIER_TARGETS_NOTE}
						</p>
					</div>
					{err ? (
						<p className="text-sm text-status-destructive" role="alert">
							{err}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						loading={saving}
						onClick={() => handleSave()}
						variant="outline"
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
