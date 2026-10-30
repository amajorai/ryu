import type {
	AcpConfigOption,
	StreamedAcpControl,
} from "@ryu/blocks/composer/composer-acp-sections.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useEffect, useMemo, useRef } from "react";
import {
	acpAuthAwaitsVerification,
	authenticateAgent,
	fetchAcpConfig,
} from "@/src/lib/api/acp.ts";
import { isAcpAgent } from "@/src/lib/chat-message-selectors.ts";
import { getAgentModel } from "@/src/lib/models.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatAcpStreamInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatTransport>;

/** ACP mode, auth and agent-control state derived from the streamed transcript. */
export function useChatAcpStream({
	messages,
	setStreamedAcpMode,
	setStreamedAcpModeKey,
	chatTarget,
	botProduct,
	setTeamId,
	setAgentId,
	setSelectedModel,
	setModelSelectionCleared,
	setStreamedAcpControl,
	agentIdRef,
	agents,
}: UseChatAcpStreamInput) {
	// Agent-initiated Session Mode changes. Core streams the new active mode as a
	// `data-ryu-acp-mode` part (`{ currentModeId }`); we take the most recent one
	// and push it into ChatPage's `streamedAcpMode` state, which the composer hook
	// adopts as the Approval picker's selection (and persists for the agent).
	const latestStreamedAcpMode = useMemo<{
		key: string;
		mode: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-ryu-acp-mode") {
					continue;
				}
				const data =
					/* SAFETY: The mode discriminator selects Core ModeChanged(String), serialized as the currentModeId string field. */ part.data as
						| { currentModeId?: string }
						| undefined;
				const modeId = data?.currentModeId?.trim();
				if (modeId) {
					return { key: `${m.id}:${j}`, mode: modeId };
				}
			}
		}
		return null;
	}, [messages]);
	const latestStreamedAcpModeId = latestStreamedAcpMode?.mode ?? null;
	const latestStreamedAcpModeKey = latestStreamedAcpMode?.key ?? null;
	useEffect(() => {
		if (latestStreamedAcpModeId) {
			setStreamedAcpMode(latestStreamedAcpModeId);
			setStreamedAcpModeKey(latestStreamedAcpModeKey);
		}
	}, [latestStreamedAcpModeId, latestStreamedAcpModeKey]);

	// The agent refused a turn because its login lapsed (Core's
	// `data-ryu-acp-auth-required`, raised from JSON-RPC -32000). Core deliberately
	// does NOT send this down the error path: that one tears the turn down with
	// advice about configuring a model, which cannot fix an expired OAuth token
	// and hides the real cause.
	//
	// Surfaced as an actionable toast rather than an inline block: the recovery is
	// a single login the desktop already owns, and the turn can simply be re-run
	// afterwards. Keyed on the emitting part so one lapse prompts once, not on
	// every re-render of the transcript.
	const authPromptedRef = useRef<string | null>(null);
	const latestAuthRequired = useMemo<{
		agentId: string;
		key: string;
		message: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-ryu-acp-auth-required") {
					continue;
				}
				const data =
					/* SAFETY: The auth discriminator selects Core AuthNeeded with Rust String agent_id and message fields, serialized under these names. */ part.data as
						| { agentId?: string; message?: string }
						| undefined;
				if (data?.agentId) {
					return {
						agentId: data.agentId,
						message: data.message ?? "",
						key: `${m.id}:${j}`,
					};
				}
			}
		}
		return null;
	}, [messages]);
	useEffect(() => {
		if (
			!latestAuthRequired ||
			authPromptedRef.current === latestAuthRequired.key
		) {
			return;
		}
		authPromptedRef.current = latestAuthRequired.key;
		const { agentId: staleAgent } = latestAuthRequired;
		let cancelled = false;
		// Ask the agent which login methods it advertises before offering one —
		// the method id is agent-specific and there is no useful default.
		fetchAcpConfig(chatTarget, staleAgent)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				const method = cfg?.authMethods?.[0];
				if (!method) {
					toast.error({
						title: "The agent needs you to log in again",
						description:
							latestAuthRequired.message ||
							"Its session expired, and it advertises no login method.",
					});
					return;
				}
				toast.warning({
					title: "Your agent login expired",
					description: "Log in again, then re-send your message.",
					// Held open: a login prompt that auto-dismisses while the user is
					// reading it leaves them with a dead turn and no explanation.
					duration: null,
					button: {
						title: method.name ?? "Log in",
						onClick: () => {
							authenticateAgent(chatTarget, staleAgent, method.id)
								.then((res) => {
									if (res.authenticated) {
										toast.success({ title: "Logged back in" });
									} else if (acpAuthAwaitsVerification(res)) {
										// Accepted but unverifiable: the vendor login may still
										// be running in a browser or terminal. Not a failure.
										toast.info({
											title: "Finish the login, then re-send",
											description:
												"The agent accepted the login. Complete it in the browser or terminal it opened, then re-send your message.",
										});
									} else {
										toast.error({
											title: "Login did not complete",
											description: res.error,
										});
									}
								})
								.catch(() => {
									toast.error({ title: "Login failed" });
								});
						},
					},
				});
			})
			.catch(() => {
				if (!cancelled) {
					toast.error({
						title: "The agent needs you to log in again",
						description: latestAuthRequired.message || undefined,
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [latestAuthRequired, chatTarget]);

	// The agent's config option DEFINITIONS, re-published on the live stream as
	// `data-ryu-acp-config-options` (`{ configOptions }`). Most recent part wins
	// and REPLACES the set wholesale, the same contract as the slash-command list
	// above — an option missing from a refreshed list is one the agent has
	// withdrawn, so merging would keep a stale picker alive forever.
	const latestStreamedAcpConfigOptions = useMemo<
		AcpConfigOption[] | null
	>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-ryu-acp-config-options") {
					continue;
				}
				// SAFETY: Every Core ConfigOptions producer serializes the typed ACP response or update config_options list; Array.isArray below admits the list before it reaches the picker.
				const data = part.data as
					| { configOptions?: AcpConfigOption[] }
					| undefined;
				if (Array.isArray(data?.configOptions)) {
					return data.configOptions;
				}
			}
		}
		return null;
	}, [messages]);

	// Agent-level target changes are Core-owned, one-turn decisions. The event is
	// deliberately separate from ACP config write-backs: it can move the active
	// conversation agent, but it must not mutate an agent card or a global model
	// preference. The effective target is adopted by this tab so the next user
	// message follows the handoff instead of sending the old agent id again.
	const latestAgentControl = useMemo<{
		data: {
			effective_agent_id?: unknown;
			effective_effort?: unknown;
			effective_model?: unknown;
			effort_cleared?: unknown;
			model_cleared?: unknown;
			requested_effort?: unknown;
			requested_model?: unknown;
		};
		key: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant" || !message.parts) {
				continue;
			}
			for (let j = message.parts.length - 1; j >= 0; j--) {
				const part = message.parts[j];
				if (part.type !== "data-ryu-agent-control") {
					continue;
				}
				const data =
					/* SAFETY: Core serializes this agent-control object; all projected fields remain unknown until the following native brand or literal checks. */ part.data as
						| {
								effective_agent_id?: unknown;
								effective_effort?: unknown;
								effective_model?: unknown;
								effort_cleared?: unknown;
								model_cleared?: unknown;
								requested_effort?: unknown;
								requested_model?: unknown;
						  }
						| undefined;
				return { data: data ?? {}, key: `${message.id}:${j}` };
			}
		}
		return null;
	}, [messages]);
	const lastAgentControlRef = useRef<string | null>(null);
	useEffect(() => {
		if (botProduct) {
			return;
		}
		if (
			!latestAgentControl ||
			latestAgentControl.key === lastAgentControlRef.current
		) {
			return;
		}
		lastAgentControlRef.current = latestAgentControl.key;
		const targetAgentId = isNativeText(
			latestAgentControl.data.effective_agent_id
		)
			? latestAgentControl.data.effective_agent_id.trim()
			: "";
		const modelWasControlled =
			latestAgentControl.data.model_cleared === true ||
			isNativeText(latestAgentControl.data.requested_model);
		const effortWasControlled =
			latestAgentControl.data.effort_cleared === true ||
			isNativeText(latestAgentControl.data.requested_effort);
		const streamedControl: StreamedAcpControl = {
			agentId: targetAgentId || null,
			key: latestAgentControl.key,
		};
		if (modelWasControlled) {
			streamedControl.model =
				latestAgentControl.data.model_cleared === true
					? null
					: isNativeText(latestAgentControl.data.effective_model)
						? latestAgentControl.data.effective_model.trim() || null
						: null;
		}
		if (effortWasControlled) {
			streamedControl.effort =
				latestAgentControl.data.effort_cleared === true
					? null
					: isNativeText(latestAgentControl.data.effective_effort)
						? latestAgentControl.data.effective_effort.trim() || null
						: null;
		}
		if (!targetAgentId) {
			// A null effective target means Core resumed automatic routing. Clear
			// this tab's stale manual target so the next request cannot re-pin the
			// agent that just asked to be cleared.
			setTeamId(null);
			setAgentId(null);
			setSelectedModel(null);
			setModelSelectionCleared(true);
			setStreamedAcpControl(
				modelWasControlled || effortWasControlled ? streamedControl : null
			);
			return;
		}
		if (targetAgentId !== agentIdRef.current) {
			setTeamId(null);
			setAgentId(targetAgentId);
			setSelectedModel(getAgentModel(targetAgentId));
			setModelSelectionCleared(false);
		}
		if (modelWasControlled && !isAcpAgent(targetAgentId, agents)) {
			setSelectedModel(streamedControl.model ?? null);
			setModelSelectionCleared(streamedControl.model === null);
		}
		setStreamedAcpControl(
			modelWasControlled || effortWasControlled ? streamedControl : null
		);
	}, [agents, botProduct, latestAgentControl]);
	return { latestStreamedAcpConfigOptions } as const;
}
