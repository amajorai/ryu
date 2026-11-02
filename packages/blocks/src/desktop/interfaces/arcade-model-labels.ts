import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { Machine, Reel, WallCabinet } from "./arcade-model.ts";
import { threadStatusLabel } from "./interface-renderer.ts";

/** Credits on the LED meter: four digits, zero padded, the way meters read. */
export function meterDigits(value: number, width = 4): string {
	const whole = Math.max(0, Math.floor(value));
	return String(whole).padStart(width, "0");
}

export function reelLabel(reel: Reel, tl: LiteralMessage = tr): string {
	if (!(reel.thread && reel.status)) {
		return tl("Empty reel");
	}
	const title = reel.thread.title.trim() || tl("Untitled conversation");
	return tl("{title}: {status}", {
		status: threadStatusLabel(reel.status, tl),
		title,
	});
}

/** One sentence for screen readers that sums up a machine. */
export function machineSummary(
	machine: Machine,
	tl: LiteralMessage = tr
): string {
	const parts = [
		tl(
			"{name}, {running, select, yes {running} other {idle}}, {credits, plural, one {# credit} other {# credits}}",
			{
				credits: machine.credits,
				name: machine.name,
				running: machine.running ? "yes" : "no",
			}
		),
	];
	if (machine.jackpots.length > 0) {
		parts.push(
			tl(
				"{count, plural, one {# reply waiting on you} other {# replies waiting on you}}",
				{ count: machine.jackpots.length }
			)
		);
	}
	if (machine.tilt) {
		parts.push(tl("a run needs attention"));
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
	tl: LiteralMessage,
	/** With the act layer the jackpot count (legacy statuses) is left out. */
	acted = false
): string {
	const kind = cabinet.group.kind === "team" ? "team" : "project";
	const name = cabinet.group.name;
	const counts = [
		tl("{count, plural, one {# machine} other {# machines}}", {
			count: cabinet.machines,
		}),
		acted ? null : tl("{count} waiting on you", { count: cabinet.jackpots }),
		tl("{count} running", { count: cabinet.running }),
	]
		.filter(Boolean)
		.join(", ");
	return active
		? tl(
				"Show every machine (now showing {kind, select, team {team} other {project}} {name}: {counts})",
				{ counts, kind, name }
			)
		: tl("Show {kind, select, team {team} other {project}} {name}: {counts}", {
				counts,
				kind,
				name,
			});
}
