import type { BentoDrawings } from "../card.ts";
import { drawing as fifteenKindsOfListings } from "./15-kinds-of-listings.tsx";
import { drawing as preinstalledPlugins } from "./preinstalled-plugins.tsx";
import { drawing as searchEverything } from "./search-everything.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Search everything": searchEverything,
	"Preinstalled plugins": preinstalledPlugins,
	"15 kinds of listings": fifteenKindsOfListings,
};
