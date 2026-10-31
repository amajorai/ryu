import {
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "@ryu/blocks/desktop/agent-identity-mode.tsx";
import type { LiteralMessage } from "@ryu/i18n/react";
import { isAgentOwnedKey } from "@/src/components/agents/agent-account-keys.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";

// "How should this agent work?" — the three-way identity choice.
//
// The cards themselves are presentational and live in
// `@ryu/blocks/desktop/agent-identity-mode.tsx`, so the storyboard renders the
// same component the New agent dialog and the agent editor do. This module
// forwards them and keeps the desktop-only warning, which reads the account
// keys the editor holds.

export {
	AGENT_IDENTITY_MODE_OPTIONS,
	AgentIdentityModePicker,
	AgentRemotePeerIdentityNote,
	isAgentIdentityMode,
	isRemotePeerEngine,
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "@ryu/blocks/desktop/agent-identity-mode.tsx";

/**
 * The inline warning shown when the chosen mode will switch off accounts that
 * are currently selected: the user's accounts (allowlist entries other than
 * the agent's own, the Treg switch and provider slots, plus the bound Identity
 * Vault profiles) for "Its own identity", and the agent's own accounts
 * (`agent:` and `agent-composio:`) for "Acts as you". The selection itself is
 * kept so switching back restores it. `stoppedTriggerCount` is how many of the
 * agent's saved event triggers the unsaved identity and account access would
 * stop; they are named whatever the mode.
 */
export function identityModeAccountWarning(
	tl: LiteralMessage,
	mode: AgentIdentityMode,
	accountAccess: readonly string[] | null,
	identityProfileCount: number,
	stoppedTriggerCount = 0
): string | null {
	const parts = [
		accountsSwitchedOff(tl, mode, accountAccess ?? [], identityProfileCount),
		stoppedTriggersMessage(tl, stoppedTriggerCount),
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" ") : null;
}

function accountsSwitchedOff(
	tl: LiteralMessage,
	mode: AgentIdentityMode,
	keys: readonly string[],
	identityProfileCount: number
): string | null {
	if (!modeUsesYourAccounts(mode)) {
		const yours =
			keys.filter(
				(key) =>
					// Own accounts, the Treg switch and provider slots are not
					// accounts of yours, so the mode does not switch them off.
					// Control of your desktop (`platform:desktop`) is yours.
					!(
						isAgentOwnedKey(key) ||
						key === "platform:treg" ||
						key.startsWith("provider:")
					)
			).length + identityProfileCount;
		if (yours > 0) {
			return tl(
				"{yourAccountCount} of your accounts selected here won't be used while this agent has its own identity.",
				{ yourAccountCount: yours }
			);
		}
		return null;
	}
	if (!modeHasOwnAccounts(mode)) {
		const own = keys.filter(isAgentOwnedKey).length;
		if (own > 0) {
			return tl(
				"{ownAccountCount} of the agent's own accounts selected here won't be used while it acts as you.",
				{ ownAccountCount: own }
			);
		}
	}
	return null;
}

function stoppedTriggersMessage(
	tl: LiteralMessage,
	count: number
): string | null {
	if (count <= 0) {
		return null;
	}
	return tl(
		"{count, plural, one {# event trigger watches an account this agent may no longer use, so it will stop firing.} other {# event triggers watch accounts this agent may no longer use, so they will stop firing.}}",
		{ count }
	);
}
