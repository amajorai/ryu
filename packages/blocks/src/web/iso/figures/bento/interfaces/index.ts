import type { BentoDrawings } from "../card.ts";
import { drawing as answerInPlace } from "./answer-in-place.tsx";
import { drawing as hideWorkDetails } from "./hide-work-details.tsx";
import { drawing as remixOrBuildYourOwn } from "./remix-or-build-your-own.tsx";
import { drawing as switchAnyTime } from "./switch-any-time.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Answer in place": answerInPlace,
	"Hide work details": hideWorkDetails,
	"Remix or build your own": remixOrBuildYourOwn,
	"Switch any time": switchAnyTime,
};
