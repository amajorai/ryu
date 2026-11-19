import { type FarmField, makePlot, OPEN_FIELD_ID } from "./farm-model.ts";

/** Room kept in front of the last queue slot: its farmer and hourglass. */
export const QUEUE_DEPTH = 1.4;

export type Drawer = { kind: "barn" } | { kind: "plot"; plotId: string | null };

export const STAGE_FALLBACK = { height: 808, width: 1200 };

/** Marks catalog copy; the DOM localizer translates it once rendered. */
const tl = (source: string): string => source;

/** An empty farm still has a bed waiting by the barn for the first seed. */
const FIRST_PLOT_ID = "plot-first";
export const FIRST_FIELDS: FarmField[] = [
	{
		fenced: false,
		id: OPEN_FIELD_ID,
		name: tl("Open plots"),
		plots: [{ ...makePlot(FIRST_PLOT_ID, null, []), name: tl("New plot") }],
	},
];

/** The farm's island: the laid-out farm plus a rim for trees and shore. */
export const ISLAND_RIM = 2.6;
