import type { BentoDrawings } from "../card.ts";
import { drawing as localByDefault } from "./local-by-default.tsx";
import { drawing as miniChat } from "./mini-chat.tsx";
import { drawing as outOfTheWay } from "./out-of-the-way.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Local by default": localByDefault,
	"Out of the way": outOfTheWay,
	"Mini chat": miniChat,
};
