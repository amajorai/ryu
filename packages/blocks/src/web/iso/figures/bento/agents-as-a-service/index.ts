import type { BentoDrawings } from "../card.ts";
import { drawing as approvalPoints } from "./approval-points.tsx";
import { drawing as builtOnRyu } from "./built-on-ryu.tsx";
import { drawing as yoursToKeep } from "./yours-to-keep.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Approval points": approvalPoints,
	"Built on Ryu": builtOnRyu,
	"Yours to keep": yoursToKeep,
};
