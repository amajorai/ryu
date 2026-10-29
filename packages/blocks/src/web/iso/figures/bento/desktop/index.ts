import type { BentoDrawings } from "../card.ts";
import { drawing as appsAndSandbox } from "./apps-and-sandbox.tsx";
import { drawing as bringYourHistory } from "./bring-your-history.tsx";
import { drawing as yourModelsYourKeys } from "./your-models-your-keys.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Your models, your keys": yourModelsYourKeys,
	"Bring your history": bringYourHistory,
	"Apps and sandbox": appsAndSandbox,
};
