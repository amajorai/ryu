import {
	activeLocale,
	formatRelativeTime,
	translate as tr,
} from "@ryu/i18n/lite";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { fullTimestamp } from "./interface-renderer.ts";

// ---------------------------------------------------------------------------
// Time and identity helpers
// ---------------------------------------------------------------------------

/** "1 minute ago", "3 days ago" in the UI locale; null under a minute. */
function relativeJobAge(iso: string, now: number): string | null {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	if (now - then < 60_000) {
		return null;
	}
	return formatRelativeTime(activeLocale(), then, { now, numeric: "always" });
}

/** LinkedIn-style age: "Just now", "1 minute ago", "3 days ago". */
export function jobAge(iso: string, now: number): string {
	return relativeJobAge(iso, now) ?? tr("Just now");
}

/** `jobAge` inside a sentence: "just now", "1 minute ago". */
export function jobAgePhrase(iso: string, now: number): string {
	return relativeJobAge(iso, now) ?? tr("just now");
}

export function jobFullTime(iso: string): string {
	return fullTimestamp(iso);
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
