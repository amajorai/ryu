import {
	activeLocale,
	numberFormatter,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { relativeAge } from "./interface-renderer.ts";
import type { Town, TownBuilding } from "./town-model.ts";

/** When a scheduled run happens ("in 45m") or happened ("2h ago"). */
export function eventWhen(event: InterfaceEvent, now: number): string {
	const start = Date.parse(event.start);
	if (Number.isNaN(start)) {
		return "";
	}
	if (event.kind === "upcoming") {
		const until = relativeTimeFormatter(activeLocale(), "narrow", "always");
		const minutes = Math.max(0, Math.round((start - now) / 60_000));
		if (minutes < 60) {
			return until.format(minutes, "minute");
		}
		const hours = Math.round(minutes / 60);
		return hours < 48
			? until.format(hours, "hour")
			: until.format(Math.round(hours / 24), "day");
	}
	return relativeAge(event.start, now);
}

/** The next scheduled runs across the town, soonest first. */
export function upcomingRuns(
	events: InterfaceEvent[] | undefined,
	limit = 4
): InterfaceEvent[] {
	return (events ?? [])
		.filter((event) => event.kind === "upcoming")
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

/** A building kind's name in the UI language, lower-cased in a sentence. */
export function buildingWord(kind: TownBuilding["kind"]): string {
	switch (kind) {
		case "cottage":
			return tr("cottage");
		case "shop":
			return tr("shop");
		default:
			return tr("office tower");
	}
}

/** A building kind's name in the UI language ("Office tower"). */
export function buildingName(kind: TownBuilding["kind"]): string {
	switch (kind) {
		case "cottage":
			return tr("Cottage");
		case "shop":
			return tr("Shop");
		default:
			return tr("Office tower");
	}
}

/** What a building is, in words, for its accessible name. */
export function buildingLabel(
	building: TownBuilding,
	districtName: string
): string {
	const parts = [
		tr("{name}'s {building}", {
			building: buildingWord(building.kind),
			name: building.agent.name,
		}),
		districtName,
		tr("{count, plural, one {# conversation} other {# conversations}}", {
			count: building.threads.length,
		}),
	];
	if (building.working) {
		parts.push(tr("under construction"));
	}
	if (building.alert) {
		parts.push(
			tr("{count, plural, one {# failed run} other {# failed runs}}", {
				count: building.counts.attention,
			})
		);
	}
	if (building.replied) {
		parts.push(
			tr("{count} waiting on you", { count: building.counts["your-turn"] })
		);
	}
	return parts.join(", ");
}

/** Spoken age for screen readers ("5 minutes ago"), in the UI locale. */
export function spokenAge(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const minutes = Math.max(0, Math.round((now - then) / 60_000));
	if (minutes < 1) {
		return tr("just now");
	}
	const ago = relativeTimeFormatter(activeLocale(), "long", "always");
	if (minutes < 60) {
		return ago.format(-minutes, "minute");
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return ago.format(-hours, "hour");
	}
	return ago.format(-Math.round(hours / 24), "day");
}

/** Funds from the usage account, when the host has one. */
export function formatFunds(snapshot: InterfaceSnapshot): string | null {
	const balance = snapshot.account?.balance;
	if (balance === null || balance === undefined) {
		return null;
	}
	try {
		return numberFormatter(activeLocale(), {
			currency: snapshot.account?.currency.toUpperCase() ?? "USD",
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
			style: "currency",
		}).format(balance / 1_000_000);
	} catch {
		return (balance / 1_000_000).toFixed(2);
	}
}

/** Grass between the ring road and the edge of the island. */
export const ISLAND_MARGIN = 2.2;

/**
 * What the camera frames at first. On a roomy stage, the whole island
 * (grass beyond the ring road included), so the diorama sits inside the
 * stage with a margin. On a phone-width stage, only City Hall and the
 * district blocks, so they stay legible and the parks bleed off the sides.
 */
export function townFrame(
	town: Town,
	extent: "districts" | "island" = "island"
): {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
} {
	if (extent === "island") {
		const half = town.grid.reach + ISLAND_MARGIN;
		return { maxX: half, maxZ: half, minX: -half, minZ: -half };
	}
	const { pitch } = town.grid;
	let minCol = 0;
	let maxCol = 0;
	let minRow = 0;
	let maxRow = 0;
	for (const district of town.districts) {
		minCol = Math.min(minCol, district.cell.col);
		maxCol = Math.max(maxCol, district.cell.col);
		minRow = Math.min(minRow, district.cell.row);
		maxRow = Math.max(maxRow, district.cell.row);
	}
	const edge = pitch / 2;
	return {
		maxX: maxCol * pitch + edge,
		maxZ: maxRow * pitch + edge,
		minX: minCol * pitch - edge,
		minZ: minRow * pitch - edge,
	};
}

/** "Old Town: 3 buildings, 7 conversations", announced when a district is shown. */
export function districtSummary(district: {
	buildings: readonly unknown[];
	name: string;
	threads: readonly unknown[];
}): string {
	return tr(
		"{name}: {buildings, plural, one {# building} other {# buildings}}, {threads, plural, one {# conversation} other {# conversations}}",
		{
			buildings: district.buildings.length,
			name: district.name,
			threads: district.threads.length,
		}
	);
}
