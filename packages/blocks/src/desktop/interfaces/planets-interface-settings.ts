import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";

/** A scene at least this tall keeps the planet list open on a narrower screen. */
export const ROOMY_HEIGHT = 980;
export const ROOMY_WIDTH = 720;
/** Below this width a portrait scene is a phone: column and bottom sheet. */
export const PHONE_WIDTH = 560;

/**
 * Escape inside a text field belongs to the field, except in the panel's own
 * composer while it is empty: there it closes the panel, as the Esc hint says.
 */
export function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	const editable =
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !==
			null;
	if (!editable) {
		return true;
	}
	return (
		target instanceof HTMLTextAreaElement &&
		target.closest("[data-planets-composer]") !== null &&
		target.value.trim() === ""
	);
}

/** The Planets' own settings, resolved from its live params. */
export function planetsSettings(
	params: InterfaceParamsByRenderer["planets"] | undefined
): Required<InterfaceParamsByRenderer["planets"]> {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("planets", params) as Required<
		InterfaceParamsByRenderer["planets"]
	>;
}
