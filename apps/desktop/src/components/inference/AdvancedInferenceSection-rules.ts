// Sampling field rules, schemas, and validation for AdvancedInferenceSection.

import type { LiteralMessage } from "@ryu/i18n/react";
import { z } from "zod";
import type { SamplingConfig } from "@/src/lib/api/inference.ts";

export const jsonObjectSchema = z.record(z.string(), z.json());
export const logitBiasSchema = z.record(
	z.string().regex(/^\d+$/),
	z.number().min(-100).max(100)
);
export type Key = keyof SamplingConfig;

export type NumberKey = {
	[K in Key]-?: Exclude<SamplingConfig[K], undefined> extends number
		? K
		: never;
}[Key];

interface SamplingNumberRule {
	integer?: boolean;
	label: string;
	max?: number;
	min?: number;
}

const SAMPLING_NUMBER_RULES = new Map<Key, SamplingNumberRule>([
	["dry_allowed_length", { integer: true, label: "DRY allowed length" }],
	["dry_penalty_last_n", { integer: true, label: "DRY penalty last N" }],
	[
		"frequency_penalty",
		{
			label: "Frequency penalty",
			max: 2,
			min: -2,
		},
	],
	["max_tokens", { integer: true, label: "Max tokens", min: 1 }],
	["mirostat", { integer: true, label: "Mirostat mode", max: 2, min: 0 }],
	["mirostat_eta", { label: "Mirostat eta", min: 0 }],
	["mirostat_tau", { label: "Mirostat tau", min: 0 }],
	["min_p", { label: "Min P", max: 1, min: 0 }],
	[
		"presence_penalty",
		{
			label: "Presence penalty",
			max: 2,
			min: -2,
		},
	],
	["repeat_last_n", { integer: true, label: "Repeat last N" }],
	["repeat_penalty", { label: "Repeat penalty", min: 0 }],
	["seed", { integer: true, label: "Seed" }],
	["temperature", { label: "Temperature", max: 2, min: 0 }],
	["top_k", { integer: true, label: "Top K", min: 0 }],
	["top_p", { label: "Top P", max: 1, min: 0 }],
	["typical_p", { label: "Typical P", max: 1, min: 0 }],
	["xtc_probability", { label: "XTC probability", max: 1, min: 0 }],
]);

export type SamplingScope = "agent" | "engine" | "model";

export function samplingNumberError(
	key: Key,
	value: number,
	scope: SamplingScope,
	engineId: string | undefined,
	tl: LiteralMessage
): string | null {
	const rule = SAMPLING_NUMBER_RULES.get(key);
	if (!Number.isFinite(value)) {
		return tl("{label} must be a finite number.", {
			label: rule?.label ?? key,
		});
	}
	if (
		scope === "engine" &&
		engineId === "ollama" &&
		key === "repeat_last_n" &&
		value < 0
	) {
		return "Repeat window must be at least 0.";
	}
	if (rule?.integer && !Number.isSafeInteger(value)) {
		return tl("{label} must be a whole number.", { label: rule.label });
	}
	if (rule?.min !== undefined && value < rule.min) {
		return tl("{label} must be at least {min}.", {
			label: rule.label,
			min: String(rule.min),
		});
	}
	if (rule?.max !== undefined && value > rule.max) {
		return tl("{label} must be no greater than {max}.", {
			label: rule.label,
			max: String(rule.max),
		});
	}
	return null;
}

/** Shared state and setters the field-group sections render against. */
export interface SamplingFieldsProps {
	disabled?: boolean;
	engineId?: string;
	localEngine: boolean;
	num: (key: NumberKey) => number | undefined;
	scope: SamplingScope;
	set: <K extends Key>(key: K, v: SamplingConfig[K] | undefined) => void;
	setNumber: (key: Key, nextValue: number | undefined) => void;
	shows: (key: Key, legacy?: boolean) => boolean;
	supportedFields?: ReadonlySet<string>;
	value: SamplingConfig;
}
