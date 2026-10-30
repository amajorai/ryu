"use client";

// The named-policy rules form, shared by the web console and the desktop
// Gateway dialog. Presentational: value in, `onChange` out, no fetching. The
// host owns loading, saving, step-up and the error it shows.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { useEffect, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../settings-items.tsx";
import { DlpCard, FirewallCard } from "./firewall-cards.tsx";
import {
	formatPolicyList,
	microFromUsd,
	POLICY_BUDGET_WINDOWS,
	POLICY_LOCKABLE_FIELD_LABELS,
	POLICY_LOCKABLE_FIELDS,
	type PolicyBudgetWindow,
	type PolicyLockableField,
	type PolicyRules,
	parsePolicyList,
	policyFirewallCtx,
	usdFromMicro,
} from "./policy-model.ts";
import { EvaluatorRules } from "./policy-rules-editor-evaluators.tsx";
import {
	BUDGET_OPTIONS,
	LIST_FIELDS,
	type ListField,
	pick,
	ZDR_OPTIONS,
} from "./policy-rules-editor-options.ts";
import { PermissionRules } from "./policy-rules-editor-permissions.tsx";

export interface PolicyRulesEditorProps {
	disabled?: boolean;
	locked: PolicyLockableField[];
	onChange: (next: PolicyRules) => void;
	onLockedChange: (next: PolicyLockableField[]) => void;
	/**
	 * Reports whether every field holds a value the draft can be saved with.
	 * The spend cap amount is the one field whose text can disagree with the
	 * draft (empty, or not a number), so a host must block saving while this
	 * is `false`.
	 */
	onValidityChange?: (valid: boolean) => void;
	/**
	 * Identifies the policy being edited. Local text state reseeds when it
	 * changes, so pass the policy id (or "new").
	 */
	policyKey: string;
	value: PolicyRules;
}

export function PolicyRulesEditor(props: PolicyRulesEditorProps) {
	return (
		<div className="flex flex-col gap-6" key={props.policyKey}>
			<RoutingRules {...props} />
			<BudgetRule {...props} />
			<PermissionRules {...props} />
			<FirewallRules {...props} />
			<EvaluatorRules {...props} />
			<LockedFields {...props} />
		</div>
	);
}

function ListFieldInput({
	description,
	disabled,
	field,
	onChange,
	placeholder,
	title,
	value,
}: {
	/** Read by the enclosing `SettingsGroup` as this row's footer. */
	description: string;
	disabled: boolean;
	field: ListField;
	onChange: (next: string[]) => void;
	placeholder: string;
	title: string;
	value: string[];
}) {
	// Raw text stays local so a trailing comma survives while typing.
	const [text, setText] = useState(() => formatPolicyList(value));
	const id = `policy-${field}`;
	return (
		<SettingsItem
			actions={
				<Input
					disabled={disabled}
					id={id}
					onChange={(event) => {
						setText(event.target.value);
						onChange(parsePolicyList(event.target.value));
					}}
					placeholder={placeholder}
					value={text}
				/>
			}
			description={description}
			title={<Label htmlFor={id}>{title}</Label>}
		/>
	);
}

