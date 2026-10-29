import type { BentoDrawings } from "../card.ts";
import { drawing as immutableVersions } from "./immutable-versions.tsx";
import { drawing as isolatedPublicPages } from "./isolated-public-pages.tsx";
import { drawing as runItYourself } from "./run-it-yourself.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Immutable versions": immutableVersions,
	"Isolated public pages": isolatedPublicPages,
	"Run it yourself": runItYourself,
};
