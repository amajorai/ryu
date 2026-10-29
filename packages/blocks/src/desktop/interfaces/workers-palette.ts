/**
 * Workers art: the office's floor, walls, windows, desks, monitors, chairs,
 * plants and coffee corner, and the status lights. This is the one Workers
 * file where literal colours live; the HUD and the sheet take the theme's
 * semantic tokens instead.
 *
 * The diorama sits on the game kit's shared scene palette
 * (`game3d-palette.ts`): `WORKERS_3D` is the office by day, and
 * `WORKERS_3D_NIGHT` the same office after hours, lit by its monitors and
 * desk lamps under a starry sky. The status lights are custom properties
 * scoped to the scene, so the HUD's legend and the sheet follow the theme.
 */

import type { WorkerState } from "./workers-model.ts";

export interface WorkersArt {
	bezel: string;
	books: readonly string[];
	/** A filing cabinet beside each desk (its drawer opens while reading). */
	cabinet: string;
	cabinetDrawer: string;
	chair: string;
	chairBase: string;
	/** The office door at the you-spot, and the wall clock over it. */
	clockFace: string;
	clockHand: string;
	coffee: string;
	counter: string;
	counterTop: string;
	deskLeg: string;
	deskTop: string;
	door: string;
	doorFrame: string;
	floor: readonly [string, string];
	floorEdge: string;
	/** Your inbox tray by the door. */
	inbox: string;
	keyboard: string;
	lampBulb: string;
	lampShade: string;
	machine: string;
	mugs: readonly string[];
	pot: string;
	rug: string;
	rugBorder: string;
	/** Each state's screen glow (the conversation's colour on the monitor). */
	screen: Record<WorkerState, string>;
	shelf: string;
	/** A terminal's screen (a worker running a command) and its text line. */
	terminal: string;
	terminalText: string;
	wallLower: string;
	wallUpper: string;
	water: string;
	whiteboard: string;
	window: string;
	windowFrame: string;
}

export const WORKERS_3D: WorkersArt = {
	bezel: "#2f3440",
	books: ["#e07a5f", "#f2cc8f", "#81b29a", "#6d8fd0", "#b07cc6", "#f4a3a8"],
	cabinet: "#9aa4b2",
	cabinetDrawer: "#b8c1cc",
	chair: "#4a5a78",
	chairBase: "#2c3340",
	clockFace: "#fbf7ee",
	clockHand: "#2f3440",
	coffee: "#6b4430",
	counter: "#c98f5e",
	counterTop: "#f4efe6",
	deskLeg: "#8a6a50",
	deskTop: "#e9cfa6",
	door: "#b9825a",
	doorFrame: "#f6f1e7",
	floor: ["#d9b58c", "#ceaa80"],
	floorEdge: "#a07a56",
	inbox: "#5a6b86",
	keyboard: "#eef0f4",
	lampBulb: "#fff1c4",
	lampShade: "#f2b45a",
	machine: "#3b3f4a",
	mugs: ["#f07f6a", "#5fb3a8", "#f6c453", "#7aa3e0"],
	pot: "#d98a5c",
	rug: "#7fb0c8",
	rugBorder: "#f3ead8",
	screen: {
		attention: "#ff6b6b",
		idle: "#7d8aa6",
		paused: "#4b5160",
		working: "#62e0a0",
		"your-turn": "#ffc24a",
	},
	shelf: "#a8754c",
	terminal: "#1c2a24",
	terminalText: "#62e0a0",
	wallLower: "#9ec4a8",
	wallUpper: "#f6f1e7",
	water: "#8fd3f4",
	whiteboard: "#fbfbf8",
	window: "#9fd4f0",
	windowFrame: "#fffaf2",
};

export const WORKERS_3D_NIGHT: WorkersArt = {
	bezel: "#22262f",
	books: ["#b8604a", "#c7a670", "#668f7b", "#5470a6", "#8a609c", "#c47f84"],
	cabinet: "#5f6774",
	cabinetDrawer: "#767f8c",
	chair: "#38445c",
	chairBase: "#20252f",
	clockFace: "#d8d2c4",
	clockHand: "#20252f",
	coffee: "#4a2f21",
	counter: "#8a6243",
	counterTop: "#cfc8bd",
	deskLeg: "#5f4938",
	deskTop: "#a78f70",
	door: "#7d573c",
	doorFrame: "#a7a3a0",
	floor: ["#8a7158", "#816951"],
	floorEdge: "#5f4936",
	inbox: "#3d4a5e",
	keyboard: "#b8bcc6",
	lampBulb: "#ffd98a",
	lampShade: "#c98d42",
	machine: "#2a2d35",
	mugs: ["#b85e50", "#4a8a82", "#c39a46", "#5a78a8"],
	pot: "#9a6142",
	rug: "#4f7488",
	rugBorder: "#b9b1a2",
	screen: {
		attention: "#ff5a5a",
		idle: "#56607a",
		paused: "#353a45",
		working: "#4cd98e",
		"your-turn": "#ffb733",
	},
	shelf: "#6e4e35",
	terminal: "#121c18",
	terminalText: "#4cd98e",
	wallLower: "#5d6c80",
	wallUpper: "#a7a3a0",
	water: "#5aa6cc",
	whiteboard: "#d8d8d2",
	window: "#26345a",
	windowFrame: "#c9c2b6",
};

/**
 * The office's deliverable: a manila folder (the kit's flat "tablet" item
 * in folder colours), carried to your inbox tray.
 */
export const WORKERS_FOLDER = { accent: "#f3dfa2", color: "#d9a441" } as const;

export function workersArt(night: boolean): WorkersArt {
	return night ? WORKERS_3D_NIGHT : WORKERS_3D;
}

/** A palette entry by index, wrapping. */
export function swatch(list: readonly string[], index: number): string {
	return list[index % list.length] ?? list[0] ?? WORKERS_3D.deskTop;
}

const SCOPE = "[data-workers-scene]";

/**
 * The status lights as custom properties (the HUD's legend and the sheet
 * use them), and their pulse (still under reduced motion).
 */
export const WORKERS_SCENE_CSS = `
${SCOPE} {
--wk-led-attention: #ef4444;
--wk-led-idle: #9aa2ae;
--wk-led-paused: #6b7280;
--wk-led-working: #22c55e;
--wk-led-your-turn: #f59e0b;
--wk-bezel-edge: #16181d;
}
.dark ${SCOPE}, ${SCOPE}.dark {
--wk-led-attention: #ff5a5a;
--wk-led-idle: #6b7280;
--wk-led-paused: #4b5563;
--wk-led-working: #3ee07a;
--wk-led-your-turn: #ffb020;
--wk-bezel-edge: #07080a;
}
@keyframes wk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
${SCOPE} .wk-pulse { animation: wk-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
${SCOPE} .wk-pulse { animation: none; opacity: 1; }
}
`;

/** A palette colour by name, as a CSS value. */
export function wk(name: string): string {
	return `var(--wk-${name})`;
}

/** A palette colour at `percent` strength over transparent. */
export function wkFaded(name: string, percent: number): string {
	return `color-mix(in oklab, ${wk(name)} ${percent}%, transparent)`;
}
