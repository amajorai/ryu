import type { BentoDrawings } from "../card.ts";
import { drawing as installedApps } from "./installed-apps.tsx";
import { drawing as missionControl } from "./mission-control.tsx";
import { drawing as sameRyuUnderneath } from "./same-ryu-underneath.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Installed Apps": installedApps,
	"Mission Control": missionControl,
	"Same Ryu underneath": sameRyuUnderneath,
};
