import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";

/** The Passport's own settings, resolved from its live params. */
export function passportSettings(
	params: InterfaceParamsByRenderer["passport"] | undefined
): Required<InterfaceParamsByRenderer["passport"]> {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("passport", params) as Required<
		InterfaceParamsByRenderer["passport"]
	>;
}
