// Shared reading helpers of the phase-1b detail deriver (`interface-detail.ts`):
// loose message parts, bounded text and the shared length caps.

import type { MissionStreamPart } from "@/src/lib/mission-control/turn-groups.ts";
import type { DetailMessage } from "./interface-detail-types.ts";

/** Core's question and permission waiters give up after 600 s. */
export const QUESTION_WAIT_MS = 600_000;
export const LABEL_MAX = 40;
export const TITLE_MAX = 40;
export const DETAIL_MAX = 160;
export const TEXT_MAX = 80;
export const RECENT_STEPS = 5;
export const MAX_CHOICES = 4;

export type LoosePart = MissionStreamPart & {
	data?: unknown;
	errorText?: unknown;
	id?: string;
	code?: unknown;
	message?: unknown;
	title?: unknown;
};

export function partsOf(message: DetailMessage | undefined): LoosePart[] {
	return (message?.parts ?? []).filter(
		(part): part is LoosePart => typeof part === "object" && part !== null
	);
}

export function lastWhere<T>(
	list: readonly T[],
	test: (item: T) => boolean
): T | undefined {
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const item = list[i];
		if (item !== undefined && test(item)) {
			return item;
		}
	}
	return undefined;
}

export function isTool(part: LoosePart): boolean {
	return (
		typeof part.type === "string" &&
		(part.type.startsWith("tool-") || part.type === "dynamic-tool")
	);
}

export function clamp(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function stringIn(source: unknown, key: string): string | null {
	if (!source || typeof source !== "object") {
		return null;
	}
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A tool's display name: the last segment of a namespaced id, spaced. */
export function toolDisplayName(tool: string): string {
	const tail = tool.split(/__|\./).filter(Boolean).at(-1) ?? tool;
	return tail.replace(/_/g, " ");
}
