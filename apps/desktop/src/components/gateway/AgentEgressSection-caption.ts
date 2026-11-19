// apps/desktop/src/components/gateway/AgentEgressSection-caption.ts
//
// The Agent tools and model traffic caption as separately translated sentences.
// Each sentence is its own catalog message and is rendered as its own text node
// (see AgentEgressSection), so the DOM localizer never sees an English sentence
// glued onto a translated one.

import type { LiteralMessage } from "@ryu/i18n/react";
import type { AgentEgressView } from "@/src/lib/api/agent-egress.ts";

type EgressCounts = Omit<AgentEgressView, "rows">;

/** The caption sentences for a loaded view, each translated on its own. */
export function agentEgressCaptionSentences(
	view: EgressCounts,
	tl: LiteralMessage
): string[] {
	return [
		tl(
			"Tools: {toolsOnCount} have Ryu's tools · {toolsOffCount} do not · {toolsOtherCount} not applicable.",
			{
				toolsOnCount: String(view.toolsOnCount),
				toolsOffCount: String(view.toolsOffCount),
				toolsOtherCount: String(view.toolsOtherCount),
			}
		),
		tl(
			"Model traffic: {governedCount} through the gateway · {bestEffortCount} pointed at it · {directCount} straight to the provider · {otherCount} local or unknown.",
			{
				governedCount: String(view.governedCount),
				bestEffortCount: String(view.bestEffortCount),
				directCount: String(view.directCount),
				otherCount: String(view.otherCount),
			}
		),
		tl(
			"Only calls that reach the gateway are filtered by the rules above, counted against your spending limits, or recorded in the activity log."
		),
		tl(
			"These are the only two layers shown here. Command approval above is node-wide, and plugin hooks are a separate layer again."
		),
	];
}
