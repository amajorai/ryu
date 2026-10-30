import { gameTitleHeight } from "./game-hud.tsx";

/**
 * How much room the HUD has, measured on the stage (not the viewport) less
 * what an open sheet covers, so the HUD and the scene's insets always switch
 * together. Wide HUDs hang the rail between the title and New order;
 * narrower ones give it its own row.
 */
export type HudDensity = "medium" | "narrow" | "wide";

export function hudDensity(hudWidth: number): HudDensity {
	if (hudWidth < 640) {
		return "narrow";
	}
	return hudWidth < 1100 ? "medium" : "wide";
}

/** Ticket heights; the rail's height follows. */
export const TICKET_HEIGHT = { medium: 132, narrow: 124, wide: 132 } as const;

/**
 * Room the HUD covers at the top and bottom, so the scene camera can frame
 * the line between them. The wall behind the rail may sit under it.
 */
export function hudInsets(
	density: HudDensity,
	withActStatus = false
): {
	bottom: number;
	top: number;
} {
	const rail = TICKET_HEIGHT[density] + 26;
	if (density === "wide") {
		return { bottom: 92, top: rail + 20 };
	}
	if (density === "narrow") {
		// The narrow title plate wraps the act summary to two lines.
		return {
			bottom: 70,
			top: 10 + gameTitleHeight(withActStatus ? 2 : 1) + 10 + rail + 8,
		};
	}
	return { bottom: 92, top: 16 + 64 + 12 + rail + 8 };
}

/** The served ticket, its chef plate and its dish all wear this. */
export const SELECTED =
	"outline-3 outline-(--gk-accent) outline-offset-2 outline-solid";
