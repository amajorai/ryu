import type { BentoDrawings } from "../card.ts";
import { drawing as adminControls } from "./admin-controls.tsx";
import { drawing as noSetup } from "./no-setup.tsx";
import { drawing as oneThread } from "./one-thread.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"No setup": noSetup,
	"One thread": oneThread,
	"Admin controls": adminControls,
};
