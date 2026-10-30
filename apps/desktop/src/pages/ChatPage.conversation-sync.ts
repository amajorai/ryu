import { type GoalState, getGoal } from "@ryuhq/core-client/goals.ts";
import { createRealtimeClientId } from "@ryuhq/core-client/realtime.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchParticipants } from "@/src/lib/api/agents.ts";
import { getConversationModelSelection } from "@/src/lib/api/conversation-model-selection.ts";
import {
	getModelContextWindow,
	getModelLaunchConfig,
} from "@/src/lib/api/inference.ts";
import {
	getVoiceInputPrefs,
	subscribePreferenceChanges,
	VOICE_PREF_KEY,
} from "@/src/lib/api/preferences.ts";
import { transcribeAudio } from "@/src/lib/api/voice.ts";
import { getAgentModel } from "@/src/lib/models.ts";
import { useChatTranscriptOwner } from "../lib/use-chat-transcript-owner.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import {
	mergeContextHandoffs,
	mergeConversationModelChanges,
} from "./ChatPage.helpers.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatConversationSyncInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState>;

/** Thread hierarchy, context size, voice input, and the model-history and goal state sync. */
export function useChatConversationSync({
	chatTarget,
	convId,
	conversations,
	agents,
	openTab,
	tabBoundNodeName,
	composerBlocked,
	acpAgent,
	acp,
	effectiveModel,
	setParticipants,
	longTermMemory,
	draftConvId,
	modelSelectionScope,
	pendingModelSelectionRef,
	conversationModelChangesRef,
	setConversationModelChanges,
	contextHandoffsRef,
	setContextHandoffs,
	setProviderModelSelection,
	setSelectedModel,
	agentId,
	setModelSelectionCleared,
	modelSelectionScopeRef,
	modelSelectionMountedRef,
	setModelHistoryReady,
	initialModel,
}: UseChatConversationSyncInput) {
	// Voice input: a stable transcribe fn (reads the live node target via a ref)
	// passed into the composer's mic button. Stable identity keeps the memoized
	// InputBar slot from remounting and dropping textarea focus.
	const chatTargetRef = useRef(chatTarget);

	// Projects › Bots/Groups › Sessions: the thread in view, when it sits in the
	// hierarchy (in a project, a main thread, or a spawned session). The bar
	// itself decides whether there is anything to show.
	const hierarchyConversation = useMemo(() => {
		if (!convId) {
			return null;
		}
		const current = conversations.find((item) => item.id === convId);
		return current?.hierarchy ? current : null;
	}, [conversations, convId]);
	const agentNameForId = useCallback(
		(id: string) => agents.find((agent) => agent.id === id)?.name,
		[agents]
	);
	const openHierarchyConversation = useCallback(
		(conversationId: string, title?: string) =>
			openTab("/chat", { conversationId, title, node: tabBoundNodeName }),
		[openTab, tabBoundNodeName]
	);
	chatTargetRef.current = chatTarget;
	const composerBlockedRef = useRef(false);
	composerBlockedRef.current = composerBlocked;

	// Active model's context window (tokens), used as the denominator for the
	// per-message context-usage ring in each assistant turn's stats footer.
	// Resolved from the model's launch config; `undefined` (auto / unknown) ⇒
	// no ring, mirroring Jan's "hide when n_ctx unknown". Keyed on the primitive
	// model id (not the `chatTarget` object) to avoid a deps-driven render loop.
	//
	// An ACP agent runs its own model, not the engine catalog's, so its window
	// (and its prompt-cache lifetime) is looked up from the agent's selected model.
	// That matters for agents that never report a window themselves (gemini-cli).
	const cacheModelHint = acpAgent
		? (acp.acpModel ?? effectiveModel)
		: effectiveModel;
	const [contextSize, setContextSize] = useState<number | undefined>(undefined);
	useEffect(() => {
		if (!cacheModelHint) {
			setContextSize(undefined);
			return;
		}
		let cancelled = false;
		(async () => {
			const target = chatTargetRef.current;
			const cfg = await getModelLaunchConfig(target, cacheModelHint);
			if (cancelled) {
				return;
			}
			if (cfg.ctx_size && cfg.ctx_size > 0) {
				setContextSize(cfg.ctx_size);
				return;
			}
			// ACP / cloud models: local launch config has no ctx_size — resolve
			// from models.dev so the composer's context ring has a denominator.
			const fromCatalog = await getModelContextWindow(target, cacheModelHint);
			if (!cancelled) {
				setContextSize(
					fromCatalog && fromCatalog > 0 ? fromCatalog : undefined
				);
			}
		})().catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [cacheModelHint]);
	const [voiceInputEngine, setVoiceInputEngine] = useState<
		string | undefined
	>();
	useEffect(() => {
		let cancelled = false;
		const load = () => {
			getVoiceInputPrefs(chatTarget)
				.then((prefs) => {
					if (!cancelled) {
						setVoiceInputEngine(prefs.engine);
					}
				})
				.catch(() => undefined);
		};
		load();
		const unsubscribe = subscribePreferenceChanges((key) => {
			if (key === VOICE_PREF_KEY) {
				load();
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [chatTarget]);
	const voiceTranscribe = useCallback(
		(audio: Blob) =>
			transcribeAudio(
				chatTargetRef.current,
				audio,
				"recording.wav",
				voiceInputEngine
			),
		[voiceInputEngine]
	);

	// #415: Load the conversation's participants so assistant messages can still be
	// labelled per-agent. (The in-composer "add agent" control was removed in favour
	// of agent groups, but legacy multi-agent conversations keep their attribution.)
	useEffect(() => {
		if (!convId) {
			setParticipants([]);
			return;
		}
		let cancelled = false;
		fetchParticipants(chatTarget, convId).then((list) => {
			if (!cancelled) {
				setParticipants(list);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [convId, chatTarget]);

	// Keep the latest opt-in value reachable from the transport body closure,
	// which is created once and would otherwise capture a stale value.
	const longTermMemoryRef = useRef(longTermMemory);
	useEffect(() => {
		longTermMemoryRef.current = longTermMemory;
		localStorage.setItem("ryu_long_term_memory", String(longTermMemory));
	}, [longTermMemory]);

	const chatId = convId ?? draftConvId.current;
	const { sdkId: transcriptId, isCurrent: isTranscriptCurrent } =
		useChatTranscriptOwner(chatTarget, chatId);
	const realtimeClientIdRef = useRef(createRealtimeClientId());
	const modelHistoryConversationRef = useRef(convId);
	const modelHistoryScopeRef = useRef(modelSelectionScope);
	useEffect(() => {
		const scopeChanged = modelHistoryScopeRef.current !== modelSelectionScope;
		modelHistoryScopeRef.current = modelSelectionScope;
		if (
			scopeChanged &&
			pendingModelSelectionRef.current?.scope !== modelSelectionScope
		) {
			pendingModelSelectionRef.current = null;
		}
		const previousConversationId = modelHistoryConversationRef.current;
		modelHistoryConversationRef.current = convId;
		const isDraftPromotion = convId !== null && convId === draftConvId.current;
		if (!convId) {
			conversationModelChangesRef.current = [];
			setConversationModelChanges([]);
			contextHandoffsRef.current = [];
			setContextHandoffs([]);
			setProviderModelSelection(null);
			if (previousConversationId !== null) {
				setSelectedModel(initialModel ?? getAgentModel(agentId));
				setModelSelectionCleared(false);
			}
			return;
		}

		if (
			scopeChanged ||
			(previousConversationId !== convId && !isDraftPromotion)
		) {
			conversationModelChangesRef.current = [];
			setConversationModelChanges([]);
			contextHandoffsRef.current = [];
			setContextHandoffs([]);
			setProviderModelSelection(null);
			setSelectedModel(initialModel ?? getAgentModel(agentId));
			setModelSelectionCleared(false);
		}

		let cancelled = false;
		getConversationModelSelection(chatTarget, convId)
			.then((selection) => {
				if (
					cancelled ||
					modelSelectionScopeRef.current !== modelSelectionScope
				) {
					return;
				}
				const merged = mergeConversationModelChanges(
					conversationModelChangesRef.current,
					selection.changes
				);
				conversationModelChangesRef.current = merged;
				setConversationModelChanges(merged);
				const handoffs = mergeContextHandoffs(
					contextHandoffsRef.current,
					selection.handoffs
				);
				contextHandoffsRef.current = handoffs;
				setContextHandoffs(handoffs);
				if (!selection.current) {
					return;
				}
				setProviderModelSelection(
					selection.current.providerId
						? {
								modelId: selection.current.modelId,
								providerId: selection.current.providerId,
								providerLabel: selection.current.providerLabel,
							}
						: null
				);
				setSelectedModel(selection.current.modelId);
				setModelSelectionCleared(selection.current.modelId === null);
			})
			.catch(() => {
				// A newly-created conversation may not exist until its first turn lands.
			})
			.finally(() => {
				if (
					!cancelled &&
					modelSelectionMountedRef.current &&
					modelSelectionScopeRef.current === modelSelectionScope
				) {
					setModelHistoryReady({
						conversationId: convId,
						scope: modelSelectionScope,
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, chatTarget, convId, initialModel, modelSelectionScope]);

	// #403: Tracks user messages that were blocked so they still appear in the
	// thread even when the send is prevented.
	const [blockedMessages, setBlockedMessages] = useState<
		Array<{ id: string; content: string; timestamp: number }>
	>([]);

	// ── Goal + Double-check are now plugins (io.ryu.goal / io.ryu.double-check) ──
	// driven by the Core plugin turn-hook runtime. The goal loop runs server-side
	// (type `/goal <condition>` in chat; the plugin parses + pursues it), and the
	// double-check review streams back as a `data-plugin_note` part. The desktop
	// carries no plugin-specific composer state: double-check is a plain composer
	// control contributed by its plugin manifest, so it flows through the generic
	// `pluginFlags` map below like every other composer toggle.
	const [goalState, setGoalState] = useState<GoalState | null>(null);
	const [goalDraftOpen, setGoalDraftOpen] = useState(false);
	const [goalCompletionMessageId, setGoalCompletionMessageId] = useState<
		string | null
	>(null);

	useEffect(() => {
		if (!convId) {
			setGoalState(null);
			setGoalCompletionMessageId(null);
			return;
		}
		let cancelled = false;
		getGoal(chatTarget, convId)
			.then((next) => {
				if (!cancelled) {
					setGoalState(next.goal ? next : null);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setGoalState(null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [chatTarget, convId]);
	return {
		chatTargetRef,
		hierarchyConversation,
		agentNameForId,
		openHierarchyConversation,
		composerBlockedRef,
		cacheModelHint,
		contextSize,
		voiceInputEngine,
		voiceTranscribe,
		longTermMemoryRef,
		chatId,
		transcriptId,
		isTranscriptCurrent,
		realtimeClientIdRef,
		blockedMessages,
		setBlockedMessages,
		goalState,
		setGoalState,
		goalDraftOpen,
		setGoalDraftOpen,
		goalCompletionMessageId,
		setGoalCompletionMessageId,
	} as const;
}
