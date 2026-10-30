import type { MessageReadReceiptState } from "@ryu/blocks/desktop/agent-elements/message-read-receipt.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { createElement, useCallback, useEffect, useMemo, useRef } from "react";
import type { ChatSearchMode } from "@/src/components/chat/ChatSearchBar.tsx";
import { useChatSearch } from "@/src/hooks/useChatSearch.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
import { createMessageDecorator } from "@/src/lib/chat-message-decoration.ts";
import { appMentionVisual } from "@/src/lib/mentions/app-visuals.tsx";
import {
	buildComposioMentionSources,
	buildMentionGroups,
} from "@/src/lib/mentions/candidates.ts";
import type { SelectedHumanMention } from "@/src/lib/mentions/human-notification.ts";
import type { MentionSources } from "@/src/lib/mentions/types.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatGoals } from "./ChatPage.goals.ts";
import {
	describeContextHandoff,
	messageAuthorId,
	reuseUnchangedReadReceipts,
} from "./ChatPage.helpers.ts";
import {
	useLiveTranscript,
	withBlockedMessages,
} from "./ChatPage.live-transcript.ts";
import {
	type ResolvedMentionItem,
	reuseEqualMentionItems,
} from "./ChatPage.mention-items.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatRealtimeRoom } from "./ChatPage.realtime-room.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatMessagePipelineInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatGoals> &
	ReturnType<typeof useChatRealtimeRoom>;

