import type { BentoDrawings } from "../card.ts";
import { drawing as loadsOnDemand } from "./loads-on-demand.tsx";
import { drawing as readyInstantly } from "./ready-instantly.tsx";
import { drawing as sharedSkillsFolder } from "./shared-skills-folder.tsx";
import { drawing as trackEverySource } from "./track-every-source.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Shared skills folder": sharedSkillsFolder,
	"Ready instantly": readyInstantly,
	"Loads on demand": loadsOnDemand,
	"Track every source": trackEverySource,
};
