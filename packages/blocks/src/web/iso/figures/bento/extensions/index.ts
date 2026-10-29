import type { BentoDrawings } from "../card.ts";
import { drawing as companionScreens } from "./companion-screens.tsx";
import { drawing as packAndShare } from "./pack-and-share.tsx";
import { drawing as worksWithRyuDesktop } from "./works-with-ryu-desktop.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Works with Ryu Desktop": worksWithRyuDesktop,
	"Pack and share": packAndShare,
	"Companion screens": companionScreens,
};
