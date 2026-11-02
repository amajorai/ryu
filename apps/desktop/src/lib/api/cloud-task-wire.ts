// apps/desktop/src/lib/api/cloud-task-wire.ts
//
// Strict readers for Core's cloud-task backend responses: a field of the wrong
// shape fails the whole response rather than being guessed at.

export type PlanProvider = "anthropic" | "openai";

export const PLAN_PROVIDERS: readonly PlanProvider[] = ["anthropic", "openai"];

export function invalid(): never {
	throw new Error("Invalid cloud task backend response");
}

export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid();
	}
	// SAFETY: a non-null, non-array object; every field is read as unknown and checked below.
	return value as Record<string, unknown>;
}

export function str(value: unknown): string {
	return typeof value === "string" ? value : invalid();
}

export function optStr(value: unknown): string | null {
	return value === null || value === undefined ? null : str(value);
}

export function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: invalid();
}

export function optNum(value: unknown): number | null {
	return value === null || value === undefined ? null : num(value);
}

export function bool(value: unknown): boolean {
	return typeof value === "boolean" ? value : invalid();
}

export function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[]
): T {
	const found = allowed.find((candidate) => candidate === value);
	return found ?? invalid();
}

/** HTTPS links to the two provider sites only; anything else is dropped. */
const PROVIDER_LINK =
	/^https:\/\/(claude\.ai\/code|chatgpt\.com\/codex)\/[A-Za-z0-9_\-/?=&.]+$/;

export function providerLink(value: unknown): string | null {
	const link = optStr(value);
	return link && PROVIDER_LINK.test(link) ? link : null;
}
