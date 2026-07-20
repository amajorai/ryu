// apps/desktop/src/components/agents/AcpSessionControls.tsx
//
// The agent-edit ACP session controls for external agents: an "Authentication"
// section (the agent-advertised "Login with X" methods) and a "Sessions"
// section (the sessions the agent persists, each deletable). Both are fully
// data-driven from Core — the auth methods ride the same `/acp-config` payload
// the composer pickers use (`useAcpConfig`), the sessions come from
// `/agents/:id/sessions` (`useAcpSessions`). Each section renders ONLY when the
// agent reports something, so the flagship Pi (no auth, no tracked sessions)
// shows nothing. Rendered from AgentEditPage's model tab.

import { Button } from "@ryu/ui/components/button";
import { toast } from "@ryu/ui/components/sileo";
import { useState } from "react";
import { useAcpConfig } from "@/src/hooks/useAcpConfig.ts";
import { useAcpSessions } from "@/src/hooks/useAcpSessions.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { authenticateAgent, logoutAgent } from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	SettingsCard,
	SettingsSection,
} from "../settings/shared/settings-items.tsx";

function errMessage(e: unknown, fallback: string): string {
	return e instanceof Error ? e.message : fallback;
}

/** Best-effort friendly timestamp; falls back to the raw string. */
function formatUpdatedAt(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return parsed.toLocaleString();
}

function AcpAuthSection({ agentId }: { agentId: string }) {
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
			if (res.authenticated) {
				toast.success({ title: `Signed in with ${methodName}` });
			} else {
				toast.error({
					title: `Could not sign in with ${methodName}`,
					description: res.error ?? "The agent rejected the login.",
				});
			}
		} catch (e) {
			toast.error({
				title: `Could not sign in with ${methodName}`,
				description: errMessage(e, "The request failed."),
			});
		} finally {
			setPendingMethodId(null);
		}
	};

	return (
		<SettingsSection
			caption="Sign in to the agent's own provider (e.g. a ChatGPT or Claude subscription) so it can serve turns without a separate API key."
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
								{busy ? "Signing in…" : `Login with ${method.name}`}
							</Button>
						</div>
					);
				})}
				<div className="flex items-center justify-between gap-3 border-border/60 border-t pt-3">
					<span className="text-muted-foreground text-xs">
						End the agent's authenticated session. You'll need to sign in again
						to use it.
					</span>
					<Button
						disabled={loggingOut || pendingMethodId !== null}
						onClick={handleLogout}
						size="sm"
						variant="outline"
					>
						{loggingOut ? "Logging out…" : "Log out"}
					</Button>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

function AcpSessionsSection({ agentId }: { agentId: string }) {
	const { data, loading, remove, removing } = useAcpSessions(agentId);
	const [pendingId, setPendingId] = useState<string | null>(null);

	// Nothing to show for agents that don't persist sessions (the common case).
	if (loading || !data || data.unsupported || data.sessions.length === 0) {
		return null;
	}

	const handleDelete = async (sessionId: string) => {
		setPendingId(sessionId);
		try {
			const res = await remove(sessionId);
			if (res.deleted) {
				toast.success({ title: "Session deleted" });
			} else {
				toast.error({
					title: "Could not delete session",
					description: res.error ?? "The agent rejected the request.",
				});
			}
		} catch (e) {
			toast.error({
				title: "Could not delete session",
				description: errMessage(e, "The request failed."),
			});
		} finally {
			setPendingId(null);
		}
	};

	return (
		<SettingsSection
			caption="Sessions this agent has persisted. Deleting one removes it from the agent's own store."
			title="Sessions"
		>
			<SettingsCard className="flex flex-col gap-3">
				{data.sessions.map((session) => {
					const busy = removing && pendingId === session.sessionId;
					const subtext = [
						session.cwd,
						session.updatedAt ? formatUpdatedAt(session.updatedAt) : null,
					]
						.filter(Boolean)
						.join(" · ");
					return (
						<div
							className="flex items-center justify-between gap-3"
							key={session.sessionId}
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="truncate font-medium text-sm">
									{session.title || session.sessionId}
								</span>
								{subtext ? (
									<span className="truncate text-muted-foreground text-xs">
										{subtext}
									</span>
								) : null}
							</div>
							<Button
								disabled={busy}
								onClick={() => handleDelete(session.sessionId)}
								size="sm"
								variant="outline"
							>
								{busy ? "Deleting…" : "Delete"}
							</Button>
						</div>
					);
				})}
			</SettingsCard>
		</SettingsSection>
	);
}

/**
 * ACP auth + sessions for one agent. Each section self-hides when the agent
 * reports nothing, so this renders nothing at all for a plain local agent.
 */
export function AcpSessionControls({ agentId }: { agentId: string }) {
	return (
		<>
			<AcpAuthSection agentId={agentId} />
			<AcpSessionsSection agentId={agentId} />
		</>
	);
}
