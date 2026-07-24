import { useChat } from "@ai-sdk/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
	Maximize2,
	MessageSquarePlus,
	MoreHorizontal,
	PanelRight,
	Plus,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentChat } from "@/components/agent-elements/agent-chat.tsx";
import {
	EmptyStateHeader,
	type EmptyStateLogo,
} from "@/components/agent-elements/empty-state-header.tsx";
import {
	type ActivePermission,
	PermissionPrompt,
} from "@/src/components/chat/PermissionPrompt.tsx";
import { ClipComposerControls } from "@/src/components/clips/ClipComposerControls.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	type BuilderBodyFields,
	useBuilderRuntime,
} from "@/src/hooks/useBuilderRuntime.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import { respondPermission } from "@/src/lib/api/acp.ts";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { generateImage } from "@/src/lib/api/images.ts";
import { getDesktopTtsPrefs } from "@/src/lib/api/preferences.ts";
import { speakText } from "@/src/lib/api/voice.ts";
import { getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import {
	type AssistantBuilderSession,
	type PageContextItem,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { buildBuilderPreamble, injectPreamble } from "./builderPreamble.ts";
import { ASSISTANT_SURFACE_CONTENT } from "./skin.ts";
import { type ComposerSendFile, useComposerSlot } from "./useComposerSlot.tsx";

/** Builder panes describe what to build rather than chat. */
const BUILDER_PLACEHOLDER = "Describe what to build…";

/** Persisted default-agent key, shared with the home chat composer so picking an
 *  agent in either place keeps them in sync. */
const DEFAULT_AGENT_KEY = "ryu_default_agent";
/** The driving-agent key for builder mode — remembered independently of the
 *  generic assistant agent and defaulting to the flagship `ryu`. */
const BUILDER_AGENT_KEY = "ryu_assistant_builder_agent";

/** Human label for the generic "current page" context derived from the tab. */
function tabContextTitle(title: string, path: string): string {
	const clean = title?.trim();
	if (clean && clean !== "New chat") {
		return clean;
	}
	// Fall back to a readable name from the path (e.g. "/spaces" → "Spaces").
	const seg = path.split("?")[0].split("/").filter(Boolean)[0] ?? "page";
	return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * Build the user-message text for a fresh thread, embedding the active page
 * context inline (the established "ask about what you're looking at" convention
 * — Core has no structured context field, so context rides in the message).
 */
function composeWithContext(
	content: string,
	context: PageContextItem[]
): string {
	if (context.length === 0) {
		return content;
	}
	const block = context
		.map((c) => {
			const body = c.text.trim();
			return body ? `### ${c.title}\n${body}` : `### ${c.title}`;
		})
		.join("\n\n");
	return `The user is working in Ryu and currently has this open. Use it as context for their request.\n\n<page-context>\n${block}\n</page-context>\n\n${content}`;
}

/**
 * Build the chat-stream request body for one turn. In builder mode it injects the
 * builder preamble + drives the `*_builder__*` tools with `persist: false`; in
 * generic mode it carries the workspace cwd and persists normally. Top-level so
 * the transport closure — and the panel — stay lean.
 */
function buildChatRequestBody(params: {
	builderBodyFields: () => BuilderBodyFields;
	convId: string;
	genericBodyFields: () => BuilderBodyFields;
	outgoing: UIMessage[];
	session: AssistantBuilderSession | null;
	targetId: string | null;
}): { body: Record<string, unknown> } {
	const { outgoing, session, targetId } = params;
	if (session) {
		const id = targetId ?? session.targetId;
		const messages = id
			? injectPreamble(
					outgoing,
					buildBuilderPreamble(session.kind, id, session.snapshot)
				)
			: outgoing;
		return {
			body: {
				messages,
				...params.builderBodyFields(),
				conversation_id: session.conversationId,
				persist: false,
				enable_long_term: false,
			},
		};
	}
	// Page context is folded into the message text in `handleSend`, not a preamble.
	const cwd = useWorkspaceStore.getState().folder ?? undefined;
	return {
		body: {
			messages: outgoing,
			...params.genericBodyFields(),
			conversation_id: params.convId,
			cwd,
			enable_long_term: false,
		},
	};
}

/** Empty-state header for the builder chat, worded per builder kind. */
function BuilderEmptyState({
	session,
	title,
}: {
	session: AssistantBuilderSession;
	title: string | null;
}) {
	return (
		<div className="flex flex-col gap-1 px-1 pb-3 text-center">
			<span className="font-semibold text-base">{title}</span>
			<span className="text-muted-foreground text-sm">
				{session.kind === "agent"
					? "Ask what this agent should be. When it tries to change itself, I'll ask you to allow or deny the tool call."
					: "Describe what the workflow should do in plain language. I'll assemble the nodes and wiring on the canvas."}
			</span>
		</div>
	);
}

/**
 * The generic assistant's page-context chips — shown only when NOT in builder
 * mode. Extracted so the panel's render stays lean.
 */
function GenericAssistantExtras(props: {
	divider: string;
	effectiveContext: PageContextItem[];
	genericContext: PageContextItem | null;
	onDismissContext: () => void;
	onRemovePageContext: (id: string) => void;
	onRestoreContext: () => void;
}) {
	const { divider, effectiveContext, genericContext } = props;
	return effectiveContext.length > 0 ? (
		<div
			className={cn(
				"flex shrink-0 flex-wrap items-center gap-1.5 px-3 py-2",
				divider
			)}
		>
			{effectiveContext.map((c) => (
				<span
					className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs"
					key={c.id}
				>
					<span className="truncate">{c.title}</span>
					<button
						aria-label={`Remove ${c.title} from context`}
						className="shrink-0 rounded-full p-0.5 hover:bg-background"
						onClick={() =>
							c.id.startsWith("tab:")
								? props.onDismissContext()
								: props.onRemovePageContext(c.id)
						}
						type="button"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
		</div>
	) : (
		genericContext && (
			<div className={cn("flex shrink-0 items-center px-3 py-1.5", divider)}>
				<button
					className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
					onClick={() => props.onRestoreContext()}
					type="button"
				>
					<Plus className="size-3" />
					Add current page
				</button>
			</div>
		)
	);
}

/**
 * Scan messages (newest first) for the latest still-unresolved tool-permission
 * request an agent emitted (a `data-ryu-permission` part) — how the agent builder
 * gates `agent_builder__configure_agent`. Top-level to keep the panel lean.
 */
function findActivePermission(
	messages: UIMessage[],
	resolved: Set<string>
): ActivePermission | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !message.parts) {
			continue;
		}
		for (let j = message.parts.length - 1; j >= 0; j--) {
			const part = message.parts[j] as { type?: string; data?: unknown };
			if (part.type !== "data-ryu-permission") {
				continue;
			}
			const data = part.data as ActivePermission | undefined;
			if (data?.requestId && !resolved.has(data.requestId)) {
				return data;
			}
		}
	}
	return null;
}

/**
 * The global "Ask Ryu" assistant panel — a Notion-AI-style chat that floats over
 * any page or docks as a right sidebar. It reuses the presentational `AgentChat`
 * (message list + composer) with its own lightweight chat transport, kept
 * deliberately minimal vs. the full ChatPage (no teams / ACP pickers / worktree /
 * realtime presence) so the panel stays compact and focused.
 *
 * It is ALSO context-aware: when a builder page (agent edit, workflows) registers
 * a builder takeover in the assistant store (`useAssistantBuilder`), this one
 * panel becomes that page's builder — injecting the builder preamble, driving the
 * `*_builder__*` tools with `persist: false`, showing the tool-permission prompt,
 * and refreshing the page after each settled turn. That is what replaced the old
 * inline `AgentBuilderChat` / `WorkflowBuilderChat` panes. When no builder is
 * registered it is the plain "Ask Ryu" chat (page context chips, onboarding,
 * full-screen hand-off).
 *
 * Layout only mounts this component while the panel is open, so its `useChat`
 * is fully unmounted on close. That is what lets the "open full screen" hand-off
 * mount a `/chat` tab on the SAME conversation id without two live `useChat`
 * instances colliding on that id (the per-tab-convId gotcha,
 * [[chat-history-per-tab-convid]]) — `handleOpenFullScreen` closes the panel as
 * it opens the tab.
 *
 * `bare` renders just the panel body (header + context + chat), without the
 * fixed-positioned `<aside>` shell, so it can be embedded as the content of the
 * morph launcher (which owns the floating window's glass frame + animation).
 */
export function AssistantPanel({ bare = false }: { bare?: boolean } = {}) {
	const mode = useAssistantStore((s) => s.mode);
	const builder = useAssistantStore((s) => s.builder);
	const storeConvId = useAssistantStore((s) => s.conversationId);
	const pageContext = useAssistantStore((s) => s.pageContext);
	const contextDismissed = useAssistantStore((s) => s.contextDismissed);
	const setLayout = useAssistantStore((s) => s.setLayout);
	const close = useAssistantStore((s) => s.close);
	const setConversationId = useAssistantStore((s) => s.setConversationId);
	const newConversation = useAssistantStore((s) => s.newConversation);
	const removePageContext = useAssistantStore((s) => s.removePageContext);
	const dismissContext = useAssistantStore((s) => s.dismissContext);
	const restoreContext = useAssistantStore((s) => s.restoreContext);

	const { openTab, tabs, activeTabId } = useTabsContext();
	const { createConversation, setActiveConversationId, loadMessages, refresh } =
		useChatHistoryContext();

	const activeNode = useActiveNode();
	const chatTarget: ApiTarget = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
		[activeNode.url, activeNode.token]
	);

	// Agent + model selection, shared with the main chat composer via the same
	// per-agent storage. Builder mode uses its own key (defaults to `ryu`, which
	// reliably runs the tool loop the `*_builder__*` tools need). Both runtimes are
	// created unconditionally (no conditional hooks) and the active one is picked.
	const genericRuntime = useBuilderRuntime(DEFAULT_AGENT_KEY);
	const builderRuntime = useBuilderRuntime(BUILDER_AGENT_KEY);
	const isBuilder = builder !== null;

	// The big empty-state mark for the generic assistant — the driving agent's own
	// logo (or custom avatar), peeking out from behind the composer, exactly like
	// the main chat page. Clicking it opens the same Agent · Model · Thinking menu.
	const { agents } = useAgents();
	const genericLogo = useMemo<EmptyStateLogo>(() => {
		const agent = agents.find((a) => a.id === genericRuntime.agentId);
		if (agent?.avatarUrl) {
			return { kind: "image", url: agent.avatarUrl };
		}
		return { kind: "single", engine: agent ? engineForAgent(agent) : null };
	}, [agents, genericRuntime.agentId]);

	// This panel's conversation id. In generic mode it is seeded from the store (so
	// reopening keeps the same thread) and regenerated when a fresh thread is
	// requested. In builder mode it is the builder session's own ephemeral id.
	const [convId, setConvId] = useState<string>(
		() => storeConvId ?? `conv-${Date.now()}`
	);
	// React only to the store's id changing — `convId` is the local mirror, read
	// via the functional updater so it is not a dependency. A null store id means
	// `newConversation()` was called, so start a brand-new thread.
	useEffect(() => {
		setConvId((current) => {
			if (storeConvId === null) {
				return `conv-${Date.now()}`;
			}
			return storeConvId === current ? current : storeConvId;
		});
	}, [storeConvId]);

	const activeConvId = builder ? builder.conversationId : convId;
	const convIdRef = useRef(convId);
	convIdRef.current = convId;

	// Live builder state the transport/effects read at send time. `targetIdRef` is
	// set synchronously in `handleSend` right after `resolveId` so the preamble
	// sees the resolved id before the request is built (the new-record chicken-and-
	// egg the old builder panes handled the same way).
	const builderRef = useRef(builder);
	builderRef.current = builder;
	const targetIdRef = useRef<string | null>(builder?.targetId ?? null);
	useEffect(() => {
		if (builder?.targetId) {
			targetIdRef.current = builder.targetId;
		}
	}, [builder?.targetId]);
	// Stable-identity body-field closures for each runtime (both are stable, but
	// the refs keep the transport memo from depending on them).
	const genericBodyFieldsRef = useRef(genericRuntime.bodyFields);
	genericBodyFieldsRef.current = genericRuntime.bodyFields;
	const builderBodyFieldsRef = useRef(builderRuntime.bodyFields);
	builderBodyFieldsRef.current = builderRuntime.bodyFields;

	const transport = useMemo(
		() =>
			new DefaultChatTransport<UIMessage>({
				api: chatStreamUrl(chatTarget),
				headers: async (): Promise<Record<string, string>> => {
					const base = chatHeaders(chatTarget);
					const jwt = await getRealtimeJwt();
					return jwt ? { ...base, "X-Ryu-User-Jwt": jwt } : base;
				},
				prepareSendMessagesRequest: ({ messages: outgoingMessages }) =>
					buildChatRequestBody({
						outgoing: outgoingMessages,
						session: builderRef.current,
						targetId: targetIdRef.current,
						builderBodyFields: builderBodyFieldsRef.current,
						genericBodyFields: genericBodyFieldsRef.current,
						convId: convIdRef.current,
					}),
			}),
		[chatTarget]
	);

	const { messages, sendMessage, setMessages, stop, status, error } = useChat({
		id: activeConvId,
		transport,
	});

	// Multimodal (image): generate from the composer text and surface the result
	// inline, mirroring ChatPage's handler exactly so the Ask Ryu dock reads the
	// same. Client-only — `/api/images/generate` is one-shot and not written to the
	// conversation store, so it isn't re-hydrated on reload. A backing engine that
	// isn't available surfaces as an inline error part (graceful degradation).
	const handleGenerateImage = useCallback(
		async (prompt: string) => {
			const userId = `img-user-${Date.now()}`;
			const assistantId = `img-${Date.now()}`;
			// Echo the prompt as a user bubble so the turn reads naturally.
			setMessages((prev) => [
				...prev,
				{
					id: userId,
					role: "user",
					parts: [{ type: "text", text: prompt }],
				} as (typeof prev)[number],
			]);
			try {
				const urls = await generateImage(chatTarget, prompt);
				const parts =
					urls.length > 0
						? urls.map((url) => ({
								type: "file" as const,
								mediaType: "image/png",
								url,
							}))
						: [
								{
									type: "error" as const,
									title: "Image generation failed",
									message: "The image engine returned no image.",
								},
							];
				setMessages((prev) => [
					...prev,
					{
						id: assistantId,
						role: "assistant",
						parts,
					} as unknown as (typeof prev)[number],
				]);
			} catch (e) {
				setMessages((prev) => [
					...prev,
					{
						id: assistantId,
						role: "assistant",
						parts: [
							{
								type: "error" as const,
								title: "Image generation failed",
								message:
									e instanceof Error ? e.message : "Could not generate image.",
							},
						],
					} as unknown as (typeof prev)[number],
				]);
			}
		},
		[chatTarget, setMessages]
	);

	// Multimodal (speak): synthesize an assistant reply via Core's `/api/voice/speak`
	// and play it, honouring the Voice-tab TTS engine/voice. A second click on the
	// same turn toggles playback off (`audio.play()` resolves at start, so the hover
	// button re-enables mid-playback). A missing TTS sidecar throws; the message
	// toolbar's speak button swallows it (silent no-op), so the surface degrades
	// gracefully — the same posture as STT, which has no capability probe to gate on.
	const speakingAudioRef = useRef<HTMLAudioElement | null>(null);
	const speakingTextRef = useRef<string | null>(null);
	const handleSpeak = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed) {
				return;
			}
			if (speakingAudioRef.current) {
				const wasSameTurn = speakingTextRef.current === trimmed;
				speakingAudioRef.current.pause();
				speakingAudioRef.current = null;
				speakingTextRef.current = null;
				if (wasSameTurn) {
					return;
				}
			}
			const prefs = getDesktopTtsPrefs();
			const blob = await speakText(chatTarget, trimmed, {
				engine: prefs.engine,
				voice: prefs.voice || undefined,
			});
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			speakingAudioRef.current = audio;
			speakingTextRef.current = trimmed;
			audio.addEventListener("ended", () => {
				URL.revokeObjectURL(url);
				if (speakingAudioRef.current === audio) {
					speakingAudioRef.current = null;
					speakingTextRef.current = null;
				}
			});
			await audio.play();
		},
		[chatTarget]
	);

	// The full chat composer — the SAME one the main chat page renders (Agent ·
	// Model · Thinking menu + STT voice + voice mode + image attachments + the
	// single-row compact layout once a thread has history) — built once by the
	// shared `useComposerSlot`. Both runtimes get a composer (no conditional hooks);
	// the active one is picked. The builder pane relabels its placeholder. Compact
	// flips on as soon as the thread has messages, matching ChatPage.
	const hasMessages = messages.length > 0;
	const genericComposer = useComposerSlot(genericRuntime, {
		target: chatTarget,
		compact: hasMessages,
		conversationId: convId,
		// Image-gen only on the chat composer — the builder pane describes what to
		// build, where a free-form "generate image" prompt has no place.
		onGenerateImage: handleGenerateImage,
	});
	const builderComposer = useComposerSlot(builderRuntime, {
		target: chatTarget,
		compact: hasMessages,
		placeholder: BUILDER_PLACEHOLDER,
		conversationId: activeConvId,
	});
	const activeComposer = isBuilder ? builderComposer : genericComposer;
	const composerSlot = activeComposer.inputBar;
	// Live ref so `handleSend` can fold staged images into the outgoing message
	// without depending on the composer identity (which flips builder↔generic).
	const takeImagesRef = useRef(activeComposer.takeImages);
	takeImagesRef.current = activeComposer.takeImages;
	// Live ref for the queued Ryu Clip context text, folded into the outgoing text
	// at send time (frames ride the image path via `takeImages`). Same live-ref
	// indirection as images so the send handler never depends on the composer
	// identity (which flips builder<->generic).
	const takeClipTextRef = useRef(activeComposer.takeClipText);
	takeClipTextRef.current = activeComposer.takeClipText;
	// Stable attach fn for the clip composer controls, reading the live composer.
	const attachClipRef = useRef(activeComposer.attachClip);
	attachClipRef.current = activeComposer.attachClip;
	const attachClip = useCallback(
		(text: string, frames: ComposerSendFile[]) =>
			attachClipRef.current(text, frames),
		[]
	);

	// Rehydrate a previously-sent thread when the panel reopens on the same id
	// (the panel unmounts while closed, so in-memory messages are lost). Skipped
	// in builder mode — builder threads are ephemeral (`persist: false`). The
	// empty-history early return is load-bearing: it also fires right after the
	// first send, before Core has persisted anything — wiping useChat then would
	// drop the just-sent turn.
	useEffect(() => {
		if (builderRef.current) {
			return;
		}
		let cancelled = false;
		loadMessages(convId).then((history) => {
			if (cancelled || history.length === 0) {
				return;
			}
			setMessages(
				history.map(
					(m) =>
						({
							id: m.id,
							role: m.role,
							parts: [{ type: "text" as const, text: m.content }],
						}) as (typeof messages)[number]
				)
			);
		});
		return () => {
			cancelled = true;
		};
	}, [convId, loadMessages, setMessages]);

	// When a reply finishes: generic mode re-syncs the shared chat history (so the
	// new conversation + auto-title show up in the sidebar); builder mode refetches
	// the edited record so the page (config form / canvas) updates live.
	const prevStatus = useRef(status);
	useEffect(() => {
		const was = prevStatus.current;
		prevStatus.current = status;
		if (status !== "ready" || !(was === "streaming" || was === "submitted")) {
			return;
		}
		const session = builderRef.current;
		if (session) {
			const id = targetIdRef.current ?? session.targetId;
			if (id) {
				session.onChanged(id);
			}
		} else {
			refresh();
		}
	}, [status, refresh]);

	// Inline tool-permission prompt (Zed-style allow/deny) — surfaced whenever an
	// agent asks to run a tool, which is how the agent builder gates
	// `agent_builder__configure_agent`. Harmless (and useful) in generic chat too.
	const [resolvedPermissions, setResolvedPermissions] = useState<Set<string>>(
		() => new Set()
	);
	const activePermission = useMemo(
		() => findActivePermission(messages, resolvedPermissions),
		[messages, resolvedPermissions]
	);
	const handleRespondPermission = useCallback(
		(optionId: string | null) => {
			const requestId = activePermission?.requestId;
			if (!requestId) {
				return;
			}
			setResolvedPermissions((prev) => {
				const next = new Set(prev);
				next.add(requestId);
				return next;
			});
			respondPermission(chatTarget, requestId, optionId).catch(() => undefined);
		},
		[activePermission, chatTarget]
	);

	// The generic "current page" context derived from the focused tab, offered
	// when the active page hasn't published anything richer of its own.
	const genericContext = useMemo<PageContextItem | null>(() => {
		const tab = tabs.find((t) => t.id === activeTabId);
		if (!tab) {
			return null;
		}
		return {
			id: `tab:${tab.id}`,
			title: tabContextTitle(tab.title, tab.path),
			text: `The user is on the "${tabContextTitle(tab.title, tab.path)}" page (${tab.path}).`,
		};
	}, [tabs, activeTabId]);

	// A new page is a new context opportunity — un-dismiss when the focus moves.
	const lastTabRef = useRef(activeTabId);
	useEffect(() => {
		if (activeTabId !== lastTabRef.current) {
			lastTabRef.current = activeTabId;
			restoreContext();
		}
	}, [activeTabId, restoreContext]);

	const effectiveContext = useMemo<PageContextItem[]>(() => {
		if (contextDismissed) {
			return [];
		}
		if (pageContext.length > 0) {
			return pageContext;
		}
		return genericContext ? [genericContext] : [];
	}, [contextDismissed, pageContext, genericContext]);
	const effectiveContextRef = useRef(effectiveContext);
	effectiveContextRef.current = effectiveContext;

	const handleSend = useCallback(
		(msg: { role: "user"; content: string }) => {
			const session = builderRef.current;
			if (session) {
				// Ensure a record exists (creates a draft for brand-new agents/
				// workflows) before the transport builds the preamble referencing its id.
				session
					.resolveId()
					.then((id) => {
						if (!id) {
							return;
						}
						targetIdRef.current = id;
						const files = takeImagesRef.current();
						const clipText = takeClipTextRef.current();
						const text = clipText
							? `${clipText}\n\n${msg.content}`
							: msg.content;
						sendMessage(files ? { text, files } : { text });
					})
					.catch(() => undefined);
				return;
			}
			if (!convIdRef.current || messages.length === 0) {
				// First turn of this thread: register the conversation locally and
				// mirror its id into the store + shared history selection.
				createConversation(convId, genericRuntime.agentId);
				setConversationId(convId);
				setActiveConversationId(convId);
			}
			const baseText =
				messages.length === 0
					? composeWithContext(msg.content, effectiveContextRef.current)
					: msg.content;
			const clipText = takeClipTextRef.current();
			const text = clipText ? `${clipText}\n\n${baseText}` : baseText;
			const files = takeImagesRef.current();
			sendMessage(files ? { text, files } : { text });
		},
		[
			convId,
			messages.length,
			genericRuntime.agentId,
			createConversation,
			setConversationId,
			setActiveConversationId,
			sendMessage,
		]
	);

	const handleOpenFullScreen = useCallback(() => {
		// Carry THIS conversation into a full `/chat` tab, then close the panel so
		// its `useChat` unmounts — two live hooks on one id would collide.
		setConversationId(convId);
		openTab("/chat", { conversationId: convId });
		close();
	}, [convId, openTab, setConversationId, close]);

	if (mode === "closed") {
		return null;
	}

	const isSidebar = mode === "sidebar";
	// Dividers read fine on the opaque sidebar, but the floating window is
	// deliberately borderless/backgroundless — drop them there.
	const divider = bare ? "" : "border-border/60 border-b";
	const builderTitle = builder
		? `Build ${builder.targetName.trim() || (builder.kind === "agent" ? "this agent" : "this workflow")}`
		: null;

	// Builder threads get a worded prompt; the generic assistant reuses the main
	// chat's `EmptyStateHeader` so the driving agent's logo sits behind the
	// composer and opens the same Agent · Model · Thinking dropdown.
	const emptyHeader = builder ? (
		<BuilderEmptyState session={builder} title={builderTitle} />
	) : (
		<EmptyStateHeader
			logo={genericLogo}
			renderBody={genericComposer.renderBody}
			sections={genericComposer.sections}
		/>
	);

	const body = (
		<>
			<header
				className={cn("flex shrink-0 items-center gap-1.5 px-3 py-2", divider)}
				data-tauri-drag-region={false}
			>
				{/* Floating mode is deliberately minimal — no titled header bar, just the
				    conversation + composer as islands. Drop the title so only the
				    top-right controls float; the docked sidebar keeps a plain "Chat"
				    label across every page (builder mode included). */}
				{bare ? null : (
					<span className="truncate font-medium text-sm">Chat</span>
				)}
				<div className="flex-1" />
				<Button
					aria-label={isSidebar ? "Float panel" : "Dock to sidebar"}
					className="size-7"
					onClick={() => setLayout(isSidebar ? "floating" : "sidebar")}
					size="icon"
					title={isSidebar ? "Float" : "Dock to side"}
					variant="ghost"
				>
					<PanelRight className="size-4" />
				</Button>
				{/* The 3-dots menu (full-screen hand-off / new chat) only applies to the
				    generic assistant; builder threads are page-bound + ephemeral. */}
				{isBuilder ? null : (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label="Assistant options"
									className="size-7"
									size="icon"
									variant="ghost"
								/>
							}
						>
							<MoreHorizontal className="size-4" />
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className="min-w-48"
							sideOffset={4}
						>
							<DropdownMenuItem onClick={handleOpenFullScreen}>
								<Maximize2 className="size-4" />
								Open in full screen
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => newConversation()}>
								<MessageSquarePlus className="size-4" />
								New chat
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={() => close()}>
								<X className="size-4" />
								Close
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<Button
					aria-label="Close assistant"
					className="size-7"
					onClick={() => close()}
					size="icon"
					variant="ghost"
				>
					<X className="size-4" />
				</Button>
			</header>

			{/* Page-context chips belong to the generic assistant only — a builder is
			    scoped to the record it edits, not the page it happens to sit over.
			    Floating mode also drops them: the minimal window is just the
			    conversation + composer islands, no top chrome band. */}
			{isBuilder || bare ? null : (
				<GenericAssistantExtras
					divider={divider}
					effectiveContext={effectiveContext}
					genericContext={genericContext}
					onDismissContext={dismissContext}
					onRemovePageContext={removePageContext}
					onRestoreContext={restoreContext}
				/>
			)}

			{/* Ryu Clips: record screen+audio or attach an existing recording, folding
			    its agent-context summary + key frames into the next turn. Generic chat
			    only (a builder is scoped to the record it edits). */}
			{isBuilder ? null : (
				<ClipComposerControls
					className={cn("shrink-0 px-3 py-1.5", divider)}
					onAttach={attachClip}
				/>
			)}

			<div className="relative min-h-0 flex-1 overflow-hidden">
				{activePermission ? (
					<PermissionPrompt
						onRespond={handleRespondPermission}
						permission={activePermission}
					/>
				) : null}
				<AgentChat
					attachments={activeComposer.attachments}
					emptyStateHeader={emptyHeader}
					emptyStatePosition="center"
					error={error ?? undefined}
					key={`${activeNode.url}-${activeConvId}`}
					messages={messages}
					onSend={handleSend}
					onSpeak={handleSpeak}
					onStop={stop}
					showCopyToolbar
					slots={{ InputBar: composerSlot }}
					status={status}
				/>
			</div>
			{/* ChatGPT-style voice mode overlay (full-screen) for the active composer. */}
			{activeComposer.voiceModeOverlay}
		</>
	);

	// Embedded in the morph launcher: fill its morphing frame, no shell of our own
	// (the launcher supplies the glass floating frame + spring animation).
	if (bare) {
		return <div className={cn(ASSISTANT_SURFACE_CONTENT)}>{body}</div>;
	}

	// Docked sidebar: an inset, floating rounded card wearing the same treatment
	// as the chat page's right panel (rounded-xl + shadow + ring, inset from the
	// edges), rather than a flush full-height rail.
	return (
		<aside
			aria-label={builder ? "Ryu builder" : "Ask Ryu assistant"}
			className="fixed top-12 right-2 bottom-2 z-[55] flex w-[380px] flex-col overflow-hidden rounded-xl bg-sidebar text-sidebar-foreground shadow-2xl ring-1 ring-border/40"
		>
			{body}
		</aside>
	);
}
