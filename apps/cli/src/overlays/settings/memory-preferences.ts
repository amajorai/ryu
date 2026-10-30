import { z } from "zod";

export const KEYS = {
	autoRecall: "auto-recall-enabled",
	topK: "auto-recall-top-k",
	contextBudget: "context.max-tokens",
	contextReserve: "context.max-output-tokens",
	autoCompact: "context.auto-compact",
	skills: "skills-disclosure",
	ranker: "tools.active_ranker",
} as const;

export const ROWS = [
	"autoRecall",
	"topK",
	"contextBudget",
	"contextReserve",
	"autoCompact",
	"skills",
	"ranker",
] as const;

export type RowId = (typeof ROWS)[number];
export type ContextBudget = "off" | "auto" | `tokens:${number}`;
export type Ranker = "needle2" | "bm25" | "semantic";

export interface MemoryPreferences {
	autoCompact: boolean;
	autoRecall: boolean;
	contextBudget: ContextBudget;
	contextReserve: number;
	ranker: Ranker;
	skills: boolean;
	topK: number;
}

export const preferenceWireSchema = z.object({
	value: z.string().nullable().catch(null),
});
export type PreferenceWire = z.infer<typeof preferenceWireSchema>;

export interface PreferenceWrite {
	key: string;
	value: string;
}

export interface SaveIntent {
	label: string;
	next: Partial<MemoryPreferences>;
	previous: Partial<MemoryPreferences>;
	writes: readonly PreferenceWrite[];
}

export const DEFAULTS: MemoryPreferences = {
	autoRecall: true,
	topK: 5,
	contextBudget: "off",
	contextReserve: 1024,
	autoCompact: false,
	skills: true,
	ranker: "needle2",
};

export const TOP_K_MIN = 1;
export const TOP_K_MAX = 50;
export const BUDGET_MIN = 2048;
export const BUDGET_MAX = 2_000_000;
export const RESERVE_MIN = 128;
export const RESERVE_MAX = 32_768;
export const RANKERS: readonly Ranker[] = ["needle2", "bm25", "semantic"];

export function raw(wire: PreferenceWire): string | null {
	return wire.value;
}

export function parseBoolean(value: string | null, fallback: boolean): boolean {
	if (value === null) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "on", "yes"].includes(normalized)) {
		return true;
	}
	if (["false", "0", "off", "no"].includes(normalized)) {
		return false;
	}
	return fallback;
}

export function parseAutoRecall(value: string | null): boolean {
	if (value === null) {
		return true;
	}
	return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
}

export function parseContextBudget(value: string | null): ContextBudget {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "" || normalized === "0" || normalized === "off") {
		return "off";
	}
	if (normalized === "auto") {
		return "auto";
	}
	if (!/^\+?\d+$/.test(normalized)) {
		return "off";
	}
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) && parsed > 0 ? `tokens:${parsed}` : "off";
}

export function parsePreferences(
	values: ReadonlyMap<string, string | null>
): MemoryPreferences {
	const topKRaw = values.get(KEYS.topK);
	const topKParsed =
		topKRaw && /^\+?\d+$/.test(topKRaw.trim())
			? Number.parseInt(topKRaw.trim(), 10)
			: Number.NaN;
	const reserveRaw = values.get(KEYS.contextReserve);
	const reserveParsed =
		reserveRaw && /^\+?\d+$/.test(reserveRaw.trim())
			? Number.parseInt(reserveRaw.trim(), 10)
			: Number.NaN;
	const rankerRaw = values.get(KEYS.ranker)?.trim().toLowerCase();
	return {
		autoRecall: parseAutoRecall(values.get(KEYS.autoRecall) ?? null),
		topK:
			Number.isFinite(topKParsed) && topKParsed > 0
				? topKParsed
				: DEFAULTS.topK,
		contextBudget: parseContextBudget(values.get(KEYS.contextBudget) ?? null),
		contextReserve:
			Number.isFinite(reserveParsed) && reserveParsed >= 0
				? reserveParsed
				: DEFAULTS.contextReserve,
		autoCompact: parseBoolean(values.get(KEYS.autoCompact) ?? null, false),
		skills:
			(values.get(KEYS.skills) ?? "progressive").trim().toLowerCase() !==
			"full",
		ranker:
			rankerRaw === "bm25" || rankerRaw === "semantic" ? rankerRaw : "needle2",
	};
}

export function contextBudgetValue(budget: ContextBudget): string {
	if (budget === "off" || budget === "auto") {
		return budget;
	}
	const tokens = Number.parseInt(budget.slice("tokens:".length), 10);
	return String(Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, tokens)));
}

export function displayBudget(budget: ContextBudget): string {
	if (budget === "off" || budget === "auto") {
		return budget === "off" ? "Off" : "Auto";
	}
	return `${Number.parseInt(budget.slice("tokens:".length), 10).toLocaleString()} tokens`;
}

export function parseWholeNumber(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\+?\d+$/.test(trimmed)) {
		return null;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

export function wireValue(
	preferences: MemoryPreferences,
	field: RowId
): string {
	switch (field) {
		case "autoRecall":
			return String(preferences.autoRecall);
		case "topK":
			return String(preferences.topK);
		case "contextBudget":
			return contextBudgetValue(preferences.contextBudget);
		case "contextReserve":
			return String(preferences.contextReserve);
		case "autoCompact":
			return String(preferences.autoCompact);
		case "skills":
			return preferences.skills ? "progressive" : "full";
		case "ranker":
			return preferences.ranker;
	}
}
