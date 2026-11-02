import { translate as tr } from "@ryu/i18n/lite";
import type { CropStage, FruitKind } from "./farm-model.ts";

/**
 * The Farm's names for fruit and growth stages. Each reads in the UI
 * language when it is shown, so copy that interpolates one stays in a
 * single language.
 */
export const FRUIT_NAMES: Record<FruitKind, string> = {
	get apple() {
		return tr("Apple tree");
	},
	get blueberry() {
		return tr("Blueberries");
	},
	get grapes() {
		return tr("Grapes");
	},
	get pumpkin() {
		return tr("Pumpkin");
	},
	get strawberry() {
		return tr("Strawberries");
	},
	get tomato() {
		return tr("Tomatoes");
	},
};

export const STAGE_NAMES: Record<CropStage, string> = {
	get fallow() {
		return tr("Fallow");
	},
	get growing() {
		return tr("Growing");
	},
	get ripe() {
		return tr("Ripe");
	},
	get seed() {
		return tr("Seeded");
	},
	get withered() {
		return tr("Withered");
	},
};

/** A stage as a word inside a sentence ("…in Ada's plot, ripe"). */
export const STAGE_WORDS: Record<CropStage, string> = {
	get fallow() {
		return tr("fallow");
	},
	get growing() {
		return tr("growing");
	},
	get ripe() {
		return tr("ripe");
	},
	get seed() {
		return tr("seeded");
	},
	get withered() {
		return tr("withered");
	},
};

/** What the stage asks of the user, in the farm's own words. */
export const STAGE_HINTS: Record<CropStage, string> = {
	get fallow() {
		return tr("Nothing said yet");
	},
	get growing() {
		return tr("Agent is working");
	},
	get ripe() {
		return tr("Ready to harvest");
	},
	get seed() {
		return tr("Watered, waiting on the agent");
	},
	get withered() {
		return tr("The run failed");
	},
};

/** A fruit's name in the UI language, for copy that interpolates it. */
export function fruitName(fruit: FruitKind): string {
	return FRUIT_NAMES[fruit];
}

/** A growth stage's name in the UI language, for copy that interpolates it. */
export function stageName(stage: CropStage): string {
	return STAGE_NAMES[stage];
}
