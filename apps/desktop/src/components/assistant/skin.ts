/**
 * The Ask Ryu surfaces (launcher eyes, floating window) wear the shared assistant
 * glass from `@ryu/assistant-widget/skin`, the same classes the public-site widget
 * uses, so Desktop and the embeddable widget cannot drift apart. The glass follows
 * the app theme via the class-based `dark:` variant (keyed off the `.dark` class on
 * `<html>`; see globals.css `@custom-variant dark`), so surface content keeps using
 * the active shadcn tokens.
 */
export {
	ASSISTANT_GLASS_CHROME as ISLAND_CHROME,
	ASSISTANT_GLASS_FILL as ISLAND_FILL,
} from "@ryu/assistant-widget/skin";

/** Wrap surface content in this. Content follows the app theme (no forced dark). */
export const ASSISTANT_SURFACE_CONTENT = "flex h-full w-full flex-col";
