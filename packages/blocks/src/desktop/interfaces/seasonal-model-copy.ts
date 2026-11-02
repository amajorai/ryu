import { translate as tr } from "@ryu/i18n/lite";
import type { Season } from "./seasonal-model.ts";

export interface SeasonCopy {
	/** Header button and composer heading for starting a conversation. */
	readonly add: string;
	/** "All doors": the overflow sheet's heading. */
	readonly all: string;
	/** Name of the board in the header. */
	readonly board: string;
	/** "Close all doors". */
	readonly closeAll: string;
	/** "3 doors": a count of the season's doors. */
	count: (count: number) => string;
	/** Singular and plural nouns for one door, for prose that needs the bare word. */
	readonly door: string;
	readonly doors: string;
	/** The empty board's hint: how conversations take numbered doors. */
	readonly emptyHint: string;
	/** Picker label. */
	readonly label: string;
	/** Overflow list button and heading. */
	readonly more: string;
	/** "Door 12": one door by its number. */
	numbered: (number: number) => string;
	/** "Conversations past the 24th door, most urgent first." */
	readonly overflow: string;
}

/** The season's words in the UI language (getters, so they follow the locale). */
export const SEASON_COPY: Record<Season, SeasonCopy> = {
	advent: {
		get add() {
			return tr("Add a door");
		},
		get all() {
			return tr("All doors");
		},
		get board() {
			return tr("Advent calendar");
		},
		get closeAll() {
			return tr("Close all doors");
		},
		count: (count) =>
			tr("{count, plural, one {# door} other {# doors}}", { count }),
		get door() {
			return tr("door");
		},
		get doors() {
			return tr("doors");
		},
		get label() {
			return tr("Advent");
		},
		get more() {
			return tr("More gifts");
		},
		get emptyHint() {
			return tr(
				"Each conversation gets a numbered door. The ones that need you take the lowest numbers."
			);
		},
		numbered: (number) => tr("Door {number}", { number }),
		get overflow() {
			return tr("Conversations past the 24th door, most urgent first.");
		},
	},
	halloween: {
		get add() {
			return tr("Add a pumpkin");
		},
		get all() {
			return tr("All pumpkins");
		},
		get board() {
			return tr("Pumpkin patch");
		},
		get closeAll() {
			return tr("Close all pumpkins");
		},
		count: (count) =>
			tr("{count, plural, one {# pumpkin} other {# pumpkins}}", { count }),
		get door() {
			return tr("pumpkin");
		},
		get doors() {
			return tr("pumpkins");
		},
		get label() {
			return tr("Halloween");
		},
		get more() {
			return tr("More pumpkins");
		},
		get emptyHint() {
			return tr(
				"Each conversation gets a numbered pumpkin. The ones that need you take the lowest numbers."
			);
		},
		numbered: (number) => tr("Pumpkin {number}", { number }),
		get overflow() {
			return tr("Conversations past the 24th pumpkin, most urgent first.");
		},
	},
	"lunar-new-year": {
		get add() {
			return tr("Add a lantern");
		},
		get all() {
			return tr("All lanterns");
		},
		get board() {
			return tr("Lantern festival");
		},
		get closeAll() {
			return tr("Close all lanterns");
		},
		count: (count) =>
			tr("{count, plural, one {# lantern} other {# lanterns}}", { count }),
		get door() {
			return tr("lantern");
		},
		get doors() {
			return tr("lanterns");
		},
		get label() {
			return tr("Lunar New Year");
		},
		get more() {
			return tr("More lanterns");
		},
		get emptyHint() {
			return tr(
				"Each conversation gets a numbered lantern. The ones that need you take the lowest numbers."
			);
		},
		numbered: (number) => tr("Lantern {number}", { number }),
		get overflow() {
			return tr("Conversations past the 24th lantern, most urgent first.");
		},
	},
};
