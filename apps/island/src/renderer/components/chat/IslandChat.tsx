// The expanded-island mini chat wrapper. The presentational body lives in the
// shared desktop `AgentChat`; this file owns the chat state via
// useIslandChat, the Core reachability probe, the store prefill, and reports both
// whether there is history (so the island grows from a compact composer bar to the
// full panel) and the composer's height (so the compact bar tracks the draft).
//
// The transcript and composer are both shared primitives at compact density, so
// tool rows, MCP widgets, generated images, mentions, and directory dropdowns do
// not need island-local ports.

import {
	type ComposerShortcutEvent,
	handleComposerSettingsShortcut,
} from "@ryu/blocks/composer/composer-shortcuts";
import { AgentChat } from "@ryu/blocks/desktop/agent-elements/agent-chat";
import {
	type AgentUiSurfaceSelection,
	agentUiSurfaceKey,
	deriveLiveAgentUiSurface,
	dismissAgentUiSurface,
	displayedAgentUiSurface,
	EMPTY_AGENT_UI_SURFACE_SELECTION,
	reconcileAgentUiSurfaceSelection,
	reopenAgentUiSurface,
} from "@ryu/blocks/desktop/agent-elements/agent-ui/surface";
import {
	type AgentUiSurfaceHost,
	AgentUiSurfaceHostProvider,
} from "@ryu/blocks/desktop/agent-elements/agent-ui/surface-context";
import {
	InputBar,
	type InputBarProps,
} from "@ryu/blocks/desktop/agent-elements/input-bar";
import { useI18n } from "@ryu/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useIslandComposerContext } from "../../context/island-composer-context.tsx";
import { useComposerShortcutBindings } from "../../hooks/use-composer-shortcut-bindings.ts";
import { IslandWidgetHost } from "../../host/IslandWidgetHost.tsx";
import { useIslandState } from "../../store/island-state.ts";
import {
	IslandChatHeader,
	IslandChatProblem,
	IslandNotesStrip,
	threadTitle,
} from "./IslandChatChrome.tsx";
import { useIslandChat } from "./use-island-chat.ts";

const agentUiSubmitContentSchema = z.union([
	z.string(),
	z.json().transform((value) => JSON.stringify(value)),
	z.undefined().transform(String),
]);

type Reachability = "checking" | "offline" | "online";

