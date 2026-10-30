import { modelContextParts } from "@ryu/app-host/model-context";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useLayoutEffect, useRef } from "react";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import { accountJwtForTarget } from "@/src/lib/api/client.ts";
import {
	parseConversationContextHandoff,
	type RecordConversationModelSelectionInput,
} from "@/src/lib/api/conversation-model-selection.ts";
import {
	modelRoutingFieldsForInterface,
	responseModeForInterface,
} from "@/src/lib/chat-routing.ts";
import { cloudTaskRequestFields } from "@/src/lib/cloud-task-selection.ts";
import { instrumentedFetch } from "@/src/lib/dev-metrics.ts";
import { mentionedMcpResources } from "@/src/lib/mentions/mcp-resources.ts";
import { reportTemplateUse } from "@/src/lib/template-rewards.ts";
import { findWorkspaceProject } from "@/src/lib/workspace-projects.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	useOwnedChatMessages,
	useStopReplacedChat,
} from "../lib/use-chat-transcript-owner.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import {
	ACTIVE_TAB_STREAM_THROTTLE_MS,
	BACKGROUND_TAB_STREAM_THROTTLE_MS,
	buildPluginFlags,
	mergeContextHandoffs,
} from "./ChatPage.helpers.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import { useChatSession } from "./ChatPage.session.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatTransportInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags>;

