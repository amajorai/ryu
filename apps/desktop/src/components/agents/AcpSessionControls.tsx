// apps/desktop/src/components/agents/AcpSessionControls.tsx
//
// The agent-edit ACP session controls for external agents: a "Session defaults"
// section (the agent's own model / approval mode / reasoning-effort pickers), an
// "Authentication" section (the agent-advertised "Login with X" methods) and a
// "Sessions" section (the sessions the agent persists, each deletable). All
// three are fully data-driven from Core — the config and auth methods ride the
// same `/acp-config` payload the composer pickers use (`useAcpConfig`), the
// sessions come from `/agents/:id/sessions` (`useAcpSessions`). Each section
// renders ONLY when the agent reports something, so the flagship Pi (no auth, no
// tracked sessions) shows nothing. Rendered from AgentEditPage's model tab.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import { useAcpConfig } from "@/src/hooks/useAcpConfig.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	acpAuthAwaitsVerification,
	authenticateAgent,
	logoutAgent,
} from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	SettingsCard,
	SettingsSection,
} from "../settings/shared/settings-items.tsx";
import { errMessage } from "./AcpSessionControls-error-message.ts";
import { AcpSessionOptionsSection } from "./AcpSessionControls-options-section.tsx";
import { AcpSessionsSection } from "./AcpSessionControls-sessions-section.tsx";

function AcpAuthSection({ agentId }: { agentId: string }) {
	const tl = useLiteralMessages();
	const { config } = useAcpConfig(agentId);
	const activeNode = useActiveNode();
	const [pendingMethodId, setPendingMethodId] = useState<string | null>(null);

	const [loggingOut, setLoggingOut] = useState(false);

	const methods = config?.authMethods ?? [];
	if (methods.length === 0) {
		return null;
	}

	const handleLogout = async () => {
		setLoggingOut(true);
		try {
			const res = await logoutAgent(toTarget(activeNode), agentId);
			if (res.loggedOut) {
				toast.success({ title: "Logged out of the agent" });
			} else {
				toast.error({
					title: "Could not log out",
					description: res.error ?? "The agent does not support logout.",
				});
			}
		} catch (e) {
			toast.error({
				title: "Could not log out",
				description: errMessage(e, "The request failed."),
			});
		} finally {
			setLoggingOut(false);
		}
	};

	const handleLogin = async (methodId: string, methodName: string) => {
		setPendingMethodId(methodId);
		try {
			const res = await authenticateAgent(
				toTarget(activeNode),
				agentId,
				methodId
			);
			if (res.authenticated && res.verified) {
				toast.success({
					title: tl("Signed in with {methodName}", { methodName }),
				});
			} else if (res.authenticated || acpAuthAwaitsVerification(res)) {
				// Unverified: Core had no credential to check this agent against, so
				// all that is known is that the agent accepted the request. Agents do
				// advertise methods that accept it and log nobody in, so this must not
				// be worded as a completed sign-in. Current Core reports this as
				// `verificationRequired`; an older node sent `authenticated` unverified.
				toast.info({
					title: `${methodName} ran`,
					description:
						"The agent accepted the request. If its login happens elsewhere (a browser or terminal), finish it there — this can't confirm you're signed in.",
				});
			} else {
				toast.error({
					title: tl("Could not sign in with {methodName}", { methodName }),
					description: res.error ?? "The agent rejected the login.",
				});
			}
		} catch (e) {
			toast.error({
				title: tl("Could not sign in with {methodName}", { methodName }),
				description: errMessage(e, "The request failed."),
			});
		} finally {
			setPendingMethodId(null);
		}
	};

	return (
		<SettingsSection
			caption="Sign in to the agent's own provider to serve turns without a separate API key."
			title="Authentication"
		>
			<SettingsCard className="flex flex-col gap-3">
				{methods.map((method) => {
					const busy = pendingMethodId === method.id;
					return (
						<div
							className="flex items-center justify-between gap-3"
							key={method.id}
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="font-medium text-sm">{method.name}</span>
								{method.description ? (
									<span className="text-muted-foreground text-xs">
										{method.description}
									</span>
								) : null}
							</div>
							<Button
								disabled={busy || pendingMethodId !== null}
								onClick={() => handleLogin(method.id, method.name)}
								size="sm"
							>
								{busy
									? "Signing in…"
									: tl("Login with {name}", { name: method.name })}
							</Button>
						</div>
					);
				})}
				<div className="flex items-center justify-between gap-3 border-border border-t pt-3">
					<span className="text-muted-foreground text-xs">
						End the agent's authenticated session. You'll need to sign in again
						to use it.
					</span>
					<Button
						disabled={loggingOut || pendingMethodId !== null}
						onClick={handleLogout}
						size="sm"
						variant="ghost"
					>
						{loggingOut ? "Logging out…" : "Log out"}
					</Button>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

/**
 * ACP session defaults + auth + sessions for one agent. Each section self-hides
 * when the agent reports nothing, so this renders nothing at all for a plain
 * local agent.
 */
export function AcpSessionControls({ agentId }: { agentId: string }) {
	return (
		<>
			<AcpSessionOptionsSection agentId={agentId} />
			<AcpAuthSection agentId={agentId} />
			<AcpSessionsSection agentId={agentId} />
		</>
	);
}
