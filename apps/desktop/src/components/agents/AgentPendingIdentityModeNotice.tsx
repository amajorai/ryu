import { AGENT_IDENTITY_MODE_OPTIONS } from "@ryu/blocks/desktop/agent-identity-mode.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";

// A newer version of an app asked its agent for a wider identity mode than the
// one the user has. Core never applies that on its own: it keeps the current
// mode and waits here. "Accept" selects the requested mode in the editor, so
// the next save settles the request; "Keep current" dismisses it right away.

export function AgentPendingIdentityModeNotice({
	busy,
	disabled,
	keptMode,
	onAccept,
	onKeepCurrent,
	pendingMode,
	selectedMode,
}: {
	busy: boolean;
	disabled: boolean;
	/** The mode Core holds for the agent, which it keeps until the user decides. */
	keptMode: AgentIdentityMode;
	onAccept: (mode: AgentIdentityMode) => void;
	onKeepCurrent: () => void;
	pendingMode: AgentIdentityMode;
	/** The mode currently chosen in the editor (not necessarily saved). */
	selectedMode: AgentIdentityMode;
}) {
	const tl = useLiteralMessages();
	const requested = AGENT_IDENTITY_MODE_OPTIONS[pendingMode].title;
	const current = AGENT_IDENTITY_MODE_OPTIONS[keptMode].title;
	const accepted = selectedMode === pendingMode;
	return (
		<div
			className="flex flex-col gap-2 rounded-2xl border border-status-warning/40 bg-status-warning/5 px-3.5 py-3"
			data-testid="agent-pending-identity-mode"
			role="status"
		>
			<p className="text-sm leading-snug">
				{tl(
					`An update to this agent's app asks for "{requested}" instead of "{current}". Ryu keeps "{current}" until you decide.`,
					{ current, requested }
				)}
			</p>
			<p className="text-muted-foreground text-xs leading-snug">
				{accepted
					? tl(
							`"{requested}" is selected. Save the agent to accept the request.`,
							{ requested }
						)
					: tl(
							`Accept selects "{requested}" here; save the agent to apply it.`,
							{
								requested,
							}
						)}
			</p>
			<div className="flex gap-2">
				<Button
					disabled={disabled || busy || accepted}
					onClick={() => onAccept(pendingMode)}
					size="sm"
					type="button"
				>
					Accept
				</Button>
				<Button
					disabled={disabled || busy}
					onClick={onKeepCurrent}
					size="sm"
					type="button"
					variant="outline"
				>
					Keep current
				</Button>
			</div>
		</div>
	);
}
