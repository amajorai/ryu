"use client";

// The named-policy rules form, shared by the web console and the desktop
// Gateway dialog. Presentational: value in, `onChange` out, no fetching. The
// host owns loading, saving, step-up and the error it shows.

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
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
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../settings-items.tsx";
import { GUARDRAIL_ACTION_LABELS, GUARDRAIL_ACTION_OPTIONS } from "./copy.ts";
import { DlpCard, FirewallCard } from "./firewall-cards.tsx";
import {
	formatPolicyList,
	microFromUsd,
	POLICY_BUDGET_WINDOW_LABELS,
	POLICY_BUDGET_WINDOWS,
	POLICY_LOCKABLE_FIELD_LABELS,
	POLICY_LOCKABLE_FIELDS,
	POLICY_PERMISSION_ACTION_LABELS,
	POLICY_PERMISSION_ACTIONS,
	POLICY_PERMISSION_EFFECT_LABELS,
	POLICY_PERMISSION_EFFECTS,
	type PolicyBudgetWindow,
	type PolicyLockableField,
	type PolicyPermission,
	type PolicyPermissionAction,
	type PolicyPermissionEffect,
	type PolicyRules,
	parsePolicyList,
	policyFirewallCtx,
	usdFromMicro,
} from "./policy-model.ts";
import type { GuardrailFirewallAction } from "./types.ts";

type ListField = "approvedModels" | "approvedProviders" | "allowedRegions";

const LIST_FIELDS: Array<{
	field: ListField;
	help: string;
	placeholder: string;
	title: string;
}> = [
	{
		field: "approvedModels",
		title: "Approved models",
		help: "Exact model ids, separated by commas. Empty means no restriction from this policy.",
		placeholder: "anthropic/claude-sonnet-4.5, openai/gpt-5",
	},
	{
		field: "approvedProviders",
		title: "Approved providers",
		help: "Exact provider ids. Empty means no restriction from this policy.",
		placeholder: "anthropic, openai",
	},
	{
		field: "allowedRegions",
		title: "Allowed regions",
		help: "Regions cover their subregions, so us covers us-east-1.",
		placeholder: "us, eu",
	},
];

const ZDR_OPTIONS = [
	{ value: "inherit", label: "Inherit" },
	{ value: "require", label: "Require" },
];

const BUDGET_OPTIONS = [
	{ value: "none", label: "No cap" },
	...POLICY_BUDGET_WINDOWS.map((window) => ({
		value: window,
		label: POLICY_BUDGET_WINDOW_LABELS[window],
	})),
];

const PERMISSION_ACTION_OPTIONS = POLICY_PERMISSION_ACTIONS.map((action) => ({
	value: action,
	label: POLICY_PERMISSION_ACTION_LABELS[action],
}));

const PERMISSION_EFFECT_OPTIONS = POLICY_PERMISSION_EFFECTS.map((effect) => ({
	value: effect,
	label: POLICY_PERMISSION_EFFECT_LABELS[effect],
}));

const EVALUATOR_ACTION_OPTIONS = [
	{ value: "default", label: "Evaluator default" },
	...GUARDRAIL_ACTION_OPTIONS.map((option) => ({
		value: option.value,
		label: GUARDRAIL_ACTION_LABELS[option.value],
	})),
];

function pick<T extends string>(
	options: readonly T[],
	value: string | null,
	fallback: T
): T {
	return options.find((option) => option === value) ?? fallback;
}

function actionFrom(value: string | null): GuardrailFirewallAction | undefined {
	return GUARDRAIL_ACTION_OPTIONS.find((option) => option.value === value)
		?.value;
}

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

type PermissionRow = PolicyPermission & { rowId: string };

