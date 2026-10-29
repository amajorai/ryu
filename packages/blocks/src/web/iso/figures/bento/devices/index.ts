import type { BentoDrawings } from "../card.ts";
import { drawing as eInkDeskDisplay } from "./e-ink-desk-display.tsx";
import { drawing as roundScreenWatch } from "./round-screen-watch.tsx";
import { drawing as screenlessNecklace } from "./screenless-necklace.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Round-screen watch": roundScreenWatch,
	"Screenless necklace": screenlessNecklace,
	"E-ink desk display": eInkDeskDisplay,
};
