import type { BentoDrawings } from "../card.ts";
import { drawing as harmfulOutput } from "./harmful-output.tsx";
import { drawing as injectionAndLeaks } from "./injection-and-leaks.tsx";
import { drawing as toolAbuse } from "./tool-abuse.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Injection and leaks": injectionAndLeaks,
	"Tool abuse": toolAbuse,
	"Harmful output": harmfulOutput,
};
