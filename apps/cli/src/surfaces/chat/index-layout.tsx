/* @jsxImportSource @opentui/react */
// Chat surface layout: composer dock measurement, Ctrl+C handling, status
// hints, and the rendered transcript, queue, workspace bar and composer.

import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatQueueBar } from "../../components/ChatQueueBar.tsx";
import { ChatQueueOverlay } from "../../components/ChatQueueOverlay.tsx";
import { useInterruptHandler } from "../../core/InputFocusContext.tsx";
import { resetPromptNavigation } from "../../core/promptHistory.ts";
import { useStatusContribution } from "../../ui/StatusContext.tsx";
import { AutocompleteView } from "./autocomplete.tsx";
import {
	CHAT_AGENT_HINT,
	COMPOSER_KEY_BINDINGS,
	composerMaxHeight,
	queueBarClearHint,
} from "./index-constants.ts";
import type { ChatSurfaceContext } from "./index-context.ts";
import { OverlayView } from "./overlays.tsx";
import { PermissionPrompt } from "./PermissionPrompt.tsx";
import { busyActivityLabel, StatusLine, WorkspaceBar } from "./statusBar.tsx";
import { Transcript } from "./transcript.tsx";
import { JumpToLatestStrip } from "./transcriptScroll.tsx";

type ChatComposerDockDeps = Pick<
	ChatSurfaceContext,
	| "autocomplete"
	| "composerInputRef"
	| "composerRef"
	| "externalOverlayId"
	| "focused"
	| "interruptTurn"
	| "overlay"
	| "overlayOpen"
	| "paneId"
	| "pastedTextRef"
	| "queueFocused"
	| "setAutocomplete"
	| "setComposerText"
	| "shellKeyboardCaptured"
	| "simpleInterface"
	| "streaming"
>;

export function useChatComposerDock(deps: ChatComposerDockDeps) {
	const {
		autocomplete,
		composerInputRef,
		composerRef,
		externalOverlayId,
		focused,
		interruptTurn,
		overlay,
		overlayOpen,
		paneId,
		pastedTextRef,
		queueFocused,
		setAutocomplete,
		setComposerText,
		shellKeyboardCaptured,
		simpleInterface,
		streaming,
	} = deps;
	const terminal = useTerminalDimensions();
	// The completion list floats upward from the composer dock, so its height
	// budget is the dock's distance from the top of the screen.
	const composerDockRef = useRef<BoxRenderable | null>(null);
	const [composerDockTop, setComposerDockTop] = useState<number | null>(null);
	const measureComposerDock = useCallback(() => {
		const top = composerDockRef.current?.y;
		if (top !== undefined) {
			setComposerDockTop(top);
		}
	}, []);
	const autocompleteOpen = autocomplete !== null;
	useEffect(() => {
		if (autocompleteOpen && terminal.height > 0) {
			measureComposerDock();
		}
	}, [autocompleteOpen, measureComposerDock, terminal.height]);
	const permissionPrompt = overlay.kind === "permission" ? overlay : null;
	// This pane owns the keyboard: no shell layer (palette, node picker,
	// sidebar focus mode, shell overlay) has taken it.
	const keysOwned = focused && !shellKeyboardCaptured && !externalOverlayId;
	const composerFocused = keysOwned && !overlayOpen && !queueFocused;

	// Ctrl+C (offered by the shell): stop a running stream, else clear a draft.
	// Returning false lets the shell arm its two-press quit. The shell decides;
	// this surface never handles Ctrl+C in its own useKeyboard.
	useInterruptHandler(() => {
		if (streaming) {
			// The same stop as Esc: keep the partial reply, mark it interrupted
			// and pause the queue.
			interruptTurn();
			return true;
		}
		const draft = composerInputRef.current?.plainText ?? composerRef.current;
		if (draft === "") {
			return false;
		}
		setComposerText("");
		pastedTextRef.current.clear();
		setAutocomplete(null);
		return true;
	}, composerFocused);

	// The busy clock lives in the pane's own StatusLine (activity, elapsed and
	// the esc hint), so Chat publishes only its key hints to the shell bar; a
	// second spinner there would repeat the row right above it.
	// The shortcuts overlay hint (F1 keys) is a shell global.
	useStatusContribution(paneId, {
		hints: simpleInterface ? [] : [CHAT_AGENT_HINT],
	});
	return {
		composerDockRef,
		composerDockTop,
		composerFocused,
		keysOwned,
		measureComposerDock,
		permissionPrompt,
		terminal,
	};
}

