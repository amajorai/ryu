/**
 * Warehouse art: the concrete, racking, cardboard, conveyor, cage, dock and
 * truck colours of the warehouse diorama. This is the one Warehouse file
 * where literal colours live; the clipboard and the HUD take the theme's
 * semantic tokens instead.
 *
 * The diorama sits on the game kit's shared scene palette
 * (`game3d-palette.ts`): `WAREHOUSE_3D` is the day shift and
 * `WAREHOUSE_3D_NIGHT` the night shift, its work lights lit.
 */

export interface WarehouseArt {
	belt: string;
	beltFrame: string;
	bin: string;
	box: string;
	boxDamaged: string;
	cab: string;
	cage: string;
	dockEdge: string;
	door: string;
	exception: string;
	floor: string;
	floorEdge: string;
	label: string;
	lamp: string;
	lampShade: string;
	pallet: string;
	rackBeam: string;
	rackDeck: string;
	rackUpright: string;
	safety: string;
	safetyDark: string;
	station: string;
	stationTop: string;
	tape: string;
	trailer: string;
	trailerStripe: string;
	wallLower: string;
	wallUpper: string;
	wheel: string;
	window: string;
	yard: string;
}

export const WAREHOUSE_3D: WarehouseArt = {
	belt: "#4a4f57",
	beltFrame: "#9aa3ad",
	bin: "#5b8ec9",
	box: "#d4a46a",
	boxDamaged: "#a9784a",
	cab: "#f06a4a",
	cage: "#8d96a0",
	dockEdge: "#f2c230",
	door: "#c3cad2",
	exception: "#e2574c",
	floor: "#e9e5dc",
	floorEdge: "#b9b2a6",
	label: "#fbfbf8",
	lamp: "#fff3c4",
	lampShade: "#5b616e",
	pallet: "#c8a679",
	rackBeam: "#f08a3a",
	rackDeck: "#d9c49e",
	rackUpright: "#3f78c0",
	safety: "#f2c230",
	safetyDark: "#2b2e33",
	station: "#9fb0c2",
	stationTop: "#eef1f4",
	tape: "#efd6a8",
	trailer: "#f4f5f6",
	trailerStripe: "#3f78c0",
	wallLower: "#9fb7cc",
	wallUpper: "#eef0f2",
	wheel: "#2b2e33",
	window: "#a9d6ef",
	yard: "#a9a6a8",
};

export const WAREHOUSE_3D_NIGHT: WarehouseArt = {
	belt: "#30343b",
	beltFrame: "#59616c",
	bin: "#3f6896",
	box: "#a57f4f",
	boxDamaged: "#7f5a38",
	cab: "#b8503a",
	cage: "#5d6670",
	dockEdge: "#c9a326",
	door: "#6c7480",
	exception: "#ff6b6b",
	floor: "#7d7a80",
	floorEdge: "#55525a",
	label: "#d8d8d2",
	lamp: "#ffe7a3",
	lampShade: "#3a3e48",
	pallet: "#8a7354",
	rackBeam: "#b86a2a",
	rackDeck: "#9a8a6c",
	rackUpright: "#3a5d8a",
	safety: "#c9a326",
	safetyDark: "#1d1f23",
	station: "#5d6b7a",
	stationTop: "#a7adb5",
	tape: "#b89f76",
	trailer: "#c9ced4",
	trailerStripe: "#3a5d8a",
	wallLower: "#55667a",
	wallUpper: "#9a9ca2",
	wheel: "#16181b",
	window: "#26345a",
	yard: "#5a5862",
};

export function warehouseArt(night: boolean): WarehouseArt {
	return night ? WAREHOUSE_3D_NIGHT : WAREHOUSE_3D;
}

/**
 * The clipboard's hardboard, clip and order sheet, as custom properties on
 * the scene root (light and dark themes), leaning a little toward the
 * theme's background so the clipboard sits in it. The sheet stays a dim
 * paper under a dark theme, so the theme's own ink still reads on it.
 */
const CLIPBOARD_DAY = {
	"--wh-box": "color-mix(in oklab, #c9a06b 86%, var(--background))",
	"--wh-cab": "color-mix(in oklab, #e9ecef 86%, var(--background))",
	"--wh-cab-r": "color-mix(in oklab, #a8b0ba 86%, var(--background))",
	"--wh-margin": "color-mix(in oklab, #e2574c 32%, transparent)",
	"--wh-paper": "color-mix(in oklab, #fff8e8 82%, var(--background))",
	"--wh-rule": "color-mix(in oklab, #7aa3d6 26%, transparent)",
};
const CLIPBOARD_NIGHT = {
	"--wh-box": "color-mix(in oklab, #a57f4f 78%, var(--background))",
	"--wh-cab": "color-mix(in oklab, #b8bec6 78%, var(--background))",
	"--wh-cab-r": "color-mix(in oklab, #767e88 78%, var(--background))",
	"--wh-margin": "color-mix(in oklab, #ff6b6b 24%, transparent)",
	"--wh-paper": "color-mix(in oklab, #3a3428 30%, var(--background))",
	"--wh-rule": "color-mix(in oklab, #7aa3d6 18%, transparent)",
};

function declarations(values: Record<string, string>): string {
	return Object.entries(values)
		.map(([name, value]) => `${name}:${value};`)
		.join("");
}

export const WAREHOUSE_SCENE_CSS = `[data-warehouse-scene]{${declarations(CLIPBOARD_DAY)}}.dark [data-warehouse-scene],[data-warehouse-scene].dark{${declarations(CLIPBOARD_NIGHT)}}`;

/** The clipboard's order sheet: ruled paper with a red margin line. */
export const PAPER_SHEET = {
	backgroundColor: "var(--wh-paper)",
	backgroundImage: [
		"linear-gradient(90deg, transparent 10px, var(--wh-margin) 10px, var(--wh-margin) 12px, transparent 12px)",
		"repeating-linear-gradient(180deg, transparent 0 27px, var(--wh-rule) 27px 28px)",
	].join(", "),
} as const;

/** The act layer's Warehouse props: the dispatch desk, parcels and pick crates. */
export const WAREHOUSE_ACT_ART = {
	desk: "#7d8a96",
	deskTop: "#c9b48e",
	forklift: "#e2a52b",
	forkliftMast: "#4b4f55",
	/** The pallet boards a queue notice stands on. */
	pallet: "#a8875c",
	parcel: "#c99a5b",
	parcelTape: "#e9d8a6",
	pipDone: "#d88a3a",
	pipEstimate: "#f0c48a",
	pipTodo: "#d9d4ca",
	/** The clipboard frame round each wait timer at the dispatch desk. */
	timer: "#8a6a45",
} as const;