export function IslandChat() {
	const {
		composerMenuGroups,
		mentionItems,
		onComposerMenuSelect,
		getAcpPayload,
		sections,
		applyStreamedAcpConfig,
		applyStreamedAcpMode,
	} = useIslandComposerContext();
	const composerShortcuts = useComposerShortcutBindings();
	const { messages, status, error, notes, send, stop, clearNotes } =
		useIslandChat({
			getAcpPayload,
			// Agent-driven session-control write-backs go straight back into the
			// composer's ACP state, so the next turn sends what the agent asked for.
			onAcpConfig: applyStreamedAcpConfig,
			onAcpMode: applyStreamedAcpMode,
		});
	const chatPrefill = useIslandState((store) => store.chatPrefill);
	const clearChatPrefill = useIslandState((store) => store.clearChatPrefill);
	const openCommand = useIslandState((store) => store.openCommand);
	const setExpandedTall = useIslandState((store) => store.setExpandedTall);
	const setComposerHeight = useIslandState((store) => store.setComposerHeight);
	const toggleCollapse = useIslandState((store) => store.toggleCollapse);
	const pendingAttachments = useIslandState(
		(store) => store.pendingAttachments
	);
	const removeAttachment = useIslandState((store) => store.removeAttachment);
	const clearAttachments = useIslandState((store) => store.clearAttachments);
	const attachAndOpen = useIslandState((store) => store.attachAndOpen);
	const [reachability, setReachability] = useState<Reachability>("checking");
	const { t } = useI18n();

	const hasHistory = messages.length > 0;

	const probe = useCallback(async (): Promise<void> => {
		setReachability("checking");
		const result = await window.island.core.health();
		setReachability(result.available ? "online" : "offline");
	}, []);

	useEffect(() => {
		probe().catch(() => setReachability("offline"));
	}, [probe]);

	const offline = reachability === "offline";

	// The island is a short composer bar until a conversation exists (or a note
	// or problem strip needs room above the composer), then it grows to the full
	// panel height.
	const needsPanel =
		hasHistory || offline || Boolean(error) || notes.length > 0;
	useEffect(() => {
		setExpandedTall(needsPanel);
	}, [needsPanel, setExpandedTall]);

	const onComposerKeyDown = useCallback(
		(event: ComposerShortcutEvent): boolean =>
			handleComposerSettingsShortcut(event, sections, composerShortcuts),
		[sections, composerShortcuts]
	);
	const onAttach = useCallback(() => {
		void window.island.system
			.attachFiles()
			.then(attachAndOpen)
			.catch(() => undefined);
	}, [attachAndOpen]);
	// Retry resends the thread's last question; the raw failure stays behind
	// "Copy details" instead of printing in the transcript.
	const lastQuestion = useMemo(() => {
		const userTurns = messages.filter((message) => message.role === "user");
		return threadTitle(userTurns.slice(-1));
	}, [messages]);
	const sendTurn = useCallback(
		(text: string) => {
			const attachments = useIslandState.getState().pendingAttachments;
			void Promise.resolve(send(text, { withScreen: true, attachments })).catch(
				() => undefined
			);
			clearAttachments();
		},
		[clearAttachments, send]
	);
	const retryLastTurn = lastQuestion ? () => sendTurn(lastQuestion) : undefined;
	const inputBarPropsRef = useRef<{
		onAttach: () => void;
		onComposerKeyDown: (event: ComposerShortcutEvent) => boolean;
	}>({ onAttach, onComposerKeyDown });
	inputBarPropsRef.current = { onAttach, onComposerKeyDown };
	const islandInputBar = useMemo(
		() =>
			function IslandInputBar(props: InputBarProps) {
				const live = inputBarPropsRef.current;
				return (
					<InputBar
						{...props}
						compact
						leftActions={null}
						onAttach={live.onAttach}
						onTextareaKeyDown={(event) => {
							if (live.onComposerKeyDown(event)) {
								return;
							}
							props.onTextareaKeyDown?.(event);
						}}
					/>
				);
			},
		[]
	);
	const handleAgentUiSubmit = useCallback(
		(value: Parameters<typeof agentUiSubmitContentSchema.safeParse>[0]) => {
			const parsed = agentUiSubmitContentSchema.safeParse(value);
			if (parsed.success) {
				sendTurn(parsed.data);
			}
		},
		[sendTurn]
	);

	// Generative UI as ONE live screen: the agent's latest `ui.render` shows on
	// the desktop beside the Island, reshapes when a follow-up turn renders a replacement, and leaves
	// when a turn finishes without UI. The transcript keeps a chip per render that
	// can bring an older (or closed) screen back.
	const live = useMemo(
		() => deriveLiveAgentUiSurface(messages, status),
		[messages, status]
	);
	// Dismissal is keyed by render id (see `AgentUiSurfaceSelection`), so closing
	// a screen never suppresses a later `ui.render` of the same spec.
	const [storedSelection, setSelection] = useState<AgentUiSurfaceSelection>(
		() =>
			reconcileAgentUiSurfaceSelection(
				EMPTY_AGENT_UI_SURFACE_SELECTION,
				live.surface
			)
	);
	const selection = reconcileAgentUiSurfaceSelection(
		storedSelection,
		live.surface
	);
	if (selection !== storedSelection) {
		// A newly rendered screen supersedes one the user reopened from history.
		setSelection(selection);
	}
	const surface = displayedAgentUiSurface(selection, live.surface);
	const surfaceKey = surface ? agentUiSurfaceKey(surface) : null;
	const surfaceUpdating = selection.reopened ? false : live.updating;
	const surfaceHost = useMemo<AgentUiSurfaceHost>(
		() => ({
			activeKey: surfaceKey,
			open: (next) =>
				setSelection((current) => reopenAgentUiSurface(current, next)),
		}),
		[surfaceKey]
	);
	const dismissSurface = useCallback(() => {
		setSelection((current) => dismissAgentUiSurface(current, surface));
	}, [surface]);

	// The screen draws in its own on-screen window (main/screen-surface.ts), not in
	// this panel. Push it only when its identity or busy state changes, so a
	// streaming turn does not re-send the spec on every chunk.
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	useEffect(() => {
		const current = surfaceRef.current;
		window.island.surface.show({
			surface: surfaceKey && current ? current : null,
			updating: surfaceUpdating,
		});
	}, [surfaceKey, surfaceUpdating]);
	useEffect(
		() => () => window.island.surface.show({ surface: null, updating: false }),
		[]
	);
	const surfaceHandlersRef = useRef({
		dismiss: dismissSurface,
		submit: handleAgentUiSubmit,
	});
	surfaceHandlersRef.current = {
		dismiss: dismissSurface,
		submit: handleAgentUiSubmit,
	};
	useEffect(() => {
		// `handleAgentUiSubmit` validates the value like an in-chat submission.
		const offSubmit = window.island.surface.onSubmit((value) =>
			surfaceHandlersRef.current.submit(value)
		);
		const offDismiss = window.island.surface.onDismiss(() =>
			surfaceHandlersRef.current.dismiss()
		);
		return () => {
			offSubmit();
			offDismiss();
		};
	}, []);

	return (
		<div className="flex h-full w-full flex-col gap-2">
			<IslandChatHeader
				onMinimize={toggleCollapse}
				onOpenCommand={openCommand}
				title={hasHistory ? threadTitle(messages) : ""}
			/>
			<IslandNotesStrip notes={notes} onDismiss={clearNotes} />
			<div className="flex min-h-0 flex-1 flex-col gap-2">
				{offline ? (
					<IslandChatProblem
						onRetry={() => {
							probe().catch(() => setReachability("offline"));
						}}
						sentence={t(
							"island.core-unreachable",
							undefined,
							"Can't reach Ryu Core."
						)}
					/>
				) : null}
				{error ? (
					<IslandChatProblem
						details={error}
						onRetry={retryLastTurn}
						sentence={t(
							"island.reply-failed",
							undefined,
							"The reply didn't finish."
						)}
					/>
				) : null}
				<div className="min-h-0 flex-1">
					<IslandWidgetHost>
						<AgentUiSurfaceHostProvider value={surfaceHost}>
							<AgentChat
								attachments={{
									images: pendingAttachments.map((attachment) => ({
										filename: attachment.name,
										id: attachment.path,
										mimeType: attachment.mimeType,
										url: attachment.dataUrl,
									})),
									onRemoveImage: removeAttachment,
								}}
								composerDisabled={offline}
								composerMenuGroups={composerMenuGroups}
								density="compact"
								mentionItems={mentionItems}
								messages={messages}
								onAgentUiSubmit={handleAgentUiSubmit}
								onComposerMenuSelect={onComposerMenuSelect}
								onComposerResize={setComposerHeight}
								onSeedDraftConsumed={clearChatPrefill}
								onSend={(message) => sendTurn(message.content)}
								onStop={stop}
								seedDraft={chatPrefill ?? undefined}
								slots={{ InputBar: islandInputBar }}
								status={status}
							/>
						</AgentUiSurfaceHostProvider>
					</IslandWidgetHost>
				</div>
			</div>
		</div>
	);
}
