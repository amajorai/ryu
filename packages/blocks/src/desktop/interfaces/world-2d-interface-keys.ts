import type { WorldPoint } from "@ryuhq/protocol/interfaces";
import type { ActorState } from "./world-2d-render.ts";

export const DIGIT_KEYS = "1234567890";
export const NO_NOTICES: readonly WorldPoint[] = [];
export const NO_ACTORS: readonly ActorState[] = [];
/** Above a villager's tile centre: its head and its "!" (px). */
export const HEAD_ROOM = 110;
/** The act column on a wide stage: its width and its bottom edge (px). */
export const HUD_WIDE_WIDTH = 340;
export const HUD_WIDE_BOTTOM = 330;
/** The HUD band across the top of a phone's stage (px). */
export const HUD_NARROW_BOTTOM = 300;
/** The hotbar's band along the bottom of the stage (px). */
export const HOTBAR_ROOM = 110;
/** The controller's talk keys: next to an asker they open its ask. */
export const ASK_KEYS = new Set(["e", "enter", " "]);

/**
 * Whether the focused element inside the world needs the key itself (as the
 * world controller judges it): text fields, and Enter/Space on a button or
 * link, which activate it natively.
 */
export function ownsAskKey(
	target: EventTarget,
	world: EventTarget,
	key: string
): boolean {
	if (target === world || !(target instanceof HTMLElement)) {
		return false;
	}
	if (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	) {
		return true;
	}
	return (
		key !== "e" &&
		key !== "E" &&
		(target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement)
	);
}
