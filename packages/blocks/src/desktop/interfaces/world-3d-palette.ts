/**
 * World 3D's act-layer colours: the lantern over a door (lit gold while
 * its agent asks, red when a run stopped), the grey flag of an interrupted
 * run, the porch clock of a limit and the answer basket. The one World 3D
 * file where these literal colours live.
 */
export const WORLD_3D_ACT = {
	basket: "#b7793f",
	basketRim: "#8a5528",
	clockFace: "#fff4dc",
	clockRim: "#e0a030",
	flag: "#9aa0a8",
	flagPole: "#5b5e66",
	lanternAsk: "#ffd257",
	lanternDim: "#8a6a2a",
	lanternFrame: "#3a2e24",
	/** A failed routine's lantern (the kit's calendar tone). */
	lanternCalendar: "#c2410c",
	lanternStop: "#ff3b2f",
} as const;