/** Rendered messages, read receipts, find-in-chat matches, and mention sources. */
export function useChatMessagePipeline({
	blockedMessages,
	chatSession,
	messages,
	messageSentAtRef,
	agentLabelMapRef,
	participants,
	agentId,
	agents,
	merged,
	readReceiptUsers,
	humanMentionDirectory,
	readReceiptsByMessage,
	myUserId,
	oidcUser,
	conversationModelChanges,
	contextHandoffs,
	markReadMessageVisible,
	chatSearch,
	activeChatSearchMatchIndex,
	setActiveChatSearchMatchIndex,
	setChatSearch,
	teams,
	workflows,
	registeredApps,
	conversations,
	convId,
	mentionableResources,
	composioConfigured,
	composioConnections,
	composioToolkits,
	spaces,
	installedSkills,
	mcpServers,
	recentFolders,
	inboxEnabled,
	chatTarget,
}: UseChatMessagePipelineInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	// Active permission requests are rendered by the shared composer surface. The
	// gate is a real `data-ryu-permission` request from Core (the ACP
	// `session/request_permission` seam), never the part's own stream state.
	//
	// The tool row remains transcript history; only the active decision card is
	// allowed to replace the composer, so an approval cannot appear twice.
	// The request that blocks the turn is resolved over `/api/chat/permission`.
	//
	// #403: Synthesise blocked-message entries as visible user messages so they
	// appear in the thread even when not sent. Append them after the real messages.
	const visibleMessages = useMemo(
		() => withBlockedMessages(messages, blockedMessages),
		[messages, blockedMessages]
	);

	const decorateMessages = useMemo(
		() => createMessageDecorator<(typeof visibleMessages)[number]>(),
		[]
	);
	// Reuse settled message/parts identities while the final reply streams.
	const processMessages = useCallback(
		(visible: typeof visibleMessages) =>
			decorateMessages(visible, {
				sentAt: messageSentAtRef.current,
				labels: agentLabelMapRef.current,
				council: participants.length > 1,
				fallbackLabel:
					participants.length > 1 && agentId
						? (agents.find((agent) => agent.id === agentId)?.name ?? null)
						: null,
			}),
		[participants, agentId, agents, decorateMessages]
	);
	const processedMessages = useMemo(
		() => processMessages(visibleMessages),
		[visibleMessages, processMessages]
	);

	// What the transcript actually renders. In the merged agent view the older
	// threads sit above the live one; everything else in this page — the context
	// meter, "does this thread have messages", the transcript copy — deliberately
	// keeps reading `processedMessages`, because those messages are NOT in the
	// model's context and do not belong to the live conversation.
	const renderedMessages = useMemo(
		() =>
			merged.messages.length > 0
				? [...merged.messages, ...processedMessages]
				: processedMessages,
		[merged.messages, processedMessages]
	);
	// The transcript's live view and on-demand reads of the newest messages.
	const { liveTranscriptMessages, readLatestProcessedMessages } =
		useLiveTranscript(chatSession, {
			blockedMessages,
			merged,
			processMessages,
		});
	const committedReadReceiptsRef = useRef<
		ReadonlyMap<string, MessageReadReceiptState>
	>(new Map());
	const messageReadReceiptStates = useMemo<
		ReadonlyMap<string, MessageReadReceiptState>
	>(() => {
		const directory = new Map<string, { avatar?: string; name: string }>();
		for (const user of readReceiptUsers) {
			directory.set(user.id, user);
		}
		for (const user of humanMentionDirectory.users) {
			directory.set(user.id, {
				avatar: user.avatarUrl,
				name: user.name,
			});
		}
		const states = new Map<string, MessageReadReceiptState>();
		for (const [messageId, records] of readReceiptsByMessage) {
			const message = renderedMessages.find(
				(candidate) => candidate.id === messageId
			);
			const authorId = message ? messageAuthorId(message) : null;
			const readers = records
				.map((record) => {
					const knownUser = directory.get(record.userId);
					const name =
						knownUser?.name ??
						record.userName ??
						(record.userId === myUserId
							? oidcUser?.name || oidcUser?.email || "You"
							: "Someone");
					return {
						avatar: knownUser?.avatar,
						id: record.userId,
						name,
					};
				})
				.filter((reader) => reader.id !== authorId);
			if (readers.length > 0) {
				states.set(messageId, { delivered: true, readers });
			}
		}
		return reuseUnchangedReadReceipts(committedReadReceiptsRef.current, states);
	}, [
		humanMentionDirectory.users,
		myUserId,
		oidcUser?.email,
		oidcUser?.name,
		readReceiptsByMessage,
		readReceiptUsers,
		renderedMessages,
	]);
	useEffect(() => {
		committedReadReceiptsRef.current = messageReadReceiptStates;
	}, [messageReadReceiptStates]);
	const conversationModelNotices = useMemo(() => {
		const modelNotices = conversationModelChanges.map((change) => {
			const provider = change.providerLabel ?? change.providerId;
			const model = change.modelLabel ?? change.modelId;
			return {
				at: change.createdAt,
				description:
					provider && model
						? `${provider} · ${model}`
						: provider
							? tlRef.current("{provider} · Provider default", { provider })
							: (model ?? "Automatic model selection"),
				id: `model-change-${change.id}`,
				title:
					change.kind === "initial"
						? "Model used for this conversation"
						: provider
							? "Provider and model changed"
							: "Model changed",
			};
		});
		// Each handoff marker lands right after the change that caused it.
		const handoffNotices = contextHandoffs.map((handoff) => ({
			at: handoff.createdAt,
			description: describeContextHandoff(handoff, tlRef.current),
			id: `context-handoff-${handoff.id}`,
			title: "Context handed off",
		}));
		return [...modelNotices, ...handoffNotices]
			.sort((left, right) => left.at - right.at)
			.map(({ description, id, title }) => ({ description, id, title }));
	}, [contextHandoffs, conversationModelChanges]);
	const handleMessageVisible = useCallback(
		(messageId: string) => {
			const message = renderedMessages.find(
				(candidate) => candidate.id === messageId
			);
			const authorId = message ? messageAuthorId(message) : null;
			if (
				message?.role !== "user" ||
				!myUserId ||
				authorId === null ||
				authorId === myUserId
			) {
				return;
			}
			markReadMessageVisible(messageId);
		},
		[markReadMessageVisible, myUserId, renderedMessages]
	);
	const chatSearchMatches = useChatSearch(
		renderedMessages,
		chatSearch.query,
		chatSearch.mode === "chat" && chatSearch.open
	);
	const activeChatSearchMatch =
		chatSearchMatches[activeChatSearchMatchIndex] ?? null;
	useEffect(() => {
		setActiveChatSearchMatchIndex((current) =>
			chatSearchMatches.length === 0
				? 0
				: Math.min(current, chatSearchMatches.length - 1)
		);
	}, [chatSearchMatches.length]);
	useEffect(() => {
		if (
			!(chatSearch.open && chatSearch.mode === "chat" && activeChatSearchMatch)
		) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			window.dispatchEvent(
				new CustomEvent("ryu:scroll-to-message", {
					detail: { messageId: activeChatSearchMatch.anchorMessageId },
				})
			);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [
		activeChatSearchMatch?.anchorMessageId,
		activeChatSearchMatch?.messageId,
		chatSearch.mode,
		chatSearch.open,
	]);

	const closeChatSearch = useCallback(() => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) => ({
			...current,
			mode: "chat",
			nonce: current.nonce + 1,
			open: false,
			query: "",
		}));
	}, []);
	const changeChatSearchMode = useCallback((mode: ChatSearchMode) => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) =>
			current.mode === mode
				? current
				: { ...current, mode, nonce: current.nonce + 1, open: true }
		);
	}, []);
	const changeChatSearchQuery = useCallback((query: string) => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) => ({ ...current, query, open: true }));
	}, []);
	const nextChatSearchMatch = useCallback(() => {
		setActiveChatSearchMatchIndex((current) =>
			chatSearchMatches.length === 0
				? 0
				: (current + 1) % chatSearchMatches.length
		);
	}, [chatSearchMatches.length]);
	const previousChatSearchMatch = useCallback(() => {
		setActiveChatSearchMatchIndex((current) =>
			chatSearchMatches.length === 0
				? 0
				: (current - 1 + chatSearchMatches.length) % chatSearchMatches.length
		);
	}, [chatSearchMatches.length]);

	// #415: Stable slot reference for the custom InputBar. Using useMemo with an
	// empty dep array so the component identity is stable across renders, avoiding
	// textarea focus loss on every keystroke. Agents are accessed from state
	// through a stable ref pattern inside CouncilInputBar itself.
	const agentsStableRef = useRef(agents);
	agentsStableRef.current = agents;
	const teamsStableRef = useRef(teams);
	teamsStableRef.current = teams;
	const workflowsStableRef = useRef(workflows);
	workflowsStableRef.current = workflows;
	// Aggregate the "@" mention sources into one object, held in a ref so
	// the memoized composer slot stays stable (same pattern as the agent/team
	// refs above). buildMentionGroups filters this per keystroke.
	const mentionSources = useMemo<MentionSources>(() => {
		const enabled = registeredApps.filter((app) => app.enabled);
		const enabledById = new Map(enabled.map((app) => [app.id, app]));
		const toAppMentionSource = (app: (typeof enabled)[number]) => ({
			...appMentionVisual(app),
			description: app.tagline ?? app.description ?? undefined,
			id: app.id,
			name: app.name,
		});
		return {
			agents: agents.map((a) => ({ id: a.id, name: a.name })),
			chats: conversations
				.filter((conversation) => conversation.id !== convId)
				.map((conversation) => ({
					id: conversation.id,
					name: conversation.title,
					description: conversation.lastMessage,
				})),
			apps: enabled
				.filter((app) => app.companion !== null)
				.map(toAppMentionSource),
			appItems: mentionableResources.appItems.map((item) => ({
				...item,
				...appMentionVisual(enabledById.get(item.ownerId ?? "")),
			})),
			integrations: buildComposioMentionSources(
				composioConfigured,
				composioConnections,
				composioToolkits
			),
			teams: teams.map((t) => ({ id: t.id, name: t.name })),
			// Only chat-triggerable workflows (a root Input node, per Core) are
			// offered — a workflow that never reads the typed message would
			// silently ignore it.
			workflows: workflows
				.filter((w) => w.chatInput)
				.map((w) => ({ id: w.id, name: w.name, description: w.description })),
			spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
			pages: mentionableResources.pages,
			outputStyles: mentionableResources.outputStyles,
			skills: installedSkills.map((s) => ({ id: s.id, name: s.name })),
			mcp: mcpServers.map((m) => ({ id: m.name, name: m.name })),
			folders: recentFolders,
			plugins: enabled
				.filter((app) => app.companion === null)
				.map(toAppMentionSource),
			users: humanMentionDirectory.users,
		};
	}, [
		agents,
		conversations,
		convId,
		teams,
		workflows,
		spaces,
		installedSkills,
		mcpServers,
		composioConfigured,
		composioConnections,
		composioToolkits,
		recentFolders,
		registeredApps,
		mentionableResources,
		humanMentionDirectory.users,
	]);
	const humanMentionNotifyRef = useRef<
		(mentions: SelectedHumanMention[], content: string) => void
	>(() => undefined);
	const notifyHumanMentions = useCallback(
		(mentions: SelectedHumanMention[], content: string) => {
			if (!inboxEnabled || mentions.length === 0) {
				return;
			}
			const senderName =
				oidcUser?.name?.trim() || oidcUser?.email?.trim() || "Someone";
			const title = `${senderName} mentioned you`.slice(0, 120);
			const body =
				`${senderName} mentioned you in chat:\n${content.trim()}`.slice(
					0,
					1800
				);
			void Promise.allSettled(
				mentions.map((mention) =>
					pluginHostInvoke(chatTarget, "@ryu/approvals", "notifications.send", {
						body,
						target_user_id: mention.id,
						title,
					})
				)
			).then((results) => {
				const failedNames = results.flatMap((result, index) =>
					result.status === "rejected" && mentions[index]
						? [mentions[index].label]
						: []
				);
				if (failedNames.length > 0) {
					toast.error({
						title: `Couldn't notify ${failedNames.join(", ")}`.slice(0, 180),
					});
				}
			});
		},
		[inboxEnabled, chatTarget, oidcUser?.email, oidcUser?.name]
	);
	humanMentionNotifyRef.current = notifyHumanMentions;
	const mentionSourcesRef = useRef(mentionSources);
	mentionSourcesRef.current = mentionSources;
	// Reconciled against the last committed list: the sources change identity on
	// every render, and a new list would re-render every settled transcript turn.
	const committedMentionItemsRef = useRef<ResolvedMentionItem[]>([]);
	const resolvedMentionItems = useMemo(
		() =>
			reuseEqualMentionItems(
				committedMentionItemsRef.current,
				buildMentionGroups(mentionSources, "")
					.flatMap((group) => group.items)
					.map((item) => ({
						accentColor: item.accentColor,
						icon: item.icon
							? createElement(item.icon, { className: "size-3.5" })
							: undefined,
						id: item.id,
						kind: item.kind,
						label: item.label,
						ownerId: item.ownerId,
						target: item.target,
						visualIcon: item.visualIcon,
					}))
			),
		[mentionSources]
	);
	useEffect(() => {
		committedMentionItemsRef.current = resolvedMentionItems;
	}, [resolvedMentionItems]);
	return {
		processedMessages,
		renderedMessages,
		liveTranscriptMessages,
		readLatestProcessedMessages,
		messageReadReceiptStates,
		conversationModelNotices,
		handleMessageVisible,
		chatSearchMatches,
		activeChatSearchMatch,
		closeChatSearch,
		changeChatSearchMode,
		changeChatSearchQuery,
		nextChatSearchMatch,
		previousChatSearchMatch,
		agentsStableRef,
		teamsStableRef,
		workflowsStableRef,
		humanMentionNotifyRef,
		mentionSourcesRef,
		resolvedMentionItems,
	} as const;
}
