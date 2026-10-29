import type { BentoDrawings } from "../card.ts";
import { drawing as headlessAndScriptable } from "./headless-and-scriptable.tsx";
import { drawing as signInAnywhere } from "./sign-in-anywhere.tsx";
import { drawing as switchServers } from "./switch-servers.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Headless and scriptable": headlessAndScriptable,
	"Switch servers": switchServers,
	"Sign in anywhere": signInAnywhere,
};
