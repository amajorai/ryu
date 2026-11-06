import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	AgentLifecycleStatus,
	AgentSafetyProfile,
} from "@/src/lib/api/agents.ts";

/**
 * Display copy for an agent's safety profile. The `Record` makes the compiler
 * fail when a new profile has no label; the literals are catalog keys.
 */
export const AGENT_SAFETY_PROFILE_LABELS: Record<AgentSafetyProfile, string> = {
	approval_required: "Approval required",
	autonomous: "Autonomous",
	read_only: "Read-only",
	verified_plan_only: "Verified plans only",
};

/** Display copy for an agent's lifecycle status, keyed like the profiles. */
export const AGENT_LIFECYCLE_LABELS: Record<AgentLifecycleStatus, string> = {
	active: "Active",
	draft: "Draft",
	trial: "Trial",
};

/** "Approval required" in the reader's language. */
export function agentSafetyProfileLabel(
	profile: AgentSafetyProfile,
	tl: LiteralMessage
): string {
	return tl(AGENT_SAFETY_PROFILE_LABELS[profile]);
}

/** "Trial" in the reader's language. */
export function agentLifecycleLabel(
	status: AgentLifecycleStatus,
	tl: LiteralMessage
): string {
	return tl(AGENT_LIFECYCLE_LABELS[status]);
}
