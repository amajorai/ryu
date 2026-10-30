import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useRef } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { SUBSCRIPTION_RUN_QUERY_KEY } from "@/src/components/chat/SubscriptionRunPanel.tsx";
import { CLOUD_TASK_QUERY_KEY } from "@/src/hooks/useCloudTask.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import { startCloudTaskPrompt } from "@/src/lib/api/cloud-tasks.ts";
import { TEMPORARY_CONTEXT_FLAG } from "@/src/lib/api/temporary-chat.ts";
import {
	backendPromptFields,
	useCloudTaskBackendChoices,
} from "@/src/lib/cloud-task-backend-choice.ts";
import {
	cloudTaskBlockReason,
	managedCloudExecutor,
	useCloudTaskSelections,
} from "@/src/lib/cloud-task-selection.ts";
import { browserProviderHost } from "@/src/lib/extension-host.ts";
import { messageNeedsWorkspace } from "@/src/lib/workspace-intent.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatPresence } from "./ChatPage.presence.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatSendInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatPresence>;

/** Sending a message. */
export function useChatSend({
	boxBackendEnabled,
	cloudSelectionRef,
	agentId,
	attachmentRef,
	ghostChatActive,
	composerBlocked,
	setBlockedMessages,
	chatFolderRef,
	setPendingWorkspaceMessage,
	browserSnapshot,
	forceCoreNextRef,
	pluginFlagsRef,
	convIdRef,
	draftConvId,
	setConvId,
	setActiveConversationId,
	chatSession,
	setMessages,
	browserLocalAbortRef,
	handleSendRef,
	cloudScopeRef,
	convId,
	createConversation,
	setConversationFolder,
	seedTitleFromFirstMessage,
	chatTarget,
	targetAgentIdRef,
	participants,
	queryClient,
	stopTyping,
	agents,
	agentLabelMapRef,
	sendMessage,
	setAttachedImages,
	teamIdRef,
	workflowIdRef,
}: UseChatSendInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const handleSend = useCallback(
		(message: {
			attachments?: AttachedImage[];
			content: string;
			role: "user";
		}) => {
			// #403: Always surface the user's message even when blocked, so it's never
			// silently dropped. If chat is blocked, record it in blockedMessages so the
			// UI can render it with an error state.
			const cloudGate = { boxBackendEnabled };
			const cloudReason = cloudTaskBlockReason(
				cloudSelectionRef.current,
				agentId,
				cloudGate
			);
			if (cloudReason) {
				toast.error(cloudReason);
				return;
			}
			// A managed CLI agent (Claude Code, Codex, ...) runs in a fresh cloud box
			// through Core's prompt route, not the chat stream; it takes text only.
			const managedExecutor = managedCloudExecutor(
				cloudSelectionRef.current,
				cloudGate
			);
			if (managedExecutor) {
				const pendingImages =
					message.attachments ?? attachmentRef.current.attachedImages;
				if (pendingImages.length > 0) {
					toast.error("Managed cloud agents take a text prompt only.");
					return;
				}
				if (ghostChatActive) {
					toast.error("Temporary chats cannot run in the cloud.");
					return;
				}
			}
			if (composerBlocked) {
				setBlockedMessages((prev) => [
					...prev,
					{
						id: `blocked-${Date.now()}`,
						content: message.content,
						timestamp: Date.now(),
					},
				]);
				return;
			}
			if (
				cloudSelectionRef.current.mode !== "cloud" &&
				!chatFolderRef.current &&
				messageNeedsWorkspace(message.content)
			) {
				// Keep the submitted message intact while a non-technical user chooses a
				// project. This avoids the old upfront folder gate without allowing a local
				// edit request to run in Core's arbitrary process directory.
				setPendingWorkspaceMessage((current) => current ?? message);
				return;
			}
			const browserModelId =
				browserSnapshot?.currentModelBySurface.dashboard ??
				browserProviderHost.getModelSelection(agentId, "dashboard");
			const browserModel = browserSnapshot?.models.find(
				(model) => model.id === browserModelId
			);
			const browserLocalActive =
				cloudSelectionRef.current.mode !== "cloud" &&
				!forceCoreNextRef.current &&
				browserSnapshot?.activeSurface === "dashboard" &&
				browserSnapshot.activeAgentId === agentId &&
				browserModel?.capabilities.chatSupport === true &&
				!(
					ghostChatActive &&
					pluginFlagsRef.current[TEMPORARY_CONTEXT_FLAG] === true
				) &&
				(message.attachments?.length ?? 0) === 0;
			if (browserLocalActive) {
				forceCoreNextRef.current = false;
				const localConversationId = convIdRef.current ?? draftConvId.current;
				if (!ghostChatActive) {
					setConvId(localConversationId);
					setActiveConversationId(localConversationId);
				}
				const localUserId = `browser-user-${Date.now()}`;
				const localMessages = [
					...chatSession.getLiveMessages().map((item) => ({
						content: item.parts
							.filter(
								(part): part is { text: string; type: "text" } =>
									part.type === "text"
							)
							.map((part) => part.text)
							.join("\n"),
						role: item.role,
					})),
					{ content: message.content, role: "user" as const },
				];
				setMessages((previous) => [
					...previous,
					{
						id: localUserId,
						parts: [{ text: message.content, type: "text" }],
						role: "user",
					},
				]);
				const controller = new AbortController();
				browserLocalAbortRef.current = controller;
				void browserProviderHost
					.runLocalTurn({
						conversationId: localConversationId,
						ghostMode: ghostChatActive,
						messages: localMessages,
						modelId: browserModelId,
						requestId: localUserId,
						signal: controller.signal,
						surface: "dashboard",
					})
					.then((result) => {
						browserLocalAbortRef.current = null;
						if (!result) {
							setMessages((previous) =>
								previous.filter((item) => item.id !== localUserId)
							);
							forceCoreNextRef.current = true;
							handleSendRef.current(message);
							return;
						}
						if (result.text) {
							setMessages((previous) => [
								...previous,
								{
									id: `browser-assistant-${Date.now()}`,
									parts: [{ text: result.text, type: "text" }],
									role: "assistant",
								},
							]);
						}
						if (result.pendingApprovals.length > 0) {
							setMessages((previous) => [
								...previous,
								{
									id: `browser-approval-${Date.now()}`,
									parts: [
										{
											text: result.pendingApprovals
												.map(
													(approval) =>
														`Safe approval needed: ${approval.reason}`
												)
												.join("\n"),
											type: "text",
										},
									],
									role: "assistant",
								},
							]);
						}
					})
					.catch((error) => {
						if (controller.signal.aborted) {
							return;
						}
						browserLocalAbortRef.current = null;
						setMessages((previous) => [
							...previous.filter((item) => item.id !== localUserId),
							{
								id: `browser-fallback-${Date.now()}`,
								parts: [
									{
										text: tlRef.current(
											"Browser engine failed — switching to Core. Retry or choose Browser in Settings. {error}",
											{
												error:
													error instanceof Error
														? error.message
														: String(error),
											}
										),
										type: "text",
									},
								],
								role: "assistant",
							},
						]);
						forceCoreNextRef.current = true;
						handleSendRef.current(message);
					});
				return;
			}
			forceCoreNextRef.current = false;
			// The folder this turn is about to run in — read from the store, exactly
			// as the transport body does a moment later, so the row the sidebar shows
			// and the `cwd` Core stamps onto the conversation are the same value.
			const sendFolder =
				cloudSelectionRef.current.mode === "cloud"
					? undefined
					: (chatFolderRef.current ?? undefined);
			if (cloudScopeRef.current && "locked" in cloudSelectionRef.current) {
				useCloudTaskSelections.getState().setSelection(cloudScopeRef.current, {
					...cloudSelectionRef.current,
					locked: true,
				});
			}
			if (!convId) {
				const newId = draftConvId.current;
				// A temporary chat is never registered in the sidebar history:
				// skip `createConversation` so it leaves no trace in the thread list.
				// The turn still streams (useChat keys off the local id) and Core
				// persists nothing because the transport sends `persist: false`.
				if (!ghostChatActive) {
					createConversation(newId, {
						agentId: agentId ?? undefined,
						folderPath: sendFolder,
					});
				}
				setConvId(newId);
				setActiveConversationId(newId);
			}

			// Chats started in a project belong to that project from their first
			// message, not from whenever the list next refreshes. Core stamps the
			// same folder from this turn's `cwd`; recording it locally is what keeps
			// the row from sitting in the loose "Chats" bucket in the meantime — and
			// it also catches a draft opened before the user switched folders.
			if (!ghostChatActive) {
				const folderTargetId = convIdRef.current ?? draftConvId.current;
				if (folderTargetId) {
					setConversationFolder(folderTargetId, sendFolder);
				}
			}

			// Name the thread after what the user just asked, right now. Core derives
			// the identical title when it persists this turn, so this only removes the
			// wait — without it the row reads "New Chat" for the whole first reply
			// (the list is only re-fetched once the turn completes). The chat-title
			// plugin replaces it with a model-written name after that reply lands.
			// Temporary chats are absent from the list, so the seed is a no-op for them.
			if (!ghostChatActive) {
				const titleTargetId = convIdRef.current ?? draftConvId.current;
				if (titleTargetId) {
					seedTitleFromFirstMessage(titleTargetId, message.content);
				}
			}

			const managedSelection = cloudSelectionRef.current;
			if (
				boxBackendEnabled &&
				managedExecutor &&
				managedSelection.mode === "cloud" &&
				managedSelection.environmentId
			) {
				const cloudConversationId = convIdRef.current ?? draftConvId.current;
				const optimisticId = `cloud-user-${Date.now()}`;
				setMessages((previous) => [
					...previous,
					{
						id: optimisticId,
						parts: [{ text: message.content, type: "text" }],
						role: "user",
					},
				]);
				const backendChoice = cloudScopeRef.current
					? useCloudTaskBackendChoices.getState().choices[cloudScopeRef.current]
					: undefined;
				startCloudTaskPrompt(chatTarget, cloudConversationId, {
					agentId: targetAgentIdRef.current ?? participants[0]?.agentId,
					environmentId: managedSelection.environmentId,
					text: message.content,
					...backendPromptFields(backendChoice),
				})
					.then((accepted) => {
						// A preferred plan was skipped (usage limit, signed out): say so,
						// because the task now runs on a Ryu Box and uses Ryu credits.
						for (const notice of accepted.notices) {
							toast.info(notice.message);
						}
						return Promise.all([
							queryClient.invalidateQueries({
								queryKey: [CLOUD_TASK_QUERY_KEY, chatTarget.url],
							}),
							queryClient.invalidateQueries({
								queryKey: [SUBSCRIPTION_RUN_QUERY_KEY, chatTarget.url],
							}),
						]);
					})
					.catch((error: unknown) => {
						setMessages((previous) =>
							previous.filter((item) => item.id !== optimisticId)
						);
						let reason = "Could not start the cloud agent.";
						if (error instanceof ApiError) {
							reason = error.serverMessage ?? error.message;
						} else if (error instanceof Error) {
							reason = error.message;
						}
						toast.error(reason);
					});
				stopTyping();
				return;
			}

			// #415: Record the targeted agent for this upcoming assistant turn so we
			// can label the response bubble with the right agent name.
			const assistantIdx = chatSession
				.getLiveMessages()
				.filter((m) => m.role === "assistant").length;
			const targetId = targetAgentIdRef.current;
			if (targetId) {
				const targetAgent = agents.find((a) => a.id === targetId);
				if (targetAgent) {
					agentLabelMapRef.current[String(assistantIdx)] = targetAgent.name;
				}
			} else if (participants.length === 1) {
				agentLabelMapRef.current[String(assistantIdx)] = participants[0].name;
			}

			const currentImages =
				message.attachments ?? attachmentRef.current.attachedImages;
			if (currentImages.length > 0) {
				sendMessage({
					text: message.content,
					files: currentImages.map((img) => ({
						type: "file" as const,
						mediaType: img.mimeType ?? "application/octet-stream",
						filename: img.filename,
						url: img.url,
					})),
				});
			} else {
				sendMessage({ text: message.content });
			}
			if (!message.attachments) {
				setAttachedImages([]);
			}
			// Reset after send so the next message starts fresh.
			targetAgentIdRef.current = null;
			teamIdRef.current = null;
			workflowIdRef.current = null;
			// Our turn is sent — clear any lingering "typing" presence immediately.
			stopTyping();
		},
		[
			composerBlocked,
			convId,
			agentId,
			boxBackendEnabled,
			agents,
			participants,
			chatSession,
			ghostChatActive,
			createConversation,
			setConversationFolder,
			seedTitleFromFirstMessage,
			setActiveConversationId,
			sendMessage,
			stopTyping,
			browserSnapshot,
			setMessages,
			chatTarget,
			queryClient,
		]
	);
	handleSendRef.current = handleSend;
	return { handleSend } as const;
}
