// The ONE full-composer slot shared by every non-ChatPage chat surface — the Ask
// Ryu floating/sidebar dock and the builder panes (agent · workflow · dashboard).
// It produces the SAME composer the main chat page renders: the Agent · Model ·
// Thinking settings menu (from `useComposerAgentControls` + `useComposerAcpSections`,
// the single source ChatPage/launchpad also use), STT voice input, the ChatGPT-style
// voice mode, image attachments (the "+"), and optional single-row compact layout
// / compact agent-picker trigger. Before this, each surface hand-rolled a lighter
// bar (or none), so the dock/builders silently lost the agent picker, thinking
// selector, voice, and attachments — the exact drift the user kept hitting
// ("still so different"). Route a surface through this and it can never drift
// from the chat page again.
//
// The slot identity must stay stable across renders or the textarea loses focus on
// every keystroke, so every injected prop rides a ref the memoized slot reads — the
// same pattern as ChatPage's `councilInputBar`.

import { createComposerDirectory } from "@ryu/blocks/composer/composer-directory.ts";
import { handleComposerSettingsShortcut } from "@ryu/blocks/composer/composer-shortcuts.ts";
import type { ChatVoiceMode } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComposerAgentControls } from "@/components/agent-elements/input/composer-agent-controls.tsx";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type {
	GhostControls,
	PluginComposerControlRow,
} from "@/components/agent-elements/input/goal-plus-button.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import {
	type AttachedImage,
	InputBar,
	type InputBarInfoBar,
	type InputBarProps,
} from "@/components/agent-elements/input-bar.tsx";
import { useVoiceLiveCall } from "@/src/components/voice/VoiceCallComposer.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	composerSelectionToastDescription,
	shouldShowComposerSelectionToast,
	useComposerSelectionApplyMode,
} from "@/src/hooks/useComposerSelectionApplyMode.ts";
import { useComposerShortcutBindings } from "@/src/hooks/useComposerShortcutBindings.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useVoiceMode } from "@/src/hooks/useVoiceMode.ts";
import {
	getVoiceInputPrefs,
	subscribePreferenceChanges,
	VOICE_PREF_KEY,
} from "@/src/lib/api/preferences.ts";
import { transcribeAudio } from "@/src/lib/api/voice.ts";
import {
	IMAGE_AND_TEXT_ACCEPT,
	stageImageAndTextFiles,
} from "@/src/lib/composer/attachments.ts";
import { recordRecent } from "@/src/lib/picker-favorites.ts";
import type {
	ComposerRuntime,
	ComposerSendFile,
	ComposerSlot,
	ComposerSlotOptions,
} from "./useComposerSlot-types.ts";

export type {
	ComposerRuntime,
	ComposerSendFile,
	ComposerSlot,
	ComposerSlotOptions,
} from "./useComposerSlot-types.ts";

/**
 * The shared full composer for the Ask Ryu dock + builder panes. Returns a stable
 * `InputBar` slot (agent/model/thinking controls + voice + voice mode + attach +
 * compact), the staged-image `attachments` for `AgentChat`, a `takeImages()` the
 * surface folds into its send, the composed `sections` for the empty-state logo,
 * and the voice-mode slot that can own the shared composer.
 */
