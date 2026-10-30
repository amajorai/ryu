import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { type ReactNode, useEffect, useState } from "react";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import type { RoutingCondition } from "@/src/lib/api/routing.ts";
import { type ScopeOption, scopeValue, WINDOW_OPTIONS } from "./shared.tsx";

/** Keep number editing local until commit so an autosave can't interrupt typing. */
function ThresholdInput({
	disabled,
	id,
	inputMode,
	label,
	max,
	onCommit,
	value,
}: {
	disabled: boolean;
	id: string;
	inputMode: "decimal" | "numeric";
	label: string;
	max?: number;
	onCommit: (value: number) => void;
	value: number;
}) {
	const tl = useLiteralMessages();
	const [draft, setDraft] = useState(String(value));
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setDraft(String(value));
		setError(null);
	}, [value]);

	const commit = () => {
		const trimmed = draft.trim();
		const parsed = Number(trimmed);
		if (
			trimmed.length === 0 ||
			!Number.isFinite(parsed) ||
			parsed < 0 ||
			(max !== undefined && parsed > max)
		) {
			setError(
				max === undefined
					? "Enter a non-negative USD amount."
					: tl("Enter a percent from 0 to {max}.", { max })
			);
			return;
		}
		setError(null);
		if (parsed !== value) {
			onCommit(parsed);
		}
	};

	return (
		<SettingsItem
			actions={
				<div>
					<Input
						aria-describedby={error ? `${id}-error` : undefined}
						aria-invalid={error ? true : undefined}
						className="h-8 w-28"
						disabled={disabled}
						id={id}
						inputMode={inputMode}
						onBlur={commit}
						onChange={(event) => {
							setDraft(event.target.value);
							setError(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								event.currentTarget.blur();
							}
						}}
						value={draft}
					/>
				</div>
			}
			title={<label htmlFor={id}>{label}</label>}
		>
			{error ? (
				<p className="text-destructive text-xs" id={`${id}-error`} role="alert">
					{error}
				</p>
			) : null}
		</SettingsItem>
	);
}

/**
 * The threshold + its qualifiers, which differ per source. Returned as an array
 * of rows (not a wrapper component) so the rule's `SettingsGroup` draws its
 * hairlines between each of them.
 */
export function conditionRows({
	condition,
	creditProviders,
	disabled,
	ruleId,
	onChange,
	scopes,
}: {
	condition: RoutingCondition;
	creditProviders: string[];
	disabled: boolean;
	ruleId: string;
	onChange: (next: RoutingCondition) => void;
	scopes: ScopeOption[];
}): ReactNode[] {
	if (condition.source === "ryu_credits") {
		return [
			<ThresholdInput
				disabled={disabled}
				id={`ryu-credit-threshold-${ruleId}`}
				inputMode="decimal"
				key="threshold"
				label="Dollars left, below"
				onCommit={(below_usd) => onChange({ ...condition, below_usd })}
				value={condition.below_usd}
			/>,
		];
	}

	if (condition.source === "provider_credits") {
		return [
			<SettingsItem
				actions={
					<Select
						disabled={disabled}
						items={creditProviders.map((id) => ({ label: id, value: id }))}
						onValueChange={(provider_id) =>
							onChange({ ...condition, provider_id: provider_id ?? "" })
						}
						value={condition.provider_id}
					>
						<SelectTrigger
							className="h-8 w-40"
							id={`credit-provider-${ruleId}`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{creditProviders.map((id) => (
								<SelectItem key={id} value={id}>
									{id}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
				key="provider"
				title={<label htmlFor={`credit-provider-${ruleId}`}>Provider</label>}
			/>,
			<ThresholdInput
				disabled={disabled}
				id={`provider-credit-threshold-${ruleId}`}
				inputMode="decimal"
				key="threshold"
				label="Dollars left, below"
				onCommit={(below_usd) => onChange({ ...condition, below_usd })}
				value={condition.below_usd}
			/>,
		];
	}

	const currentScope = scopeValue(condition);
	// A saved scope that is no longer offered (an account was removed, or the
	// listing has not loaded) still shows by id instead of a blank trigger.
	const scopeItems = scopes.some((option) => option.value === currentScope)
		? scopes
		: [
				...scopes,
				{
					label:
						condition.account_id ?? condition.provider_id ?? condition.agent_id,
					scope: {
						agent_id: condition.agent_id,
						provider_id: condition.provider_id,
						account_id: condition.account_id,
					},
					value: currentScope,
				},
			];
	return [
		<SettingsItem
			actions={
				<Select
					disabled={disabled}
					items={scopeItems}
					onValueChange={(value) => {
						const picked = scopeItems.find((option) => option.value === value);
						if (!picked) {
							return;
						}
						// Rebuild the scope rather than spreading over it: a stale
						// `account_id` from a previous pick must not survive.
						const {
							agent_id: _agent,
							provider_id: _provider,
							account_id: _account,
							...rest
						} = condition;
						onChange({ ...rest, ...picked.scope });
					}}
					value={currentScope}
				>
					<SelectTrigger
						className="h-8 w-64"
						id={`subscription-agent-${ruleId}`}
					>
						<SelectValue placeholder="Pick a subscription" />
					</SelectTrigger>
					<SelectContent>
						{scopeItems.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			key="subscription"
			title={
				<label htmlFor={`subscription-agent-${ruleId}`}>Subscription</label>
			}
		/>,
		<SettingsItem
			actions={
				<Select
					disabled={disabled}
					items={WINDOW_OPTIONS}
					onValueChange={(window) =>
						onChange({
							...condition,
							window: !window || window === "any" ? "" : window,
						})
					}
					value={condition.window === "" ? "any" : condition.window}
				>
					<SelectTrigger
						className="h-8 w-40"
						id={`subscription-window-${ruleId}`}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{WINDOW_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			key="window"
			title={<label htmlFor={`subscription-window-${ruleId}`}>Window</label>}
		/>,
		<ThresholdInput
			disabled={disabled}
			id={`window-threshold-${ruleId}`}
			inputMode="numeric"
			key="threshold"
			label="Percent left, below"
			max={100}
			onCommit={(remaining_below_percent) =>
				onChange({ ...condition, remaining_below_percent })
			}
			value={condition.remaining_below_percent}
		/>,
	];
}
