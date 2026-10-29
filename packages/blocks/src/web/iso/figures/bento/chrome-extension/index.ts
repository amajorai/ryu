import type { BentoDrawings } from "../card.ts";
import { drawing as addressBarShortcut } from "./address-bar-shortcut.tsx";
import { drawing as newTabHome } from "./new-tab-home.tsx";
import { drawing as savedPrompts } from "./saved-prompts.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"New Tab home": newTabHome,
	"Address bar shortcut": addressBarShortcut,
	"Saved prompts": savedPrompts,
};