export function useComposerSlot(
	runtime: ComposerRuntime,
	options: ComposerSlotOptions
): ComposerSlot {
	const {
		target,
		compact = false,
		compactTrigger = false,
		minimal = false,
		surface = "ask-ryu",
		placeholder,
		conversationId,
		ghost,
		onCreateAgent,
		onGenerateImage,
		onSelectTeam,
		isWorking = false,
		teamId,
		teams,
		pluginControls,
		voiceMode: voiceModeEnabled = true,
	} = options;
	const tl = useLiteralMessages();
	const { agents } = useAgents();
	const interfaceLevel = useInterfaceLevel();
	const selectableAgents = useMemo(
		() => agents.filter((agent) => agent.lifecycleStatus !== "draft"),
		[agents]
	);
	const [composerSelectionApplyMode] = useComposerSelectionApplyMode();
	const announceComposerSelection = useCallback(
		(setting: string, value: string) => {
			if (!shouldShowComposerSelectionToast(isWorking)) {
				return;
			}
			toast.info({
				id: "ryu-composer-selection-applied",
				title: `${setting}: ${value}`,
				description: composerSelectionToastDescription(
					composerSelectionApplyMode
				),
			});
		},
		[composerSelectionApplyMode, isWorking]
	);

	// The agent's ACP-advertised Model + Thinking/approval selectors, derived the
	// same way ChatPage and the launchpad derive them (shared hook), so this
	// surface's dropdown reads identically. Picks persist per-agent.
	// Changing Approval / Model / Thinking here is silent by design: the pick is
	// sticky and rides the NEXT turn's request body, which Core re-applies to the
	// live ACP session before that turn's prompt. Nothing on screen moves, so say
	// when it lands. One fixed toast slot, so dragging the thinking slider across
	// detents replaces in place instead of stacking a toast per detent.
	const handleAcpSelectionApplied = useCallback(
		(setting: string, value: string) => {
			announceComposerSelection(setting, value);
		},
		[announceComposerSelection]
	);
	const handleModelChange = useCallback(
		(modelId: string) => {
			runtime.setModel(modelId);
			announceComposerSelection("Model", modelId);
		},
		[announceComposerSelection, runtime.setModel]
	);

	const acp = useComposerAcpSections({
		agentId: runtime.agentId,
		agents: selectableAgents,
		modelOptions: runtime.modelOptions,
		engineModel: runtime.effectiveModel,
		onEngineModelChange: handleModelChange,
		onSelectionApplied: handleAcpSelectionApplied,
		preferSimpleApprovalDefaults: interfaceLevel === "simple",
	});
	useEffect(() => {
		runtime.setSimpleApprovalDefaults?.(
			interfaceLevel === "simple" ? acp.simpleApprovalDefaults : null
		);
	}, [
		acp.simpleApprovalDefaults,
		interfaceLevel,
		runtime.setSimpleApprovalDefaults,
	]);

	// The shared composer controls, driven by this surface's runtime selection.
	// Record every pick so the picker can offer "Recents" (see
	// `lib/picker-favorites.ts`). Purely local UI state — it never gates or
	// changes the selection, so a storage failure cannot break picking an agent.
	const handleSelectAgent = useCallback(
		(nextAgentId: string) => {
			recordRecent({ kind: "agent", agentId: nextAgentId });
			runtime.setAgentId(nextAgentId);
			const selectedAgent = selectableAgents.find(
				(candidate) => candidate.id === nextAgentId
			);
			announceComposerSelection("Agent", selectedAgent?.name ?? nextAgentId);
		},
		[announceComposerSelection, runtime.setAgentId, selectableAgents]
	);
	const handleSelectTeam = useCallback(
		(nextTeamId: string) => {
			onSelectTeam?.(nextTeamId);
			const selectedTeam = teams?.find(
				(candidate) => candidate.id === nextTeamId
			);
			announceComposerSelection("Agent", selectedTeam?.name ?? "Group");
		},
		[announceComposerSelection, onSelectTeam, teams]
	);

	const {
		infoBar,
		leftActions,
		rightActions,
		sections,
		triggerSections,
		renderBody,
	} = useComposerAgentControls({
		agents: selectableAgents,
		// Derived, never hardcoded: a dock/builder pane with no conversation yet
		// is opening one, which is the same first clause the turn path tests
		// (`req.conversation_id.is_none()`). Hardcoding false here would let a
		// cross-agent rule fire on a turn whose own composer said it wouldn't.
		atConversationStart: !conversationId,
		agentId: runtime.agentId,
		onSelectAgent: handleSelectAgent,
		teams,
		teamId,
		onSelectTeam: handleSelectTeam,
		onCreateAgent,
		modelOptions: runtime.modelOptions,
		model: runtime.effectiveModel,
		onModelChange: handleModelChange,
		modelSection: acp.modelSection,
		extraSections: acp.extraSections,
		compact,
		compactTrigger,
		surface,
	});
	const composerDirectory = useMemo(
		() => createComposerDirectory(sections),
		[sections]
	);

	// Staged attachments (the composer "+"): images as data URLs (also persisted
	// into the Uploads system space, best-effort) and readable text files as
	// `text/plain` parts, matching ChatPage.
	const [images, setImages] = useState<AttachedImage[]>([]);
	const addImages = useCallback(
		(files: File[]) => {
			const unsupported = stageImageAndTextFiles(
				target,
				files,
				(item) => setImages((prev) => [...prev, item]),
				(message) =>
					toast.error({ title: "Could not attach file", description: message })
			);
			if (unsupported.length > 0) {
				toast.error({
					title: "Can't attach these files yet",
					description: tl("{files} — images and text files are supported.", {
						files: unsupported.join(", "),
					}),
				});
			}
		},
		[target, tl]
	);
	const onAttach = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = IMAGE_AND_TEXT_ACCEPT;
		input.multiple = true;
		input.onchange = () => {
			if (input.files) {
				addImages(Array.from(input.files));
			}
		};
		input.click();
	}, [addImages]);
	const onPaste = useCallback(
		(e: React.ClipboardEvent) => addImages(Array.from(e.clipboardData.files)),
		[addImages]
	);
	const onRemoveImage = useCallback(
		(id: string) => setImages((prev) => prev.filter((img) => img.id !== id)),
		[]
	);
	const clearImages = useCallback(() => setImages([]), []);
	const imagesRef = useRef(images);
	imagesRef.current = images;
	const takeImages = useCallback((): ComposerSendFile[] | undefined => {
		const current = imagesRef.current;
		if (current.length === 0) {
			return;
		}
		setImages([]);
		return current.map((img) => ({
			type: "file" as const,
			mediaType: img.mimeType ?? "image/png",
			filename: img.filename,
			url: img.url,
		}));
	}, []);

	// Queued Ryu Clip context. Frames are pushed into `images` (so they render as
	// chips + ride `takeImages` unchanged); the markdown summary is buffered here
	// and folded into the outgoing text by the surface via `takeClipText`. Only
	// `setImages` (stable) + this ref (stable) are captured, so `attachClip` keeps
	// a stable identity without needing the liveRef indirection.
	const pendingClipText = useRef("");
	const attachClip = useCallback((text: string, frames: ComposerSendFile[]) => {
		if (frames.length > 0) {
			setImages((prev) => [
				...prev,
				...frames.map((frame, index) => ({
					id: `clip-${Date.now()}-${index}-${Math.random()}`,
					filename: frame.filename,
					url: frame.url,
					mimeType: "image/jpeg",
				})),
			]);
		}
		const trimmed = text.trim();
		if (trimmed) {
			pendingClipText.current = pendingClipText.current
				? `${pendingClipText.current}\n\n${trimmed}`
				: trimmed;
		}
	}, []);
	const takeClipText = useCallback((): string => {
		const text = pendingClipText.current;
		pendingClipText.current = "";
		return text;
	}, []);

	// STT dictation: a stable transcribe fn (reads the live node target via a ref)
	// so the memoized slot never remounts and drops textarea focus.
	const targetRef = useRef(target);
	targetRef.current = target;
	const [voiceInputEngine, setVoiceInputEngine] = useState<
		string | undefined
	>();
	useEffect(() => {
		let cancelled = false;
		const load = () => {
			getVoiceInputPrefs(target)
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
	}, [target]);
	const transcribe = useCallback(
		(audio: Blob) =>
			transcribeAudio(
				targetRef.current,
				audio,
				"recording.wav",
				voiceInputEngine
			),
		[voiceInputEngine]
	);

	// ChatGPT-style continuous voice mode — its own entry point, separate from the
	// push-to-talk dictation above. The active call surface receives the exact
	// composer node owned by AgentChat.
	const voiceModeState = useVoiceMode(target, {
		// A surface can sit on no agent at all (the launchpad before a pick), which
		// voice mode reads as "use the node default".
		agentId: runtime.agentId ?? undefined,
		agentName: agents.find((agent) => agent.id === runtime.agentId)?.name,
		conversationId,
		sttEngine: voiceInputEngine,
		onCallEnded: options.onCallEnded,
	});
	const composerShortcuts = useComposerShortcutBindings();

	// Every injected prop rides one ref so the memoized slot identity stays stable.
	const liveRef = useRef<{
		compact: boolean;
		ghost?: GhostControls;
		left: ReactNode;
		minimal: boolean;
		onGenerateImage?: (prompt: string) => void | Promise<void>;
		onStartVoiceMode: (() => void) | undefined;
		infoBar: InputBarInfoBar | undefined;
		placeholder?: string;
		pluginControls?: PluginComposerControlRow[];
		right: ReactNode;
		sections: ComposerSettingsSection[];
		shortcuts: typeof composerShortcuts;
	}>({
		compact,
		ghost,
		// The threshold-fallback notice, so a dock/builder composer says the same
		// thing the chat page does when a rule reroutes a turn.
		infoBar,
		left: leftActions,
		minimal,
		onGenerateImage,
		onStartVoiceMode: voiceModeEnabled ? voiceModeState.start : undefined,
		placeholder,
		pluginControls,
		right: rightActions,
		sections,
		shortcuts: composerShortcuts,
	});
	liveRef.current = {
		compact,
		ghost,
		infoBar,
		left: leftActions,
		minimal,
		onGenerateImage,
		onStartVoiceMode: voiceModeEnabled ? voiceModeState.start : undefined,
		placeholder,
		pluginControls,
		right: rightActions,
		sections,
		shortcuts: composerShortcuts,
	};

	const inputBar = useMemo(
		() =>
			function BoundComposerInputBar(props: InputBarProps) {
				const live = liveRef.current;
				return (
					<InputBar
						{...props}
						compact={live.minimal || live.compact}
						ghostControls={live.ghost}
						infoBar={live.infoBar}
						leftActions={live.minimal ? null : live.left}
						onGenerateImage={live.minimal ? undefined : live.onGenerateImage}
						onTextareaKeyDown={(event) => {
							if (
								handleComposerSettingsShortcut(
									event,
									live.sections,
									live.shortcuts
								)
							) {
								event.preventDefault();
							}
							props.onTextareaKeyDown?.(event);
						}}
						placeholder={live.placeholder ?? props.placeholder}
						pluginControls={live.pluginControls}
						rightActions={live.minimal ? null : live.right}
						voice={{ transcribe }}
						voiceMode={
							live.minimal || !live.onStartVoiceMode
								? undefined
								: { onStart: live.onStartVoiceMode }
						}
					/>
				);
			},
		[transcribe]
	);

	const voiceMode: ChatVoiceMode = useVoiceLiveCall(voiceModeState);

	return {
		attachClip,
		attachments: {
			addFiles: addImages,
			clear: clearImages,
			images,
			onAttach,
			onPaste,
			onRemoveImage,
		},
		composerMenuGroups: composerDirectory.groups,
		inputBar,
		mentionItems: composerDirectory.mentionItems,
		onComposerMenuSelect: composerDirectory.onSelect,
		renderBody,
		sections,
		triggerSections,
		takeClipText,
		takeImages,
		voiceMode,
	};
}
