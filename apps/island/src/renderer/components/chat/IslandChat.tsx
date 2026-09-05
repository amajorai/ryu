// The expanded-island mini chat wrapper. The presentational body lives in the
// shared desktop `AgentChat`; this file owns the chat state via
// useIslandChat, the Core reachability probe, the store prefill, and reports both
// whether there is history (so the island grows from a compact composer bar to the
// full panel) and the composer's height (so the compact bar tracks the draft).
//
// The transcript and composer are both shared primitives at compact density, so
// tool rows, MCP widgets, generated images, mentions, and directory dropdowns do
// not need island-local ports.

import { handleComposerSettingsShortcut } from "@ryu/blocks/composer/composer-shortcuts";
import { AgentChat } from "@ryu/blocks/desktop/agent-elements/agent-chat";
import {
	InputBar,
	type InputBarProps,
} from "@ryu/blocks/desktop/agent-elements/input-bar";
import { useI18n } from "@ryu/i18n/react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIslandComposerContext } from "../../context/island-composer-context.tsx";
import { useComposerShortcutBindings } from "../../hooks/use-composer-shortcut-bindings.ts";
import { IslandWidgetHost } from "../../host/IslandWidgetHost.tsx";
import { useIslandState } from "../../store/island-state.ts";
import { CommandIcon } from "../icons.tsx";
import { useIslandChat } from "./use-island-chat.ts";

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
	const { availablePacks, selectPack, selectedPackId, t } = useI18n();
	const commandPaletteLabel = t(
		"island.open-command-palette",
		undefined,
		"Open command palette"
	);
	const minimizeLabel = t("island.minimize", undefined, "Minimize");

	// The island is a short composer bar until a conversation exists, then it grows
	// to the full panel height.
	const hasHistory = messages.length > 0;
	useEffect(() => {
		setExpandedTall(hasHistory);
	}, [hasHistory, setExpandedTall]);

	const probe = useCallback(async (): Promise<void> => {
		setReachability("checking");
		const result = await window.island.core.health();
		setReachability(result.available ? "online" : "offline");
	}, []);

	useEffect(() => {
		probe().catch(() => setReachability("offline"));
	}, [probe]);

	const offline = reachability === "offline";

	const onComposerKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
			handleComposerSettingsShortcut(event, sections, composerShortcuts),
		[sections, composerShortcuts]
	);
	const onAttach = useCallback(() => {
		void window.island.system
			.attachFiles()
			.then(attachAndOpen)
			.catch(() => undefined);
	}, [attachAndOpen]);
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
	const inputBarPropsRef = useRef<{
		onAttach: () => void;
		onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
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
							if (
								live.onComposerKeyDown(
									event as KeyboardEvent<HTMLTextAreaElement>
								)
							) {
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
		(value: unknown) => {
			const content =
				typeof value === "string"
					? value
					: (JSON.stringify(value) ?? String(value));
			sendTurn(content);
		},
		[sendTurn]
	);

	return (
		<div className="flex h-full w-full flex-col gap-2">
			<header className="relative z-20 flex shrink-0 items-center justify-between px-1 pt-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="font-medium text-neutral-100 text-sm">
						{t("chat.new")}
					</span>
					<select
						aria-label={t("language.current")}
						className="max-w-32 truncate rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-300 outline-none"
						onChange={(event) => selectPack(event.target.value || null)}
						value={selectedPackId ?? ""}
					>
						<option value="">{t("common.english")}</option>
						{availablePacks
							.filter((pack) => pack.enabled !== false)
							.map((pack) => (
								<option key={pack.id} value={pack.id}>
									{pack.name}
								</option>
							))}
					</select>
				</div>
				<div className="flex items-center gap-0.5">
					<button
						aria-label={commandPaletteLabel}
						className="flex size-7 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100"
						onClick={openCommand}
						title={commandPaletteLabel}
						type="button"
					>
						<CommandIcon size={15} />
					</button>
					<button
						aria-label={t("island.minimize-ryu", undefined, "Minimize Ryu")}
						className="flex size-7 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100"
						onClick={toggleCollapse}
						title={minimizeLabel}
						type="button"
					>
						<span aria-hidden="true" className="text-lg leading-none">
							−
						</span>
					</button>
				</div>
			</header>
			{notes.length > 0 ? (
				<div className="relative z-20 shrink-0 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1.5">
					<div className="flex items-start justify-between gap-2">
						<span className="font-medium text-[10px] text-amber-300/90 uppercase tracking-wide">
							{t("island.note", undefined, "Note")}
						</span>
						<button
							aria-label={t("island.dismiss-notes", undefined, "Dismiss notes")}
							className="shrink-0 text-amber-200/70 hover:text-amber-100"
							onClick={clearNotes}
							type="button"
						>
							<svg
								aria-hidden="true"
								fill="none"
								height="10"
								stroke="currentColor"
								strokeLinecap="round"
								strokeWidth="2"
								viewBox="0 0 24 24"
								width="10"
							>
								<path d="M18 6 6 18M6 6l12 12" />
							</svg>
						</button>
					</div>
					{notes.map((note, index) => (
						<p
							className="mt-0.5 text-amber-100/90 text-xs leading-snug"
							// biome-ignore lint/suspicious/noArrayIndexKey: notes are append-only, ephemeral, and never reordered
							key={index}
						>
							{note}
						</p>
					))}
				</div>
			) : null}
			<div className="flex min-h-0 flex-1 flex-col">
				{offline ? (
					<p className="relative z-10 shrink-0 text-neutral-400 text-xs">
						{t("island.core-unreachable", undefined, "Can't reach Ryu Core.")}{" "}
						<button
							className="text-neutral-200 underline underline-offset-2 hover:text-neutral-100"
							onClick={probe}
							type="button"
						>
							{t("common.retry")}
						</button>
					</p>
				) : null}
				<div className="min-h-0 flex-1">
					<IslandWidgetHost>
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
							error={error ? new Error(error) : undefined}
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
					</IslandWidgetHost>
				</div>
			</div>
		</div>
	);
}
