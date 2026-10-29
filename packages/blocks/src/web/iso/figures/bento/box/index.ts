import type { BentoDrawings } from "../card.ts";
import { drawing as filesAndPreviews } from "./files-and-previews.tsx";
import { drawing as lifecycleApi } from "./lifecycle-api.tsx";
import { drawing as linuxSizes } from "./linux-sizes.tsx";
import { drawing as secretsPerBox } from "./secrets-per-box.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Lifecycle API": lifecycleApi,
	"Files and previews": filesAndPreviews,
	"Linux sizes": linuxSizes,
	"Secrets per Box": secretsPerBox,
};
