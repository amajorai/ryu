import type {
	AcpConfigOption,
	StreamedAcpConfig,
	StreamedAcpControl,
} from "@ryu/blocks/composer/composer-acp-sections.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { fetchAgent } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type RecordConversationModelSelectionInput,
	recordConversationModelSelection,
} from "@/src/lib/api/conversation-model-selection.ts";
import { setAgentModel } from "@/src/lib/models.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import { mergeConversationModelChanges } from "./ChatPage.helpers.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatModelSelectionInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity>;

/** The conversation id plus model and ACP selection, persisted per conversation. */
export function useChatModelSelection({
	tabConversationId,
	modelSelectionScopeRef,
	modelSelectionWriteQueueRef,
	modelSelectionMountedRef,
	conversationModelChangesRef,
	setConversationModelChanges,
	pendingModelSelectionRef,
	ghostChatActiveRef,
	modelOptions,
	selectedModelRef,
	warnModelSwitchCacheReset,
	setModelSelectionCleared,
	setSelectedModel,
	setProviderModelSelection,
	agentId,
	announceComposerSelection,
	agents,
	effectiveModel,
	interfaceLevel,
	setAgentTools,
}: UseChatModelSelectionInput) {
	// This tab's OWN conversation id, independent of the shared focused-tab
	// `activeConversationId`. Every chat tab stays mounted at once (Layout), and
	// AI SDK's `useChat({ id })` shares ONE Chat instance across all hooks that
	// pass the same id — so keying every mounted tab off the single global id
	// made a newly-opened conversation collide with an already-mounted tab and
	// render empty (the new mount's blank initial state clobbered the loaded
	// history). Keying each tab off its own id keeps the threads independent.
	const [convId, setConvId] = useState<string | null>(
		tabConversationId ?? null
	);

	// Stable draft ID shared by task selection and the first chat send.
	const draftConvId = useRef(`conv-${Date.now()}`);

	// Latest convId reachable from the once-created transport body closure below.
	const convIdRef = useRef<string | null>(convId);
	convIdRef.current = convId;

	const persistModelSelection = useCallback(
		(
			conversationId: string,
			selection: RecordConversationModelSelectionInput,
			scope = modelSelectionScopeRef.current
		) => {
			// Capture both transport and UI ownership before entering the serial queue.
			// Pending draft selections also carry bookkeeping; send only the API DTO.
			const { changeId, kind, modelId, modelLabel, providerId, providerLabel } =
				selection;
			const input = {
				changeId,
				kind,
				modelId,
				modelLabel,
				providerId,
				providerLabel,
			};
			const write = modelSelectionWriteQueueRef.current.then(async () => {
				const result = await recordConversationModelSelection(
					scope.target,
					conversationId,
					input
				);
				const ownsCurrentRoom =
					modelSelectionMountedRef.current &&
					modelSelectionScopeRef.current === scope &&
					convIdRef.current === conversationId;
				if (ownsCurrentRoom) {
					const merged = mergeConversationModelChanges(
						conversationModelChangesRef.current,
						[result.change]
					);
					conversationModelChangesRef.current = merged;
					setConversationModelChanges(merged);
				}
				if (
					ownsCurrentRoom &&
					pendingModelSelectionRef.current?.changeId === selection.changeId
				) {
					pendingModelSelectionRef.current = null;
				}
				return result;
			});
			modelSelectionWriteQueueRef.current = write.then(
				() => undefined,
				() => undefined
			);
			return write;
		},
		[]
	);

	const queueModelSelectionChange = useCallback(
		(input: RecordConversationModelSelectionInput) => {
			if (ghostChatActiveRef.current) {
				pendingModelSelectionRef.current = null;
				return;
			}
			const conversationId = convIdRef.current;
			const scope = modelSelectionScopeRef.current;
			const pending = {
				...input,
				scope,
				conversationId,
				draftConversationId: draftConvId.current,
			};
			pendingModelSelectionRef.current = pending;
			if (conversationId) {
				void persistModelSelection(conversationId, input, scope).catch(
					(error: unknown) => {
						if (
							!modelSelectionMountedRef.current ||
							modelSelectionScopeRef.current !== scope ||
							convIdRef.current !== conversationId
						) {
							return;
						}
						toast.error(
							error instanceof Error
								? error.message
								: "Could not share this model choice."
						);
					}
				);
			}
		},
		[persistModelSelection]
	);

	const handleModelChange = useCallback(
		(modelId: string) => {
			const option = modelOptions.find((candidate) => candidate.id === modelId);
			if (modelId !== selectedModelRef.current) {
				warnModelSwitchCacheReset(option?.name ?? modelId);
			}
			setModelSelectionCleared(false);
			setSelectedModel(modelId);
			setProviderModelSelection(null);
			if (agentId) {
				setAgentModel(agentId, modelId);
			}
			queueModelSelectionChange({
				changeId: crypto.randomUUID(),
				kind: "change",
				modelId,
				modelLabel: option?.name ?? modelId,
				providerId: null,
				providerLabel: null,
			});
			announceComposerSelection("Model", modelId);
		},
		[
			agentId,
			announceComposerSelection,
			modelOptions,
			queueModelSelectionChange,
			warnModelSwitchCacheReset,
		]
	);

	const handleProviderModelSelection = useCallback(
		(selection: {
			modelId: string | null;
			providerId: string;
			providerLabel: string;
		}) => {
			if (selection.modelId && selection.modelId !== selectedModelRef.current) {
				warnModelSwitchCacheReset(
					`${selection.providerLabel} · ${selection.modelId}`
				);
			}
			setProviderModelSelection({
				modelId: selection.modelId,
				providerId: selection.providerId,
				providerLabel: selection.providerLabel,
			});
			setSelectedModel(selection.modelId);
			setModelSelectionCleared(selection.modelId === null);
			queueModelSelectionChange({
				changeId: crypto.randomUUID(),
				kind: "change",
				modelId: selection.modelId,
				modelLabel: selection.modelId,
				providerId: selection.providerId,
				providerLabel: selection.providerLabel,
			});
			announceComposerSelection(
				"Provider",
				selection.modelId
					? `${selection.providerLabel} · ${selection.modelId}`
					: selection.providerLabel
			);
		},
		[
			announceComposerSelection,
			queueModelSelectionChange,
			warnModelSwitchCacheReset,
		]
	);

	// ── ACP session controls (Zed-style, data-driven per active agent) ──
	// The agent's advertised Model + Thinking/approval + config selectors, plus the
	// effective per-turn selections, come from the ONE shared hook the launchpad and
	// Ask Ryu dock also use — so every composer's dropdown is identical (and shows
	// them even before a chat exists). Selections persist per agent and ride each
	// turn's request body; Core re-applies them via set_mode / set_config_option /
	// set_model. `modelSection`/`extraSections` feed the composer's settings menu.
	// An agent-INITIATED permission-mode switch seen on the live stream (Core's
	// `data-ryu-acp-mode` part). Derived from `messages` further below and fed
	// back into the composer hook so the Approval picker reflects a mode the
	// agent changed on its own — not only the user's clicks.
	const [streamedAcpMode, setStreamedAcpMode] = useState<string | null>(null);
	// The emission's `messageId:partIndex`, so the composer adopts a new
	// emission of the same mode (another agent switching to it) as a change.
	const [streamedAcpModeKey, setStreamedAcpModeKey] = useState<string | null>(
		null
	);
	// The same shape one level up: session CONFIG values the agent asked the client
	// to update (Core's `data-ryu-acp-config` part). Derived from `messages` below
	// and fed back into the composer hook, which adopts and persists them — so a
	// pick the agent's own action invalidated stops being re-sent next turn. The
	// emission `key` rides along so both sides dedupe on the PART, not the value.
	const [streamedAcpConfig, setStreamedAcpConfig] =
		useState<StreamedAcpConfig | null>(null);
	// Accepted agent-level model/effort controls are conversation-scoped. They
	// feed the shared ACP picker state without mutating the agent's saved defaults.
	const [streamedAcpControl, setStreamedAcpControl] =
		useState<StreamedAcpControl | null>(null);
	// The agent's config option DEFINITIONS as re-published against the LIVE
	// session (Core's `data-ryu-acp-config-options` part) — the answer to
	// `session/set_config_option`, which by protocol returns the whole refreshed
	// set. Distinct from `streamedAcpConfig`, which carries option VALUES.
	//
	// This is the only way an option that exists solely for another option's value
	// (codex reveals its reasoning `effort` list once a model that has one is
	// picked) can reach the pickers against the real session: the probe that
	// otherwise supplies them runs in a throwaway session of its own.
	const [streamedAcpConfigOptions, setStreamedAcpConfigOptions] = useState<
		AcpConfigOption[] | null
	>(null);

	// Changing Approval / Model / Thinking mid-chat is sticky: the pick rides the
	// next request body and Core re-applies it to the live ACP session before that
	// turn's prompt (`apply_turn_config`). The busy-only toast closes the gap where
	// nothing on screen moves, while keeping idle picker changes quiet. One fixed
	// toast slot means dragging the thinking slider replaces in place instead of
	// stacking a toast per detent.
	const handleAcpSelectionApplied = useCallback(
		(setting: string, value: string) => {
			// The shared ACP picker only notifies "Model" for a real change.
			if (setting === "Model") {
				warnModelSwitchCacheReset(value);
			}
			announceComposerSelection(setting, value);
		},
		[announceComposerSelection, warnModelSwitchCacheReset]
	);

	const acp = useComposerAcpSections({
		agentId,
		agents,
		modelOptions,
		engineModel: effectiveModel,
		onEngineModelChange: handleModelChange,
		onSelectionApplied: handleAcpSelectionApplied,
		preferSimpleApprovalDefaults: interfaceLevel === "simple",
		streamedMode: streamedAcpMode,
		streamedModeKey: streamedAcpModeKey,
		streamedConfig: streamedAcpConfig,
		streamedConfigOptions: streamedAcpConfigOptions,
		streamedControl: streamedAcpControl,
	});

	// Effective ACP selections for the request body, held in refs so the send path
	// reads current values without re-identifying the memoized composer slot. The
	// hook already nulls acp_mode when a category:"mode" config option owns it.
	const acpModeRef = useRef(acp.acpMode);
	acpModeRef.current = acp.acpMode;
	const acpModelRef = useRef(acp.acpModel);
	acpModelRef.current = acp.acpModel;
	const acpOptionValuesRef = useRef(acp.acpOptionValues);
	acpOptionValuesRef.current = acp.acpOptionValues;
	const simpleApprovalDefaultsRef = useRef(acp.simpleApprovalDefaults);
	simpleApprovalDefaultsRef.current = acp.simpleApprovalDefaults;

	// Fetch tool names for the selected agent so we can render tool chips below
	// the composer. Uses the lightweight full-record fetch (tools[] is not on the
	// summary). Clears on deselect and re-fetches when the agent changes.
	const activeNodeForTools = useActiveNode();
	useEffect(() => {
		if (!agentId) {
			setAgentTools([]);
			return;
		}
		let cancelled = false;
		const toolTarget: ApiTarget = {
			url: activeNodeForTools.url,
			token: activeNodeForTools.token ?? null,
			userJwt: activeNodeForTools.userJwt ?? null,
		};
		fetchAgent(toolTarget, agentId)
			.then((agent) => {
				if (!cancelled) {
					setAgentTools(agent.tools ?? []);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setAgentTools([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, activeNodeForTools.url, activeNodeForTools.token]);
	return {
		convId,
		setConvId,
		draftConvId,
		convIdRef,
		persistModelSelection,
		handleModelChange,
		handleProviderModelSelection,
		setStreamedAcpMode,
		setStreamedAcpModeKey,
		setStreamedAcpConfig,
		setStreamedAcpControl,
		setStreamedAcpConfigOptions,
		acp,
		acpModeRef,
		acpModelRef,
		acpOptionValuesRef,
		simpleApprovalDefaultsRef,
	} as const;
}
