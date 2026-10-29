// apps/desktop/src/components/agents/AgentLaunchWarning.tsx
//
// The warning the create and edit flows show when Core's launch check
// (`POST /api/agents/launch-check`, see `useAgentLaunchCheck`) says an agent's
// engine would not start under the identity mode and account access on screen.
// The reason is Core's own text, the one the agent's first turn would fail
// with, so nothing here re-derives the rules. Core's model warning (a limited
// agent on Ryu's engine that would start on a local model that isn't
// downloaded) is shown too; it does not stop the agent being saved.

import { Alert, AlertDescription } from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import type {
	AgentIdentityMode,
	AgentLaunchCheck,
} from "@/src/lib/api/agents.ts";

/** The engine-list id of Ryu's own engine ("Ryu" in the engine picker). */
export const RYU_ENGINE_ID = "acp:pi";

/** Core's refusal code when a confined agent's engine needs a sandbox this computer lacks. */
export const LAUNCH_REFUSED_SANDBOX = "account_access_sandbox_unavailable";

/**
 * Whether Core's refusal is the missing account-access sandbox for an agent
 * whose model providers are not limited. Ryu's engine runs without a sandbox
 * only while the providers are limited, so switching engines cannot fix it:
 * the agent's accounts have to be limited first.
 */
export function refusedForUnlimitedSandbox(
	check: AgentLaunchCheck | null,
	modelsLimited: boolean
): boolean {
	return (
		check !== null &&
		!check.launchable &&
		check.code === LAUNCH_REFUSED_SANDBOX &&
		!modelsLimited
	);
}

/**
 * Shown when this computer has no account-access sandbox, so only Ryu's own
 * engine, on its brokered tools, can run a confined agent.
 */
export const NO_SANDBOX_NOTE =
	"On this computer, an agent with its own identity or limited accounts can run only on Ryu (without shell or file tools).";

/** Shown under the engine field while a custom "Ryu" agent runs on Ryu's built-in engine. */
export const MANAGED_PI_NOTE =
	"While its accounts are limited, this agent runs on Ryu's built-in engine.";

/**
 * Whether an agent runs in the account-access sandbox: any mode but Acts as
 * you, or Acts as you with a limited list (Core's `AccountConfinement`).
 */
export function agentIsConfined(
	identityMode: AgentIdentityMode,
	accountAccess: readonly string[] | null
): boolean {
	return identityMode !== "managed" || accountAccess !== null;
}

/**
 * Whether an agent's model providers are limited: its own identity only, or
 * a limited list (Core's `user_provider_access`). Such an agent on the "Ryu"
 * engine runs on Ryu's built-in engine, which needs no sandbox.
 */
export function agentModelsLimited(
	identityMode: AgentIdentityMode,
	accountAccess: readonly string[] | null
): boolean {
	return identityMode === "individual" || accountAccess !== null;
}

/**
 * Whether to show {@link NO_SANDBOX_NOTE}: this computer has no sandbox and
 * the agent's model providers are limited, so Ryu's engine still runs it.
 */
export function showsNoSandboxNote(
	check: AgentLaunchCheck | null,
	modelsLimited: boolean
): boolean {
	return modelsLimited && check !== null && !check.sandboxSupported;
}

/**
 * Core's refusal for the selected engine, with an optional switch to Ryu's
 * own engine, Core's model warning, and the no-sandbox note when it applies.
 */
export function AgentLaunchWarning({
	check,
	disabled = false,
	engine,
	modelsLimited,
	onLimitAccounts,
	onUseRyu,
}: {
	check: AgentLaunchCheck | null;
	disabled?: boolean;
	/** The engine the check was asked about. */
	engine: string | null;
	/** See {@link agentModelsLimited}. */
	modelsLimited: boolean;
	/**
	 * Limit the agent to selected accounts, for a refusal that only a limit can
	 * fix (see {@link refusedForUnlimitedSandbox}); omitted hides the action.
	 */
	onLimitAccounts?: () => void;
	/** Switch the agent to Ryu's own engine; omitted hides the action. */
	onUseRyu?: () => void;
}) {
	const refused = check !== null && !check.launchable && check.reason;
	const noSandbox = showsNoSandboxNote(check, modelsLimited);
	const needsLimit = refusedForUnlimitedSandbox(check, modelsLimited);
	const modelWarning = refused ? null : (check?.modelWarning ?? null);
	if (!(refused || noSandbox || modelWarning)) {
		return null;
	}
	return (
		<div className="flex flex-col gap-2" data-testid="agent-launch-warning">
			{refused ? (
				<Alert variant="destructive">
					<AlertDescription className="flex flex-col items-start gap-2">
						<span>{refused}</span>
						{onLimitAccounts && needsLimit ? (
							<Button
								disabled={disabled}
								onClick={onLimitAccounts}
								size="sm"
								type="button"
								variant="outline"
							>
								Limit to selected accounts
							</Button>
						) : null}
						{onUseRyu && !needsLimit && engine?.trim() !== RYU_ENGINE_ID ? (
							<Button
								disabled={disabled}
								onClick={onUseRyu}
								size="sm"
								type="button"
								variant="outline"
							>
								Use Ryu instead
							</Button>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}
			{modelWarning ? (
				<Alert variant="warning">
					<AlertDescription>{modelWarning}</AlertDescription>
				</Alert>
			) : null}
			{noSandbox ? (
				<p className="px-3.5 text-muted-foreground text-xs leading-snug">
					{NO_SANDBOX_NOTE}
				</p>
			) : null}
		</div>
	);
}
