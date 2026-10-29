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

import {
	FullAccessSelectionProvider,
	useFullAccessSelectionGuard,
} from "@ryu/blocks/composer/full-access-warning.tsx";
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
import { RangeSlider } from "@ryu/ui/components/motion/range-slider.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import { useAcpConfig } from "@/src/hooks/useAcpConfig.ts";
import { useAcpSessions } from "@/src/hooks/useAcpSessions.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	acpAuthAwaitsVerification,
	authenticateAgent,
	logoutAgent,
} from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { LEVEL_RAMP_CLASS, levelFillColor } from "@/src/lib/level-ramp.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import {
	SettingsCard,
	SettingsSection,
} from "../settings/shared/settings-items.tsx";

function errMessage<TError>(e: TError, fallback: string): string {
	return e instanceof Error ? e.message : fallback;
}

/** Best-effort friendly timestamp; falls back to the raw string. */
function formatUpdatedAt(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return formatDateTime(parsed);
}

/** Engine-catalog fallback inputs. This surface only shows what the AGENT
 *  advertises — the engine model has its own field on the same page — so the
 *  fallback branch is fed an empty list and its section self-hides. */
const NO_MODEL_OPTIONS: never[] = [];
const noopModelChange = () => {
	// The engine-catalog branch is not rendered here; see NO_MODEL_OPTIONS.
};

/**
 * One agent-advertised session control, rendered as a settings row.
 *
 * An ORDERED scale (reasoning effort: off → low → … → max) is a stepped slider
 * with the shared cool → hot fill ramp, exactly as the composer renders it
 * (`EffortSliderRow`) — same control, same colours, whether you meet it in the
 * chat bar or here. `LEVEL_RAMP_CLASS` on the wrapper is what makes the top of
 * that ramp resolve; without it the fill silently disappears. Everything else is
 * an unordered set and gets a select.
 */
function AcpOptionRow({ section }: { section: ComposerSettingsSection }) {
	const selectionGuard = useFullAccessSelectionGuard();
	const activeIndex = Math.max(
		0,
		section.items.findIndex((it) => it.id === section.value)
	);
	const active = section.items[activeIndex];

	if (section.variant === "slider") {
		return (
			<div className={cn("flex flex-col gap-1.5", LEVEL_RAMP_CLASS)}>
				<div className="flex items-center justify-between gap-2">
					<span className="font-medium text-sm">{section.label}</span>
					<span className="max-w-[160px] truncate text-muted-foreground text-xs">
						{active?.name}
					</span>
				</div>
				<RangeSlider
					aria-label={section.ariaLabel}
					className="h-8"
					fillColor={levelFillColor(activeIndex, section.items.length)}
					formatValueText={(v) =>
						section.items[Math.round(v)]?.name ?? String(v)
					}
					max={section.items.length - 1}
					min={0}
					onValueChange={(next) => {
						const picked = section.items[Math.round(next)];
						if (picked && picked.id !== section.value) {
							section.onChange(picked.id);
						}
					}}
					step={1}
					value={activeIndex}
				/>
				<div className="flex items-center justify-between gap-1">
					{section.items.map((item, i) => (
						<span
							className={cn(
								"type-compact flex-1 truncate leading-none",
								i === 0 && "text-left",
								i === section.items.length - 1 && "text-right",
								i > 0 && i < section.items.length - 1 && "text-center",
								i === activeIndex
									? "text-foreground"
									: "text-muted-foreground/70"
							)}
							key={item.id}
						>
							{item.name}
						</span>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="font-medium text-sm">{section.label}</span>
				{active?.description ? (
					<span className="text-muted-foreground text-xs">
						{active.description}
					</span>
				) : null}
			</div>
			<Select
				onValueChange={(next) => {
					if (next) {
						const item = section.items.find(
							(candidate) => candidate.id === next
						);
						selectionGuard?.request(
							item ?? { id: next, name: next },
							() => section.onChange(next),
							section.label
						);
					}
				}}
				value={section.value ?? ""}
			>
				<SelectTrigger className="w-56 shrink-0">
					<SelectValue placeholder="Default" />
				</SelectTrigger>
				<SelectContent>
					{section.items.map((item) => (
						<SelectItem key={item.id} value={item.id}>
							{item.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * The agent's OWN session controls — model, approval mode, reasoning effort and
 * whatever else it advertises — configurable per agent, on the agent's page.
 *
 * These are the same sections the composer builds
 * (`useComposerAcpSections`, keyed by agent rather than by live chat session)
 * writing through the same per-agent store (`src/lib/acp-selections.ts`), so a
 * pick made here is the pick a new chat with this agent starts on, and the chat
 * bar shows it already selected. That shared store is the point: at Ryu Work
 * mode the composer stops carrying these controls at all, and this
 * page is where they continue to live.
 */
function AcpSessionOptionsSection({ agentId }: { agentId: string }) {
	const { agents } = useAgents();
	const agentName = agents.find((agent) => agent.id === agentId)?.name;
	const { modelSection, extraSections } = useComposerAcpSections({
		agentId,
		agents,
		engineModel: null,
		modelOptions: NO_MODEL_OPTIONS,
		onEngineModelChange: noopModelChange,
	});

	const modelAsSection: ComposerSettingsSection = {
		key: "model",
		label: "Model",
		ariaLabel: "Select model",
		items: modelSection.items,
		value: modelSection.value,
		onChange: modelSection.onChange,
		loading: modelSection.loading,
	};
	// Deliberately NOT `modelSection.renderContent`: that body is the composer's
	// grouped/searchable dropdown, built to live inside a menu. A settings row
	// wants a plain select over the same items.
	const sections = [modelAsSection, ...extraSections].filter(
		(section) => section.items.length > 0
	);
	const probing = modelSection.loading && sections.length === 0;

	if (probing) {
		return (
			<SettingsSection
				caption="Asking the agent which models and modes it supports…"
				title="Session defaults"
			>
				<SettingsCard>
					<SkeletonRows label="Detecting…" rows={2} />
				</SettingsCard>
			</SettingsSection>
		);
	}
	// A local agent advertises no session config at all, so this whole block is
	// absent rather than empty.
	if (sections.length === 0) {
		return null;
	}

	return (
		<SettingsSection
			caption="What this agent runs with by default — its own model, approval mode and reasoning effort. New chats with it start here, and picking one in the chat bar updates this."
			title="Session defaults"
		>
			<FullAccessSelectionProvider agentName={agentName}>
				<SettingsCard className="flex flex-col gap-4">
					{sections.map((section) => (
						<AcpOptionRow key={section.key} section={section} />
					))}
				</SettingsCard>
			</FullAccessSelectionProvider>
		</SettingsSection>
	);
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
			if (res.authenticated && res.verified) {
				toast.success({ title: `Signed in with ${methodName}` });
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
						variant="ghost"
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
									aria-label={`Delete session ${session.title || session.sessionId}`}
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
								? `"${confirmTarget.label}" will be removed from the agent's own store. This cannot be undone.`
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
