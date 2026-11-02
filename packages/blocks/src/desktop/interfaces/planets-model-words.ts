import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	byRecency,
	byUrgency,
	type Planet,
	type PlanetKind,
} from "./planets-model.ts";
import type { Box } from "./planets-model-hud.ts";

/** Overlap area of two boxes, in square pixels. */
export function overlapArea(a: Box, b: Box): number {
	const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	return width > 0 && height > 0 ? width * height : 0;
}

export interface ThreadSection {
	status: ThreadStatus;
	threads: InterfaceThread[];
}

/** Threads grouped by status, in the status order, most recent first. */
export function sectionThreads(
	threads: readonly InterfaceThread[]
): ThreadSection[] {
	return THREAD_STATUS_ORDER.map((status) => ({
		status,
		threads: threads
			.filter((thread) => threadStatus(thread) === status)
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b)),
	})).filter((section) => section.threads.length > 0);
}

/** Threads where the next move is yours, across the whole system. */
export function threadsWaitingOnYou(
	snapshot: InterfaceSnapshot
): InterfaceThread[] {
	return snapshot.threads
		.filter((thread) => {
			const status = threadStatus(thread);
			return status === "attention" || status === "your-turn";
		})
		.sort(byUrgency);
}

/** One sentence describing a planet, for its accessible name. */
export function planetDescription(planet: Planet): string {
	const parts = [
		planet.name,
		tr("{count, plural, one {# thread} other {# threads}}", {
			count: planet.threadCount,
		}),
	];
	if (planet.working) {
		parts.push(tr("working"));
	}
	const needsYou = planet.counts.attention + planet.counts["your-turn"];
	if (needsYou > 0) {
		parts.push(tr("{count} waiting on you", { count: needsYou }));
	}
	return parts.join(", ");
}

/** A planet kind's name in the UI language. */
export function planetKindLabel(kind: PlanetKind): string {
	switch (kind) {
		case "gas":
			return tr("Gas giant");
		case "ice":
			return tr("Ice world");
		case "ocean":
			return tr("Ocean world");
		case "ringed":
			return tr("Ringed giant");
		default:
			return tr("Rocky world");
	}
}