type ChatSurfaceView = Pick<
	ChatSurfaceContext,
	| "acpModel"
	| "activeTool"
	| "autocomplete"
	| "clearQueuedMessages"
	| "composerInputRef"
	| "composerRef"
	| "configuredModel"
	| "coreDown"
	| "doubleCheckOn"
	| "expandPrompts"
	| "handleComposerPaste"
	| "messages"
	| "moveQueuedMessageAt"
	| "openQueue"
	| "overlay"
	| "overlayOpen"
	| "permissionBodyRef"
	| "queueFocused"
	| "queuePaused"
	| "queueSelectedIndex"
	| "queuedMessages"
	| "recentRows"
	| "removeQueuedMessageAt"
	| "routeAgent"
	| "routeTeam"
	| "sessionMeter"
	| "setComposer"
	| "setDismissedSlashArgumentValue"
	| "setOverlay"
	| "setQueueFocused"
	| "setQueueSelectedIndex"
	| "setTurnError"
	| "setVisibleRecentCount"
	| "simpleInterface"
	| "starterPlaceholder"
	| "streamStartedAt"
	| "streaming"
	| "submitComposer"
	| "submitPermission"
	| "theme"
	| "transcriptScroll"
	| "updatePromptHistory"
> &
	ReturnType<typeof useChatComposerDock>;

