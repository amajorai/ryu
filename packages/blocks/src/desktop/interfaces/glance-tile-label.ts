import type { LiteralMessage } from "@ryu/i18n/react";
import {
	GLANCE_AGENT_STATE_LABELS,
	type GlanceAgentState,
} from "./glance-model.ts";

/**
 * The screen-reader name of a Glance agent tile ("Ada, Working"), as one
 * translated message with the state word translated first. A raw template
 * left the state word in English: the catalog's "{name}, {state}" template has
 * no literal anchor, so the DOM localizer cannot match the composite.
 */
export function glanceTileLabel(
	tl: LiteralMessage,
	name: string,
	state: GlanceAgentState
): string {
	return tl("{name}, {state}", {
		name,
		state: tl(GLANCE_AGENT_STATE_LABELS[state]),
	});
}
