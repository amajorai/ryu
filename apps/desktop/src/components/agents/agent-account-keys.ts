import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";

// Account-key predicates shared by the identity picker's warning and the agent
// editor. Keep in step with `AccountKey::is_agent_owned` and
// `AgentAccountPolicy` in `apps/core/src/agent_access.rs`.

/**
 * Whether an allowlist key names one of the agent's own accounts: a vault
 * account it created (`agent:`) or an app connected to its own Composio
 * identity (`agent-composio:`). Everything else is the user's, or a platform
 * route.
 */
export function isAgentOwnedKey(key: string): boolean {
	return key.startsWith("agent:") || key.startsWith("agent-composio:");
}

/** The fields of an event trigger the account check reads. */
export interface TriggerAccount {
	connectedAccountId: string;
	/** Whether it watches an account connected to the agent's own identity. */
	ownAccount: boolean;
}

/**
 * Whether Core still delivers a trigger's events under this identity mode and
 * allowlist (`null` is no limit). One of your accounts needs a mode that uses
 * your accounts and, when limited, its `composio:` row
 * (`allows_composio_account`). One of the agent's own needs a mode with own
 * accounts other than Acts as you and, when limited, its `agent-composio:` row
 * (`allows_own_composio_trigger`).
 */
export function triggerAllowedByAccess(
	mode: AgentIdentityMode,
	accountAccess: readonly string[] | null,
	trigger: TriggerAccount
): boolean {
	if (trigger.ownAccount) {
		return (
			mode !== "managed" &&
			(accountAccess === null ||
				accountAccess.includes(`agent-composio:${trigger.connectedAccountId}`))
		);
	}
	return (
		mode !== "individual" &&
		(accountAccess === null ||
			accountAccess.includes(`composio:${trigger.connectedAccountId}`))
	);
}

/** The ids of the triggers whose events this access would no longer deliver. */
export function pausedTriggerIds<T extends TriggerAccount & { id: string }>(
	mode: AgentIdentityMode,
	accountAccess: readonly string[] | null,
	triggers: readonly T[]
): string[] {
	return triggers
		.filter((trigger) => !triggerAllowedByAccess(mode, accountAccess, trigger))
		.map((trigger) => trigger.id);
}

/**
 * Whether Core lets the saved agent hold apps on its own Composio identity.
 * Core answers 409 for an agent saved as Acts as you, so an unsaved switch to
 * Its own identity or Both has to be saved first.
 */
export function savedModeHasOwnApps(
	savedMode: AgentIdentityMode | null | undefined
): boolean {
	return (
		savedMode !== null && savedMode !== undefined && savedMode !== "managed"
	);
}