function RoutingRules({
	disabled = false,
	onChange,
	value,
}: PolicyRulesEditorProps) {
	return (
		<SettingsSection
			caption="Allowlists intersect across scopes, so a lower scope can narrow them but never widen them."
			title="Models, providers and regions"
		>
			<SettingsGroup>
				{LIST_FIELDS.map((entry) => (
					<ListFieldInput
						description={entry.help}
						disabled={disabled}
						field={entry.field}
						key={entry.field}
						onChange={(next) => onChange({ ...value, [entry.field]: next })}
						placeholder={entry.placeholder}
						title={entry.title}
						value={value[entry.field]}
					/>
				))}
				<SettingsItem
					actions={
						<Select
							disabled={disabled}
							items={ZDR_OPTIONS}
							onValueChange={(next: string | null) =>
								onChange({
									...value,
									zeroDataRetention: next === "require" ? true : null,
								})
							}
							value={value.zeroDataRetention === true ? "require" : "inherit"}
						>
							<SelectTrigger className="w-40" id="policy-zdr">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{ZDR_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Route only to providers that keep no prompts or completions. Any scope that requires it wins."
					title={<Label htmlFor="policy-zdr">Zero data retention</Label>}
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

function BudgetRule({
	disabled = false,
	onChange,
	onValidityChange,
	value,
}: PolicyRulesEditorProps) {
	const budget = value.budgets[0];
	const [amount, setAmount] = useState(() =>
		budget ? usdFromMicro(budget.usdMicro) : ""
	);
	// A chosen window with an empty or non-numeric amount must not save: the
	// draft would carry a $0 placeholder or the previous cap instead.
	const invalid = budget !== undefined && microFromUsd(amount) === null;

	useEffect(() => {
		onValidityChange?.(!invalid);
	}, [invalid, onValidityChange]);

	const setWindow = (next: string | null) => {
		if (next === "none" || next === null) {
			onChange({ ...value, budgets: [] });
			return;
		}
		const window = pick<PolicyBudgetWindow>(
			POLICY_BUDGET_WINDOWS,
			next,
			"monthly"
		);
		onChange({
			...value,
			budgets: [{ usdMicro: budget?.usdMicro ?? 0, window }],
		});
	};

	return (
		<SettingsSection
			caption="One cap per policy. Each scope's cap is checked on its own, and a key's spend also counts toward its member and organization."
			title="Spend cap"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							disabled={disabled}
							items={BUDGET_OPTIONS}
							onValueChange={setWindow}
							value={budget?.window ?? "none"}
						>
							<SelectTrigger className="w-40" id="policy-budget-window">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{BUDGET_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title={<Label htmlFor="policy-budget-window">Window</Label>}
				/>
				{budget ? (
					<SettingsItem
						actions={
							<Input
								aria-invalid={invalid}
								className="w-32"
								disabled={disabled}
								id="policy-budget-amount"
								inputMode="decimal"
								onChange={(event) => {
									setAmount(event.target.value);
									const usdMicro = microFromUsd(event.target.value);
									if (usdMicro !== null) {
										onChange({
											...value,
											budgets: [{ usdMicro, window: budget.window }],
										});
									}
								}}
								placeholder="100"
								value={amount}
							/>
						}
						description={
							invalid
								? "Enter an amount in US dollars, zero or more."
								: undefined
						}
						title={<Label htmlFor="policy-budget-amount">Cap (USD)</Label>}
					/>
				) : null}
			</SettingsGroup>
		</SettingsSection>
	);
}

function FirewallRules({
	disabled = false,
	onChange,
	policyKey,
	value,
}: PolicyRulesEditorProps) {
	const ctx = policyFirewallCtx({
		disabled,
		firewall: value.firewall,
		onChange: (firewall) => onChange({ ...value, firewall }),
		policyKey,
	});
	return (
		<>
			<FirewallCard
				caption="A policy can turn protections on and raise the action. Inherit leaves the field to the scopes above and the node's own settings."
				ctx={ctx}
				patternsCaption="Patterns are added to every inherited pattern, never replacing them."
				showAlert={false}
			/>
			<DlpCard ctx={ctx} />
		</>
	);
}

function LockedFields({
	disabled = false,
	locked,
	onLockedChange,
}: PolicyRulesEditorProps) {
	const tl = useLiteralMessages();
	const toggle = (field: PolicyLockableField, on: boolean) =>
		onLockedChange(
			on ? [...locked, field] : locked.filter((entry) => entry !== field)
		);
	return (
		<SettingsSection
			caption="Locks apply only when this policy is assigned to the organization. A locked field cannot be changed by any team, member, key or agent policy."
			title="Locked fields"
		>
			<SettingsGroup>
				{POLICY_LOCKABLE_FIELDS.map((field) => (
					<SettingsItem
						actions={
							<Switch
								aria-label={tl("Lock {field}", {
									field: POLICY_LOCKABLE_FIELD_LABELS[field],
								})}
								checked={locked.includes(field)}
								disabled={disabled}
								onCheckedChange={(on: boolean) => toggle(field, on)}
							/>
						}
						key={field}
						title={POLICY_LOCKABLE_FIELD_LABELS[field]}
					/>
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

/** Name and description fields, kept apart so a host can place them. */
export function PolicyDetailsFields({
	description,
	disabled = false,
	name,
	onDescriptionChange,
	onNameChange,
}: {
	description: string;
	disabled?: boolean;
	name: string;
	onDescriptionChange: (next: string) => void;
	onNameChange: (next: string) => void;
}) {
	return (
		<SettingsSection title="Policy">
			<SettingsGroup>
				<SettingsItem
					actions={
						<Input
							disabled={disabled}
							id="policy-name"
							maxLength={80}
							onChange={(event) => onNameChange(event.target.value)}
							placeholder="Production defaults"
							required
							value={name}
						/>
					}
					title={<Label htmlFor="policy-name">Name</Label>}
				/>
				<SettingsItem
					bare
					title={<Label htmlFor="policy-description">Description</Label>}
				>
					<Textarea
						disabled={disabled}
						id="policy-description"
						maxLength={500}
						onChange={(event) => onDescriptionChange(event.target.value)}
						placeholder="What this policy is for"
						rows={2}
						value={description}
					/>
				</SettingsItem>
			</SettingsGroup>
		</SettingsSection>
	);
}