export function renderChatSurface(view: ChatSurfaceView) {
	const {
		acpModel,
		activeTool,
		autocomplete,
		clearQueuedMessages,
		composerDockRef,
		composerDockTop,
		composerFocused,
		composerInputRef,
		composerRef,
		configuredModel,
		coreDown,
		doubleCheckOn,
		expandPrompts,
		handleComposerPaste,
		keysOwned,
		measureComposerDock,
		messages,
		moveQueuedMessageAt,
		openQueue,
		overlay,
		overlayOpen,
		permissionBodyRef,
		permissionPrompt,
		queueFocused,
		queuePaused,
		queueSelectedIndex,
		queuedMessages,
		recentRows,
		removeQueuedMessageAt,
		routeAgent,
		routeTeam,
		sessionMeter,
		setComposer,
		setDismissedSlashArgumentValue,
		setOverlay,
		setQueueFocused,
		setQueueSelectedIndex,
		setTurnError,
		setVisibleRecentCount,
		simpleInterface,
		starterPlaceholder,
		streamStartedAt,
		streaming,
		submitComposer,
		submitPermission,
		terminal,
		theme,
		transcriptScroll,
		updatePromptHistory,
	} = view;
	return (
		<box flexDirection="column" flexGrow={1}>
			<Transcript
				agent={routeAgent}
				coreDown={coreDown}
				expandPrompts={expandPrompts}
				messages={messages}
				onScrollActivity={transcriptScroll.sync}
				onVisibleRecentsChange={setVisibleRecentCount}
				pendingPermissionToolCallId={permissionPrompt?.detail.toolCallId}
				recents={recentRows}
				scrollRef={transcriptScroll.ref}
				simpleInterface={simpleInterface}
				streaming={streaming}
				team={routeTeam}
			/>
			{messages.length > 0 ? (
				<JumpToLatestStrip
					awayFromBottom={transcriptScroll.awayFromBottom}
					newCount={transcriptScroll.newCount}
					onJump={() => transcriptScroll.scroll("bottom")}
				/>
			) : null}
			<StatusLine
				activity={busyActivityLabel(overlay.kind, activeTool)}
				doubleCheckOn={doubleCheckOn}
				interruptible={composerFocused}
				startedAt={streaming ? streamStartedAt : null}
			/>
			{queuedMessages.length > 0 ? (
				<ChatQueueBar
					clearHint={queueBarClearHint(queuePaused, streaming)}
					focused={keysOwned && queueFocused && !overlayOpen}
					focusHint={
						queuePaused ? "Paused · Enter send next" : "Ctrl+Q inspect"
					}
					items={queuedMessages}
					onCancel={() => setQueueFocused(false)}
					onClear={clearQueuedMessages}
					onFocus={() => openQueue(queueSelectedIndex)}
					onMove={moveQueuedMessageAt}
					onRemove={removeQueuedMessageAt}
					onSelect={(index) => setQueueSelectedIndex(index)}
					selectedIndex={queueSelectedIndex}
				/>
			) : null}
			<WorkspaceBar
				agent={routeAgent}
				meter={simpleInterface ? "" : sessionMeter}
				model={
					simpleInterface
						? null
						: (acpModel ??
							(configuredModel?.agentId === routeAgent
								? configuredModel.model
								: null))
				}
				showModel={!simpleInterface}
				team={routeTeam}
			/>
			{/* A pending tool permission takes the composer's place. The composer
			    stays mounted but hidden so its draft and cursor survive. */}
			{permissionPrompt ? (
				<PermissionPrompt
					bodyScrollRef={permissionBodyRef}
					detail={permissionPrompt.detail}
					index={permissionPrompt.index}
					onChoose={(index) => {
						const option = permissionPrompt.permission.options[index];
						if (option) {
							submitPermission(permissionPrompt.permission, option);
						}
					}}
					permission={permissionPrompt.permission}
					terminal={terminal}
				/>
			) : null}
			{/* The completion list floats above the composer, so the transcript
			    keeps its height while suggestions change. */}
			<box
				flexDirection="column"
				flexShrink={1}
				minHeight={3}
				onSizeChange={measureComposerDock}
				ref={composerDockRef}
				visible={permissionPrompt === null}
			>
				{autocomplete ? (
					<AutocompleteView
						maxHeight={composerDockTop ?? Math.max(0, terminal.height - 4)}
						state={autocomplete}
					/>
				) : null}
				<box
					borderColor={
						composerFocused ? theme.colors.focusRing : theme.colors.border
					}
					borderStyle="rounded"
					flexDirection="row"
					// Only the composer shrinks when a tall draft, the busy row and the
					// queue overflow a short terminal; it keeps one text row and its border.
					flexShrink={1}
					gap={1}
					minHeight={3}
					paddingLeft={1}
					paddingRight={1}
				>
					<text alignSelf="flex-start" fg={theme.colors.primary} flexShrink={0}>
						{"›"}
					</text>
					<textarea
						cursorColor={theme.colors.primary}
						flexGrow={1}
						focused={composerFocused}
						// The textarea copies textColor into its focused colour only at
						// construction; pass both so a theme loaded or picked after mount
						// (light theme) recolours the draft instead of leaving it white.
						focusedTextColor={theme.colors.foreground}
						keyBindings={COMPOSER_KEY_BINDINGS}
						maxHeight={composerMaxHeight(terminal.height)}
						minHeight={1}
						onContentChange={() => {
							const value = composerInputRef.current?.plainText ?? "";
							const previousValue = composerRef.current;
							if (value === previousValue) {
								// App-driven updates (history, reset, completion) set the ref
								// first; they keep the history cursor and dismissal state.
								return;
							}
							setDismissedSlashArgumentValue(null);
							setTurnError(null);
							composerRef.current = value;
							setComposer(value);
							updatePromptHistory(resetPromptNavigation);
						}}
						onPaste={handleComposerPaste}
						onSubmit={submitComposer}
						placeholder={
							streaming
								? composerFocused
									? "Queue a follow-up… (Enter queue · Esc interrupt)"
									: "Queue a follow-up…"
								: simpleInterface
									? "Message · pinned to Ryu · /help"
									: messages.length === 0
										? starterPlaceholder
										: "Message · Ctrl+A agent · Ctrl+R ACP · /help"
						}
						placeholderColor={theme.colors.mutedForeground}
						ref={composerInputRef}
						textColor={theme.colors.foreground}
						wrapMode="word"
					/>
				</box>
			</box>
			{overlay.kind === "none" ||
			overlay.kind === "permission" ? null : overlay.kind === "queue" ? (
				<ChatQueueOverlay
					focused={keysOwned}
					items={queuedMessages}
					onCancel={() => setOverlay({ kind: "none" })}
					onClear={clearQueuedMessages}
					onMove={moveQueuedMessageAt}
					onRemove={removeQueuedMessageAt}
					onSelect={(index) => {
						setQueueSelectedIndex(index);
						setOverlay((state) =>
							state.kind === "queue" ? { ...state, index } : state
						);
					}}
					selectedIndex={queueSelectedIndex}
				/>
			) : (
				// Pickers, help and the keymap render as a pane-local Modal (absolute
				// over this surface); permission and question stay docked in flow.
				<OverlayView
					focused={keysOwned}
					onClose={() => setOverlay({ kind: "none" })}
					overlay={overlay}
				/>
			)}
		</box>
	);
}
