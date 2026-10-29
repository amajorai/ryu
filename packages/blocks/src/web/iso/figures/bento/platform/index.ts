import type { BentoDrawings } from "../card.ts";
import { drawing as ryuCloud } from "./ryu-cloud.tsx";
import { drawing as ryuCore } from "./ryu-core.tsx";
import { drawing as ryuGateway } from "./ryu-gateway.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Ryu Core": ryuCore,
	"Ryu Gateway": ryuGateway,
	"Ryu Cloud": ryuCloud,
};
