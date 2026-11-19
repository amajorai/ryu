import { translate } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * The name and label of the prompt suite a trace import creates when an agent
 * has none yet. They are stored as written (later imports pick the agent's
 * first suite, never look it up by name), so they are worded in the creator's
 * language.
 */
export function agentRegressionSuiteNames(tl: LiteralMessage = translate): {
	label: string;
	name: string;
} {
	return { label: tl("Trace baseline"), name: tl("Agent regression suite") };
}
