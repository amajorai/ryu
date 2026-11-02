import type { LiteralMessage } from "@ryu/i18n/react";
import {
	cropTitle,
	type FarmCrop,
	type FarmPlot,
	FRUIT_NAMES,
	STAGE_WORDS,
} from "./farm-model.ts";

/** The accessible name of a plant: what it is, whose it is, where it stands. */
export function cropLabel(
	crop: FarmCrop,
	plotName: string,
	tl: LiteralMessage
): string {
	const values = {
		fruit: FRUIT_NAMES[crop.fruit],
		plotName,
		stage: STAGE_WORDS[crop.stage],
		title: cropTitle(crop.thread),
	};
	return crop.stage === "ripe"
		? tl("Harvest {title}: {fruit} in {plotName}'s plot, {stage}", values)
		: tl("Inspect {title}: {fruit} in {plotName}'s plot, {stage}", values);
}

/** A plot's accessible name: whose it is, its team, and how much grows. */
export function plotLabel(
	plot: Pick<FarmPlot, "crops" | "name" | "teams">,
	tl: LiteralMessage
) {
	const team = plot.teams[0];
	const values = {
		cropCount: plot.crops.length,
		count: String(plot.crops.length),
		name: plot.name,
		team,
	};
	return team
		? tl(
				"{name}'s plot, {team}: {cropCount, plural, one {{count} crop} other {{count} crops}}",
				values
			)
		: tl(
				"{name}'s plot: {cropCount, plural, one {{count} crop} other {{count} crops}}",
				values
			);
}
