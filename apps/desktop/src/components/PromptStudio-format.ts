// Prompt Studio placeholder, variable, and score formatting helpers.

import { isString } from "@/src/lib/prompt-studio.ts";
import {
	type PromptfooValue,
	parsePromptfooValue,
} from "@/src/lib/promptfoo.ts";

// ── Variable placeholder detection ────────────────────────────────────────────
// Named placeholders in {{variable_name}} syntax. A top-level regex (not created
// inside a loop) per the code standards.
const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

// Large-matrix warning threshold (models × cases). Multi-model × llm_judge fans
// out to sequential provider calls under Core's 120s proxy timeout.
export const LARGE_MATRIX_THRESHOLD = 12;

export function extractPlaceholders(prompt: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const match of prompt.matchAll(PLACEHOLDER_RE)) {
		const name = match[1];
		if (!seen.has(name)) {
			seen.add(name);
			result.push(name);
		}
	}
	return result;
}

export function normalizePromptPlaceholders(prompt: string): string {
	// Plate's Markdown serializer escapes opening braces. Preserve Prompt Studio's
	// documented `{{variable}}` syntax when the prompt is edited in the rich editor.
	return prompt.replace(/\\+\{\\+\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/gu, "{{$1}}");
}

export function escapePromptPlaceholdersForEditor(prompt: string): string {
	// Plate's Markdown parser interprets raw `{{name}}` as an expression instead
	// of literal prompt text. Escaping the openers keeps placeholders visible;
	// normalizePromptPlaceholders removes those escapes on the next edit.
	return prompt.replace(
		/(?<!\\)\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/gu,
		String.raw`\{\{$1}}`
	);
}

export function hasPromptContent(prompt: string): boolean {
	return prompt.replaceAll("\u200B", "").trim().length > 0;
}

export function renderPrompt(
	prompt: string,
	vars: Record<string, string>
): string {
	return prompt.replace(
		PLACEHOLDER_RE,
		(_, name: string) => vars[name] ?? `{{${name}}}`
	);
}

export function displayVariable(value: PromptfooValue): string {
	if (isString(value)) {
		return value;
	}
	if (value === undefined) {
		return "";
	}
	return JSON.stringify(value);
}

export function parseVariable(value: string): PromptfooValue {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	try {
		return parsePromptfooValue(JSON.parse(trimmed));
	} catch {
		return value;
	}
}

export function pct(value: number): string {
	return `${Math.round(value * 100)}%`;
}

export function scoreTone(score: number): string {
	if (score >= 0.75) {
		return "text-status-success dark:text-status-success";
	}
	if (score >= 0.5) {
		return "text-status-warning dark:text-status-warning";
	}
	return "text-status-destructive";
}

export function formatMicroUsd(value: number | null | undefined): string {
	return value === null || value === undefined
		? "unknown"
		: `$${(value / 1_000_000).toFixed(4)}`;
}