function PermissionRules({
	disabled = false,
	onChange,
	value,
}: PolicyRulesEditorProps) {
	const [rows, setRows] = useState<PermissionRow[]>(() =>
		value.permissions.map((permission) => ({
			...permission,
			rowId: crypto.randomUUID(),
		}))
	);

	const commit = (next: PermissionRow[]) => {
		setRows(next);
		onChange({
			...value,
			permissions: next.map(({ action, effect, resource }) => ({
				action,
				effect,
				resource,
			})),
		});
	};

	const update = (rowId: string, patch: Partial<PolicyPermission>) =>
		commit(
			rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
		);

	const move = (index: number, offset: -1 | 1) => {
		const target = index + offset;
		if (target < 0 || target >= rows.length) {
			return;
		}
		const next = [...rows];
		const [row] = next.splice(index, 1);
		if (row) {
			next.splice(target, 0, row);
		}
		commit(next);
	};

	const add = () =>
		commit([
			...rows,
			{
				action: "tool.call",
				effect: "deny",
				resource: "*",
				rowId: crypto.randomUUID(),
			},
		]);

	return (
		<SettingsSection
			caption="OpenCode-style permissions for tool calls, MCP servers and models. Within this policy the last matching rule wins, so put a catch-all first. Across scopes a lower scope can only tighten (allow, then ask, then deny). Ask acts as deny on requests with no approval path. Use * and ? as wildcards; models take an exact id or *."
			headerAction={
				<Button disabled={disabled} onClick={add} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add rule
				</Button>
			}
			title="Permissions"
		>
			{rows.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No permission rules.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{rows.map((row, index) => (
						<div
							className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"
							key={row.rowId}
						>
							<Select
								disabled={disabled}
								items={PERMISSION_ACTION_OPTIONS}
								onValueChange={(next: string | null) =>
									update(row.rowId, {
										action: pick<PolicyPermissionAction>(
											POLICY_PERMISSION_ACTIONS,
											next,
											"tool.call"
										),
									})
								}
								value={row.action}
							>
								<SelectTrigger
									aria-label={`Rule ${index + 1} applies to`}
									className="w-36"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PERMISSION_ACTION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Input
								aria-label={`Rule ${index + 1} pattern`}
								className="min-w-32 flex-1"
								disabled={disabled}
								onChange={(event) =>
									update(row.rowId, { resource: event.target.value })
								}
								placeholder="*"
								value={row.resource}
								variant="code-caption"
							/>
							<Select
								disabled={disabled}
								items={PERMISSION_EFFECT_OPTIONS}
								onValueChange={(next: string | null) =>
									update(row.rowId, {
										effect: pick<PolicyPermissionEffect>(
											POLICY_PERMISSION_EFFECTS,
											next,
											"deny"
										),
									})
								}
								value={row.effect}
							>
								<SelectTrigger
									aria-label={`Rule ${index + 1} effect`}
									className="w-28"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PERMISSION_EFFECT_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<div className="flex items-center">
								<Button
									aria-label={`Move rule ${index + 1} up`}
									disabled={disabled || index === 0}
									onClick={() => move(index, -1)}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
								</Button>
								<Button
									aria-label={`Move rule ${index + 1} down`}
									disabled={disabled || index === rows.length - 1}
									onClick={() => move(index, 1)}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
								</Button>
								<Button
									aria-label={`Remove rule ${index + 1}`}
									disabled={disabled}
									onClick={() =>
										commit(rows.filter((entry) => entry.rowId !== row.rowId))
									}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={Delete01Icon} />
								</Button>
							</div>
						</div>
					))}
				</SettingsGroup>
			)}
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

interface EvaluatorRow {
	id: string;
	inlineAction?: GuardrailFirewallAction;
	rowId: string;
}

function EvaluatorRules({
	disabled = false,
	onChange,
	value,
}: PolicyRulesEditorProps) {
	const [rows, setRows] = useState<EvaluatorRow[]>(() =>
		value.evaluators.map((evaluator) => ({
			...evaluator,
			rowId: crypto.randomUUID(),
		}))
	);

	const commit = (next: EvaluatorRow[]) => {
		setRows(next);
		onChange({
			...value,
			evaluators: next.map(({ id, inlineAction }) =>
				inlineAction ? { id, inlineAction } : { id }
			),
		});
	};

	return (
		<SettingsSection
			caption="Inline evaluators by catalog id, for example a hazard or PII evaluator. Each runs on the request path with its own action."
			headerAction={
				<Button
					disabled={disabled}
					onClick={() =>
						commit([...rows, { id: "", rowId: crypto.randomUUID() }])
					}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add evaluator
				</Button>
			}
			title="Evaluators"
		>
			{rows.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No evaluators.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{rows.map((row, index) => (
						<div
							className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"
							key={row.rowId}
						>
							<Input
								aria-label={`Evaluator ${index + 1} id`}
								className="min-w-40 flex-1"
								disabled={disabled}
								onChange={(event) =>
									commit(
										rows.map((entry) =>
											entry.rowId === row.rowId
												? { ...entry, id: event.target.value.trim() }
												: entry
										)
									)
								}
								placeholder="Evaluator id"
								value={row.id}
								variant="code-caption"
							/>
							<Select
								disabled={disabled}
								items={EVALUATOR_ACTION_OPTIONS}
								onValueChange={(next: string | null) =>
									commit(
										rows.map((entry) =>
											entry.rowId === row.rowId
												? { ...entry, inlineAction: actionFrom(next) }
												: entry
										)
									)
								}
								value={row.inlineAction ?? "default"}
							>
								<SelectTrigger
									aria-label={`Evaluator ${index + 1} action`}
									className="w-44"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{EVALUATOR_ACTION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								aria-label={`Remove evaluator ${index + 1}`}
								disabled={disabled}
								onClick={() =>
									commit(rows.filter((entry) => entry.rowId !== row.rowId))
								}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Delete01Icon} />
							</Button>
						</div>
					))}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}

function LockedFields({
	disabled = false,
	locked,
	onLockedChange,
}: PolicyRulesEditorProps) {
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
								aria-label={`Lock ${POLICY_LOCKABLE_FIELD_LABELS[field]}`}
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
