import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import type { Machine, Reel, WallCabinet } from "./arcade-model.ts";

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Credits on the LED meter: four digits, zero padded, the way meters read. */
export function meterDigits(value: number, width = 4): string {
	const whole = Math.max(0, Math.floor(value));
	return String(whole).padStart(width, "0");
}

export function reelLabel(reel: Reel): string {
	if (!(reel.thread && reel.status)) {
		return "Empty reel";
	}
	const title = reel.thread.title.trim() || "Untitled conversation";
	return `${title}: ${THREAD_STATUS_LABELS[reel.status]}`;
}

/** One sentence for screen readers that sums up a machine. */
export function machineSummary(machine: Machine): string {
	const parts = [
		`${machine.name}`,
		machine.running ? "running" : "idle",
		plural(machine.credits, "credit"),
	];
	if (machine.jackpots.length > 0) {
		parts.push(`${plural(machine.jackpots.length, "reply")} waiting on you`);
	}
	if (machine.tilt) {
		parts.push("a run needs attention");
	}
	return parts.join(", ");
}

export interface ScoreRow {
	key: "jackpots" | "machines" | "running";
	label: string;
	value: number;
}

/** The high-score table a wall cabinet shows in attract mode. */
export function scoreRows(cabinet: WallCabinet): ScoreRow[] {
	return [
		{ key: "machines", label: "MACHINES", value: cabinet.machines },
		{ key: "jackpots", label: "JACKPOTS", value: cabinet.jackpots },
		{ key: "running", label: "RUNNING", value: cabinet.running },
	];
}

/** Screen-reader name for a wall cabinet button. */
export function wallCabinetLabel(
	cabinet: WallCabinet,
	active: boolean,
	/** With the act layer the jackpot count (legacy statuses) is left out. */
	acted = false
): string {
	const kind = cabinet.group.kind === "team" ? "team" : "project";
	const counts = [
		plural(cabinet.machines, "machine"),
		acted ? null : `${cabinet.jackpots} waiting on you`,
		`${cabinet.running} running`,
	]
		.filter(Boolean)
		.join(", ");
	return active
		? `Show every machine (now showing ${kind} ${cabinet.group.name}: ${counts})`
		: `Show ${kind} ${cabinet.group.name}: ${counts}`;
}
