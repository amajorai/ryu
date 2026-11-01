/**
 * The Ask Ryu surfaces (launcher eyes, floating window) wear the shared assistant
 * glass from `@ryu/assistant-widget/skin`, the same classes the public-site widget
 * uses, so Desktop and the embeddable widget cannot drift apart. The glass follows
 * the app theme via the class-based `dark:` variant (keyed off the `.dark` class on
 * `<html>`; see globals.css `@custom-variant dark`), so surface content keeps using
 * the active shadcn tokens.
 */
import {
	ASSISTANT_GLASS_CHROME,
	ASSISTANT_GLASS_FILL,
} from "@ryu/assistant-widget/skin";

/**
 * Liquid Glass turned off (Settings → Appearance → Liquid Glass marks `<html>`
 * with `data-ryu-liquid-glass="off"`): the surface keeps its token fill but goes
 * solid and drops the backdrop blur. Desktop-only, so the shared public-site
 * widget classes stay untouched.
 */
const LIQUID_GLASS_OFF_FILL = "[html[data-ryu-liquid-glass=off]_&]:bg-popover";
const LIQUID_GLASS_OFF_CHROME =
	"[html[data-ryu-liquid-glass=off]_&]:backdrop-blur-none";

export const ISLAND_FILL = `${ASSISTANT_GLASS_FILL} ${LIQUID_GLASS_OFF_FILL}`;
export const ISLAND_CHROME = `${ASSISTANT_GLASS_CHROME} ${LIQUID_GLASS_OFF_CHROME}`;

/** Wrap surface content in this. Content follows the app theme (no forced dark). */
export const ASSISTANT_SURFACE_CONTENT = "flex h-full w-full flex-col";
