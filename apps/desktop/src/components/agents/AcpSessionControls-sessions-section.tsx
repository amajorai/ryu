// apps/desktop/src/components/agents/AcpSessionControls-sessions-section.tsx
//
// The "Sessions" section of the agent-edit ACP session controls: the sessions
// the agent persists, each deletable.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import { useAcpConfig } from "@/src/hooks/useAcpConfig.ts";
import { useAcpSessions } from "@/src/hooks/useAcpSessions.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import {
	SettingsCard,
	SettingsSection,
} from "../settings/shared/settings-items.tsx";
import { errMessage } from "./AcpSessionControls-error-message.ts";

/** Best-effort friendly timestamp; falls back to the raw string. */
function formatUpdatedAt(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return formatDateTime(parsed);
}

export function AcpSessionsSection({ agentId }: { agentId: string }) {
	const tl = useLiteralMessages();
	const { data, loading, remove, removing } = useAcpSessions(agentId);
	// Same call the auth section above makes, so this is a cached read rather
	// than a second probe of the agent.
	const { config } = useAcpConfig(agentId);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [confirmTarget, setConfirmTarget] = useState<{
		label: string;
		sessionId: string;
	} | null>(null);

	// Nothing to show for agents that don't persist sessions (the common case).
	if (loading || !data || data.unsupported || data.sessions.length === 0) {
		return null;
	}

	// Strict `!== false`: only a Core that positively reported "no close" hides
	// the button. `undefined` — an older Core with no `sessionCapabilities` key —
	// keeps today's behaviour rather than silently removing a working control.
	const canDelete =
		config?.agentCapabilities?.sessionCapabilities?.close !== false;

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
			<SettingsCard className="flex max-h-80 flex-col gap-3 overflow-y-auto">
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
								<span
									className="truncate font-medium text-sm"
									title={session.title || session.sessionId}
								>
									{session.title || session.sessionId}
								</span>
								{subtext ? (
									<span className="truncate text-muted-foreground text-xs">
										{subtext}
									</span>
								) : null}
							</div>
							{/* Hidden outright, not disabled: this section's posture is
							    silent self-hiding, and a greyed-out Delete invites a
							    hunt for the setting that would enable it. */}
							{canDelete ? (
								<Button
									aria-label={tl("Delete session {label}", {
										label: session.title || session.sessionId,
									})}
									className="text-status-destructive"
									disabled={busy}
									onClick={() =>
										setConfirmTarget({
											label: session.title || session.sessionId,
											sessionId: session.sessionId,
										})
									}
									size="sm"
									variant="ghost"
								>
									{busy ? "Deleting…" : "Delete"}
								</Button>
							) : null}
						</div>
					);
				})}
			</SettingsCard>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setConfirmTarget(null);
					}
				}}
				open={confirmTarget !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this session?</AlertDialogTitle>
						<AlertDialogDescription>
							{confirmTarget
								? tl(
										'"{label}" will be removed from the agent\'s own store. This cannot be undone.',
										{ label: confirmTarget.label }
									)
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (confirmTarget) {
									void handleDelete(confirmTarget.sessionId);
								}
								setConfirmTarget(null);
							}}
							variant="destructive"
						>
							Delete session
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsSection>
	);
}
