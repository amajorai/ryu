import { useLiteralMessages } from "@ryu/i18n/react";

/**
 * Trailing note on the Core-backed rows (engines, voice, toolkits) while Core is
 * still being checked or is down, or `null` once those pages can open. The text
 * follows the UI language: it is the only explanation the disabled rows give.
 */
export function useCoreUnavailableLabel(
	loading: boolean,
	coreSteady: boolean
): string | null {
	const tl = useLiteralMessages();
	if (loading) {
		return tl("Checking…");
	}
	if (!coreSteady) {
		return tl("Unavailable — Core isn't reachable");
	}
	return null;
}
