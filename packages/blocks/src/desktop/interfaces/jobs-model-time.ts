import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Time and identity helpers
// ---------------------------------------------------------------------------

const AGE_STEPS: [number, string][] = [
	[60, "minute"],
	[24, "hour"],
	[7, "day"],
	[4.345, "week"],
	[12, "month"],
	[Number.POSITIVE_INFINITY, "year"],
];

/** LinkedIn-style age: "Just now", "1 minute ago", "3 days ago". */
export function jobAge(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	let value = Math.max(0, (now - then) / 60_000);
	if (value < 1) {
		return "Just now";
	}
	for (const [size, unit] of AGE_STEPS) {
		if (value < size) {
			const whole = Math.floor(value);
			return `${whole} ${unit}${whole === 1 ? "" : "s"} ago`;
		}
		value /= size;
	}
	return "";
}

const FULL_TIME = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeStyle: "short",
});

export function jobFullTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : FULL_TIME.format(time);
}

export function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Number of logo tints (see `jobs-parts.tsx`). */
export const COMPANY_TONE_COUNT = 5;

/** Stable tint index for a company id, so a logo keeps its color. */
export function companyTone(id: string): number {
	let hash = 0;
	for (const char of id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
	}
	return hash % COMPANY_TONE_COUNT;
}

/** One letter for a company's logo tile. */
export function companyInitial(name: string): string {
	return name.trim().charAt(0).toUpperCase() || "?";
}

/** What "Post a job" sends for a freelancer and company pick. */
export function jobStartInput(input: {
	agentId: string | undefined;
	companyId: string;
	prompt: string;
	snapshot: InterfaceSnapshot;
}): { agentId?: string; projectId?: string; prompt: string; teamId?: string } {
	const group = input.snapshot.groups.find(
		(candidate) => candidate.id === input.companyId
	);
	return {
		prompt: input.prompt,
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(group?.kind === "project" ? { projectId: group.id } : {}),
		...(group?.kind === "team" ? { teamId: group.id } : {}),
	};
}

export type CursorStep = "first" | "last" | "next" | "previous";

export function cursorStep(key: string): CursorStep | null {
	switch (key) {
		case "ArrowDown":
		case "j":
			return "next";
		case "ArrowUp":
		case "k":
			return "previous";
		case "Home":
			return "first";
		case "End":
			return "last";
		default:
			return null;
	}
}

export function stepIndex(
	step: CursorStep,
	index: number,
	length: number
): number {
	switch (step) {
		case "first":
			return 0;
		case "last":
			return length - 1;
		case "next":
			return Math.min(index + 1, length - 1);
		default:
			return Math.max(index - 1, 0);
	}
}
