// Option tables and small pickers shared by the policy rules editor sections.

import { GUARDRAIL_ACTION_LABELS, GUARDRAIL_ACTION_OPTIONS } from "./copy.ts";
import {
	POLICY_BUDGET_WINDOW_LABELS,
	POLICY_BUDGET_WINDOWS,
	POLICY_PERMISSION_ACTION_LABELS,
	POLICY_PERMISSION_ACTIONS,
	POLICY_PERMISSION_EFFECT_LABELS,
	POLICY_PERMISSION_EFFECTS,
} from "./policy-model.ts";
import type { GuardrailFirewallAction } from "./types.ts";

export type ListField =
	| "approvedModels"
	| "approvedProviders"
	| "allowedRegions";

export const LIST_FIELDS: Array<{
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

export const ZDR_OPTIONS = [
	{ value: "inherit", label: "Inherit" },
	{ value: "require", label: "Require" },
];

export const BUDGET_OPTIONS = [
	{ value: "none", label: "No cap" },
	...POLICY_BUDGET_WINDOWS.map((window) => ({
		value: window,
		label: POLICY_BUDGET_WINDOW_LABELS[window],
	})),
];

export const PERMISSION_ACTION_OPTIONS = POLICY_PERMISSION_ACTIONS.map(
	(action) => ({
		value: action,
		label: POLICY_PERMISSION_ACTION_LABELS[action],
	})
);

export const PERMISSION_EFFECT_OPTIONS = POLICY_PERMISSION_EFFECTS.map(
	(effect) => ({
		value: effect,
		label: POLICY_PERMISSION_EFFECT_LABELS[effect],
	})
);

export const EVALUATOR_ACTION_OPTIONS = [
	{ value: "default", label: "Evaluator default" },
	...GUARDRAIL_ACTION_OPTIONS.map((option) => ({
		value: option.value,
		label: GUARDRAIL_ACTION_LABELS[option.value],
	})),
];

export function pick<T extends string>(
	options: readonly T[],
	value: string | null,
	fallback: T
): T {
	return options.find((option) => option === value) ?? fallback;
}

export function actionFrom(
	value: string | null
): GuardrailFirewallAction | undefined {
	return GUARDRAIL_ACTION_OPTIONS.find((option) => option.value === value)
		?.value;
}