/** The AI SDK chat transport and the transcript messages this tab owns. */
export function useChatTransport({
	transcriptId,
	isActiveTab,
	chatTarget,
	convIdRef,
	draftConvId,
	remoteMentionItemsRef,
	realtimeClientIdRef,
	cloudSelectionRef,
	agentId,
	boxBackendEnabledRef,
	teamIdRef,
	composerTeamIdRef,
	workflowIdRef,
	targetAgentIdRef,
	chatFolderRef,
	lastAgentFoldersRef,
	skipNextUserAppendRef,
	pendingActionFlagsRef,
	referencedConversationIdsRef,
	pendingModelSelectionRef,
	modelSelectionScopeRef,
	interfaceLevel,
	selectedModelRef,
	acpModeRef,
	acpOptionValuesRef,
	acpModelRef,
	simpleApprovalDefaultsRef,
	ghostModeRef,
	conversationModelChangesRef,
	providerModelSelectionRef,
	modelOptions,
	longTermMemoryRef,
	pluginFlagsRef,
	contextHandoffsRef,
	setContextHandoffs,
	tabWorktreeMode,
	isTranscriptCurrent,
	chatSearch,
}: UseChatTransportInput) {
	// `useChat` reads `transport` only when it creates its Chat, which happens
	// once per transcript id, so the transport is built once per id instead of
	// on every render (every streamed token re-renders this hook). Its request
	// callbacks read the values that can change under a live transcript from
	// this ref, so a send always carries the current agent, interface level,
	// model list and worktree mode rather than the ones of the render that
	// created the Chat. The stream URL stays per id: the id names its target.
	const latestRequestInputs = useRef({
		agentId,
		chatTarget,
		interfaceLevel,
		modelOptions,
		tabWorktreeMode,
	});
	latestRequestInputs.current = {
		agentId,
		chatTarget,
		interfaceLevel,
		modelOptions,
		tabWorktreeMode,
	};
	const transportRef = useRef<{
		id: typeof transcriptId;
		transport: DefaultChatTransport<UIMessage>;
	} | null>(null);
	if (!transportRef.current || transportRef.current.id !== transcriptId) {
		transportRef.current = {
			id: transcriptId,
			transport: new DefaultChatTransport({
				prepareSendMessagesRequest: ({ messages: outgoing, body }) => {
					const { chatTarget } = latestRequestInputs.current;
					const context = modelContextParts(
						`${chatTarget.url}:${convIdRef.current ?? draftConvId.current}`
					);
					let latestUser = -1;
					for (const [index, message] of outgoing.entries()) {
						if (message.role === "user") {
							latestUser = index;
						}
					}
					const last = outgoing[latestUser];
					const text =
						last?.parts
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n") ?? "";
					const resources = mentionedMcpResources(
						text,
						remoteMentionItemsRef.current
					);
					if (resources.length > 0) {
						context.push({
							type: "text",
							text: `<app-resources>\n${resources.join("\n")}\n</app-resources>`,
						});
					}
					return {
						body: {
							...body,
							messages: outgoing.map((message, index) =>
								index === latestUser && context.length > 0
									? { ...message, parts: [...message.parts, ...context] }
									: message
							),
						},
					};
				},
				api: chatStreamUrl(chatTarget),
				// Developer-mode turn timing (time-to-first-token, stream duration,
				// bytes). A plain `fetch` when metrics are off — see lib/dev-metrics.ts.
				fetch: instrumentedFetch,
				// Forward the user-identity JWT alongside the node token so Core can
				// verify WHO sent this turn and stamp `author_user_id` on the persisted
				// message — the value the realtime fan-out uses to attribute it to a
				// human for other viewers. `null` when signed out, when the node has
				// no token or managed delegation, or when it is reached over plain
				// HTTP on another host: no header, anonymous turn (author stays NULL),
				// single-user flow unchanged.
				headers: async () => {
					const { chatTarget } = latestRequestInputs.current;
					const base = chatHeaders(chatTarget);
					const jwt = await accountJwtForTarget(chatTarget);
					const identityHeaders = realtimeClientIdRef.current
						? { ...base, "X-Ryu-Client-Id": realtimeClientIdRef.current }
						: base;
					return jwt
						? { ...identityHeaders, "X-Ryu-User-Jwt": jwt }
						: identityHeaders;
				},
				body: () => {
					const { agentId, interfaceLevel, modelOptions, tabWorktreeMode } =
						latestRequestInputs.current;
					const cloudFields = cloudTaskRequestFields(
						cloudSelectionRef.current,
						agentId,
						{ boxBackendEnabled: boxBackendEnabledRef.current }
					);
					const cloudTask = Boolean(cloudFields.cloudEnvironmentId);
					if (
						cloudTask &&
						(teamIdRef.current ||
							composerTeamIdRef.current ||
							workflowIdRef.current ||
							targetAgentIdRef.current)
					) {
						throw new Error(
							"Cloud tasks currently support the Ryu native agent only, without teams, workflows, or custom agent targets."
						);
					}
					const ws = useWorkspaceStore.getState();
					const selectedFolder = chatFolderRef.current;
					const project = selectedFolder
						? findWorkspaceProject(ws.projects, selectedFolder)
						: undefined;
					const cwd = project?.folders[0] ?? selectedFolder ?? undefined;
					const sourceFolders = project?.folders ?? (cwd ? [cwd] : []);
					lastAgentFoldersRef.current = sourceFolders;
					const environmentId = cwd
						? ws.activeProjectEnvironments[cwd]
						: undefined;
					const projectEnvironment = cwd
						? ws.projectEnvironments[cwd]?.find(
								(environment) => environment.id === environmentId
							)
						: undefined;
					// Consume the one-shot skip flag: read then immediately reset so it
					// applies to exactly this request (the edit/regenerate re-run) and no
					// subsequent normal send.
					const skipUserAppend = skipNextUserAppendRef.current;
					skipNextUserAppendRef.current = false;
					// Same consume-once treatment for the flags an `action` composer
					// control marked when it fired: they belong to this turn, and leaving
					// them set would make the owning plugin's hook act on every later one.
					const firedActionFlags = pendingActionFlagsRef.current;
					pendingActionFlagsRef.current = {};
					const referencedConversationIds =
						referencedConversationIdsRef.current;
					referencedConversationIdsRef.current = [];
					const outgoingConversationId =
						convIdRef.current ?? draftConvId.current;
					const pendingModelSelection = pendingModelSelectionRef.current;
					if (
						pendingModelSelection?.scope === modelSelectionScopeRef.current &&
						pendingModelSelection.conversationId === null &&
						pendingModelSelection.draftConversationId === outgoingConversationId
					) {
						pendingModelSelectionRef.current = {
							...pendingModelSelection,
							conversationId: outgoingConversationId,
						};
					}
					// Persistent-session worktree: opt-in via the workspace bar's run
					// mode (not auto-on per folder). When enabled, Core creates an
					// isolated worktree on the first message and reuses it across turns,
					// capturing the aggregate diff (fetched by DiffReviewPane).
					const useWorktree =
						tabWorktreeMode ?? (Boolean(cwd) && ws.worktreeMode);
					const routingFields = modelRoutingFieldsForInterface(interfaceLevel, {
						model: selectedModelRef.current,
						acpMode: acpModeRef.current,
						acpConfig: acpOptionValuesRef.current,
						acpModel: acpModelRef.current,
						simpleApprovalDefaults: simpleApprovalDefaultsRef.current,
					});
					const pendingForConversation = pendingModelSelectionRef.current;
					const hasPendingSelectionForConversation =
						pendingForConversation?.scope === modelSelectionScopeRef.current &&
						(pendingForConversation.conversationId === outgoingConversationId ||
							pendingForConversation.draftConversationId ===
								outgoingConversationId);
					if (
						!(ghostModeRef.current || hasPendingSelectionForConversation) &&
						conversationModelChangesRef.current.length === 0
					) {
						const modelId =
							routingFields.model ?? routingFields.acp_model ?? null;
						const providerSelection = providerModelSelectionRef.current;
						const modelOption = modelId
							? modelOptions.find((option) => option.id === modelId)
							: undefined;
						const initialSelection: RecordConversationModelSelectionInput = {
							changeId: crypto.randomUUID(),
							kind: "initial",
							modelId,
							modelLabel: modelOption?.name ?? modelId,
							providerId: providerSelection?.providerId ?? null,
							providerLabel: providerSelection?.providerLabel ?? null,
						};
						pendingModelSelectionRef.current = {
							...initialSelection,
							scope: modelSelectionScopeRef.current,
							conversationId: outgoingConversationId,
							draftConversationId: outgoingConversationId,
						};
					}
					// Template Rewards pilot: a temporary chat leaves no usage trace, and
					// a workflow turn is not a use of the agent template itself.
					if (!(ghostModeRef.current || workflowIdRef.current)) {
						reportTemplateUse(agentId);
					}
					return {
						...cloudFields,
						agent_id: agentId,
						response_mode: responseModeForInterface(interfaceLevel),
						conversation_id: outgoingConversationId,
						referenced_conversation_ids:
							referencedConversationIds.length > 0
								? referencedConversationIds
								: undefined,
						// A temporary chat must leave no durable trace, so it never
						// records the turn into long-term cross-session memory — regardless of
						// the user's standing long-term-memory preference.
						enable_long_term: ghostModeRef.current
							? false
							: longTermMemoryRef.current,
						cwd: cloudTask ? undefined : cwd,
						workspace_folders:
							!cloudTask && sourceFolders.length > 1
								? sourceFolders
								: undefined,
						worktree_isolation: cloudTask ? false : useWorktree,
						// Desired branch for the worktree Core creates on the first turn
						// (sanitized server-side; ignored when reusing an existing one).
						worktree_branch:
							!cloudTask && useWorktree ? ws.worktreeBranch : undefined,
						project_environment:
							projectEnvironment && !cloudTask
								? {
										name: projectEnvironment.name,
										variables: projectEnvironment.variables.map(
											({ key, value }) => ({
												key,
												value,
											})
										),
									}
								: undefined,
						// #415: Pass the @mention target agent id when the user directed the
						// message at a specific conversation participant.
						target_agent_id: targetAgentIdRef.current ?? undefined,
						// When the user @-mentioned a team, Core fans out to its members.
						// The transient mention wins for one send; otherwise the persistent
						// composer team pick applies.
						team_id:
							teamIdRef.current ?? composerTeamIdRef.current ?? undefined,
						// When the user @-mentioned a workflow, Core runs it with this
						// message as its chat input. Resets after each send. A workflow
						// target is the most specific intent, so it is sent alongside
						// (Core's `workflow_id` branch ignores agent/team).
						workflow_id: workflowIdRef.current ?? undefined,
						// Ryu Work keeps the chosen agent visible but lets Core own model
						// routing. Code sends the user's explicit model/ACP controls.
						...routingFields,
						// Per-request plugin flags (every plugin-contributed composer toggle,
						// double-check included). The plugin turn-hook runtime passes these to
						// each hook; a plugin acts only when its flag is set.
						plugin_flags: buildPluginFlags({
							...pluginFlagsRef.current,
							...firedActionFlags,
						}),
						// Temporary chat: never write this turn to the conversation
						// store. Omitted otherwise so Core applies its default (persist=true).
						persist: ghostModeRef.current ? false : undefined,
						// Version-tree edit/regenerate re-run: the edited user sibling is
						// already persisted (edit route) or a regenerate carries no new user
						// turn, so Core must not re-append the trailing user message. The ref
						// is set true just before the regenerate() trigger and consumed here.
						skip_user_append: skipUserAppend || undefined,
					};
				},
			}),
		};
	}
	const {
		chatSession,
		messages,
		sendMessage,
		setMessages: setSdkMessages,
		regenerate,
		stop,
		status,
		error,
		clearError,
	} = useChatSession({
		id: transcriptId,
		// Coalesce stream chunks into at most one transcript render per window.
		// Unthrottled, every SSE chunk re-renders (and re-parses markdown for) the
		// transcript, in every busy tab; background tabs stay mounted while
		// streaming, so parallel threads multiply that cost.
		throttle: isActiveTab
			? ACTIVE_TAB_STREAM_THROTTLE_MS
			: BACKGROUND_TAB_STREAM_THROTTLE_MS,
		transport: transportRef.current.transport,
		// Core announces the handoff a turn runs on as a transient data part, so
		// the transcript marker shows as the turn starts, realtime or not.
		onData: (part) => {
			if (part.type !== "data-ryu-context-handoff") {
				return;
			}
			const handoff = parseConversationContextHandoff(part.data);
			if (!handoff) {
				return;
			}
			const handoffs = mergeContextHandoffs(contextHandoffsRef.current, [
				handoff,
			]);
			contextHandoffsRef.current = handoffs;
			setContextHandoffs(handoffs);
		},
	});
	// Find in chat searches the text as it streams, so while it is open the
	// page follows every text delta as well.
	const followStreamedText = chatSearch.open && chatSearch.mode === "chat";
	useLayoutEffect(() => {
		chatSession.setFollowText(followStreamedText);
	}, [chatSession, followStreamedText]);

	useStopReplacedChat(stop);

	// SDK setMessages is stable and writes through its current Chat ref. Bind
	// every async producer to the owner that started it so an old history/tool
	// result cannot write into a replacement authority's transcript.
	const setMessages = useOwnedChatMessages(isTranscriptCurrent, setSdkMessages);
	return {
		chatSession,
		messages,
		sendMessage,
		regenerate,
		stop,
		status,
		error,
		clearError,
		setMessages,
	} as const;
}
