import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import {
	ACTION_DESCRIPTIONS,
	ACTION_LABELS,
	ALERT_TIER_DESCRIPTIONS,
	ALERT_TIER_OPTIONS,
	ALERT_TIER_TARGETS_NOTE,
	type BudgetFormState,
} from "@/src/components/gateway/budget-copy.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { BudgetChargeInclusion } from "@/src/lib/api/gateway.ts";

export function BudgetChargeInclusionFields({
	disabled,
	idPrefix,
	onChange,
	value,
}: {
	disabled?: boolean;
	idPrefix: string;
	onChange: (value: BudgetChargeInclusion) => void;
	value: BudgetChargeInclusion;
}) {
	const options: {
		key: keyof BudgetChargeInclusion;
		label: string;
		description: string;
	}[] = [
		{
			key: "model",
			label: "Model calls",
			description: "OpenRouter/provider inference",
		},
		{
			key: "media",
			label: "Media",
			description: "Image, video, speech",
		},
		{
			key: "tools",
			label: "Paid tools",
			description: "Composio actions",
		},
	];

	return (
		<div className="flex flex-col gap-1.5">
			<Label>Count toward this cap</Label>
			{/* Plain checkbox rows, no tiles: this sits inside a settings card or a
			    dialog form, where a bordered box per option nests a box in a box. */}
			<div className="flex flex-col gap-2.5 py-1">
				{options.map((option) => (
					<label className="flex items-start gap-2.5 text-sm" key={option.key}>
						<Checkbox
							checked={value[option.key]}
							disabled={disabled}
							id={`${idPrefix}-${option.key}`}
							onCheckedChange={(checked) =>
								onChange({ ...value, [option.key]: checked === true })
							}
						/>
						<span>
							<span className="block">{option.label}</span>
							<span className="block text-muted-foreground text-xs">
								{option.description}
							</span>
						</span>
					</label>
				))}
			</div>
			<p className="text-muted-foreground text-xs">
				OpenRouter-reported charges are used when available. Subscription ACP
				passthrough is external and cannot be dollar-metered by Ryu.
			</p>
		</div>
	);
}

function AlertTierSelect({
	id,
	onChange,
	value,
	disabled,
}: {
	id: string;
	onChange: (value: BudgetFormState["alert"]) => void;
	value: BudgetFormState["alert"];
	disabled?: boolean;
}) {
	return (
		<Select<BudgetFormState["alert"]>
			disabled={disabled}
			items={ALERT_TIER_OPTIONS}
			onValueChange={(next) => {
				if (next) {
					onChange(next);
				}
			}}
			value={value}
		>
			<SelectTrigger id={id}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ALERT_TIER_OPTIONS.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						<span className="font-medium">{option.label.split(" — ")[0]}</span>
						<span className="ml-1 text-muted-foreground text-xs">
							— {ALERT_TIER_DESCRIPTIONS[option.value]}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function BudgetRuleFields({
	disabled,
	form,
	idPrefix,
	onChange,
	target,
}: {
	disabled?: boolean;
	form: BudgetFormState;
	idPrefix: string;
	onChange: (next: BudgetFormState) => void;
	target: ApiTarget;
}) {
	const patch = (next: Partial<BudgetFormState>) =>
		onChange({ ...form, ...next });

	// SAFETY: The private authored ACTION_LABELS table has exactly the BudgetFormState action keys and string labels. Native Object.entries erases those finite keys to string; repository consumers only read this table.
	return (
		<div className="flex flex-col gap-4 py-2">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-limit`}>Spend cap (USD)</Label>
				<Input
					disabled={disabled}
					id={`${idPrefix}-limit`}
					min={0}
					onChange={(event) => patch({ limitUsd: event.target.value })}
					placeholder="1.00"
					step="0.01"
					type="number"
					value={form.limitUsd}
				/>
				<p className="text-muted-foreground text-xs">
					Lifetime charged spend. 0 = unlimited. The Gateway stores this as
					micro-USD.
				</p>
			</div>
			<BudgetChargeInclusionFields
				disabled={disabled}
				idPrefix={`${idPrefix}-include`}
				onChange={(include) => patch({ include })}
				value={form.include}
			/>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-action`}>
					Action when spend cap is reached
				</Label>
				<Select<BudgetFormState["action"]>
					disabled={disabled}
					items={Object.entries(ACTION_LABELS).map(([value, label]) => ({
						value,
						label,
					}))}
					onValueChange={(next) => {
						if (next) {
							patch({ action: next });
						}
					}}
					value={form.action}
				>
					<SelectTrigger id={`${idPrefix}-action`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(
							Object.entries(ACTION_LABELS) as [
								BudgetFormState["action"],
								string,
							][]
						).map(([value, label]) => (
							<SelectItem key={value} value={value}>
								<span className="font-medium">{label}</span>
								<span className="ml-1 text-muted-foreground text-xs">
									— {ACTION_DESCRIPTIONS[value]}
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{form.action === "downgrade" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-downgrade-to`}>Downgrade to model</Label>
					<AgentModelPickerField
						ariaLabel="Downgrade to model"
						disabled={disabled}
						mode="model"
						onChange={(next) => patch({ downgrade_to: next })}
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
					<Label htmlFor={`${idPrefix}-restrict-max`}>Max tokens cap</Label>
					<Input
						disabled={disabled}
						id={`${idPrefix}-restrict-max`}
						min={1}
						onChange={(event) =>
							patch({ restrict_max_tokens: event.target.value })
						}
						placeholder="256"
						type="number"
						value={form.restrict_max_tokens}
					/>
				</div>
			) : null}
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-alert`}>Notify when this rule fires</Label>
				<AlertTierSelect
					disabled={disabled}
					id={`${idPrefix}-alert`}
					onChange={(alert) => patch({ alert })}
					value={form.alert}
				/>
				<p className="text-muted-foreground text-xs">
					{ALERT_TIER_TARGETS_NOTE}
				</p>
			</div>
		</div>
	);
}
