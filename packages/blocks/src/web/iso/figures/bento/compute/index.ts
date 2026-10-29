import type { BentoDrawings } from "../card.ts";
import { drawing as outputToYou } from "./output-to-you.tsx";
import { drawing as privateHost } from "./private-host.tsx";
import { drawing as shortLeases } from "./short-leases.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Short leases": shortLeases,
	"Private host": privateHost,
	"Output to you": outputToYou,
};
