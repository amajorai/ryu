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

import { createComposerDirectory } from "@ryu/blocks/composer/composer-directory";
import { handleComposerSettingsShortcut } from "@ryu/blocks/composer/composer-shortcuts";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu";
import type { ChatVoiceMode } from "@ryu/blocks/desktop/agent-elements/types";
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
import type {
	MentionItem,
	ModelOption,
} from "@/components/agent-elements/types.ts";
import { VoiceModeSurface } from "@/src/components/voice/VoiceModeSurface.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	composerSelectionToastDescription,
	shouldShowComposerSelectionToast,
	useComposerSelectionApplyMode,
} from "@/src/hooks/useComposerSelectionApplyMode.ts";
import { useComposerShortcutBindings } from "@/src/hooks/useComposerShortcutBindings.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useVoiceMode } from "@/src/hooks/useVoiceMode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import { stageImageUpload } from "@/src/lib/api/uploads.ts";
import { transcribeAudio } from "@/src/lib/api/voice.ts";
import type { SimpleApprovalDefaults } from "@/src/lib/chat-routing.ts";
import type { BrowserSurface } from "@/src/lib/extension-host.ts";
import { recordRecent } from "@/src/lib/picker-favorites.ts";

/** An AI-SDK file part, ready for `sendMessage({ text, files })`. */
export interface ComposerSendFile {
	filename: string;
	mediaType: string;
	type: "file";
	url: string;
}

export interface ComposerSlot {
	/**
	 * Attach a Ryu Clip: stage its key-moment frames as image chips (they are
	 * images, so they ride the existing image path with zero blocks changes) and
	 * queue the clip's markdown context summary to be prepended to the next
	 * outgoing turn. The surface's send handler calls {@link takeClipText} to
	 * fold that text in. Stable identity, safe to call from an effect/handler.
	 */
	attachClip: (text: string, frames: ComposerSendFile[]) => void;
	/** Pass to `<AgentChat attachments={...}>` so the composer "+" stages images. */
	attachments: {
		/**
		 * Stage dropped files. `AgentChat` handles its own drop zone, so only a
		 * surface that renders the `inputBar` directly (the launchpad) needs this.
		 */
		addFiles: (files: File[]) => void;
		/** Drop the staged images (after a surface has carried them elsewhere). */
		clear: () => void;
		images: AttachedImage[];
		onAttach: () => void;
		onPaste: (e: React.ClipboardEvent) => void;
		onRemoveImage: (id: string) => void;
	};
	/** Directory rows shared by the `+` menu and inline mention tokens. */
	composerMenuGroups: ComposerMenuGroup[];
	/** Stable `InputBar` slot for `AgentChat`'s `slots.InputBar`. */
	inputBar: (props: InputBarProps) => ReactNode;
	mentionItems: MentionItem[];
	onComposerMenuSelect: (item: ComposerMenuItem) => void;
	/**
	 * The universal picker body (Ryu (providers nested) · External Agents) — pass
	 * to `EmptyStateHeader`'s `renderBody` so its logo opens the identical grouped
	 * dropdown as the composer's settings trigger.
	 */
	renderBody: (close: () => void) => ReactNode;
	/**
	 * The composed Agent · Model · Thinking sections — the SAME ones inside the
	 * composer's settings menu.
	 *
	 * This is the FULL list, including contributed app pickers. It is what the
	 * composer's keyboard shortcuts act on, and
	 * what any surface rendering these as rows must use. A surface building its own
	 * settings TRIGGER wants {@link triggerSections} instead.
	 */
	sections: ComposerSettingsSection[];
	/**
	 * Pull the queued clip context text (from {@link attachClip}) and clear it.
	 * Call in the surface's send handler and prepend it to the outgoing text so
	 * the agent reads it as one leading `type:"text"` part. Returns `""` when no
	 * clip is queued, so the non-clip path is byte-identical.
	 */
	takeClipText: () => string;
	/**
	 * Pull the staged images as AI-SDK file parts and clear them. Call inside the
	 * surface's send handler:
	 * `const files = takeImages(); sendMessage(files ? { text, files } : { text });`
	 */
	takeImages: () => ComposerSendFile[] | undefined;
	/**
	 * {@link sections} narrowed to what a settings trigger should spell out — the
	 * contributed pickers are dropped, so an empty-state logo summarises exactly
	 * what the composer's own trigger does instead of listing one extra segment per
	 * installed app.
	 */
	triggerSections: ComposerSettingsSection[];
	/** Render the shared composer inside the active voice-mode call surface. */
	voiceMode: ChatVoiceMode;
}

/**
 * The agent/model selection a composer drives. `BuilderRuntime` satisfies it, and
 * so does any surface that owns those agent/model bindings itself (the launchpad keeps
 * its pick in localStorage, not in a builder runtime) — the slot never needed the
 * rest of a runtime, and demanding one is what pushed the launchpad into
 * hand-rolling its own bar.
 */
export interface ComposerRuntime {
	agentId: string | null;
	effectiveModel: string | null;
	modelOptions: ModelOption[];
	setAgentId: (id: string) => void;
	setModel: (id: string) => void;
	setSimpleApprovalDefaults?: (defaults: SimpleApprovalDefaults | null) => void;
}

export interface ComposerSlotOptions {
	/** Single-row compact layout (used once the thread has history). */
	compact?: boolean;
	/**
	 * Compact the agent-picker trigger only (`[logo] agent [usage]`), keeping the
	 * roomy stacked textarea. Used by the narrow Ask Ryu floating/docked panel.
	 */
	compactTrigger?: boolean;
	/** Bind voice-mode turns to this conversation so history persists. */
	conversationId?: string;
	/**
	 * Temporary-chat toggle for the "+" dropdown. Only a new-chat surface
	 * can offer it — an existing thread can't retroactively become unsaved — so it's
	 * opt-in per surface, not derived here.
	 */
	ghost?: GhostControls;
	/** Whether this surface currently has an agent turn in flight. */
	isWorking?: boolean;
	/**
	 * Use the floating assistant's quiet composer: one compact row, no visible
	 * agent/model summary, and no secondary generation/voice-mode buttons. The
	 * full settings menu remains available from the floating header.
	 */
	minimal?: boolean;
	/**
	 * Offer "Create new agent" in the agent picker. The surface routes it (a tab, a
	 * dialog), so it's a callback rather than a slot-owned navigation.
	 */
	onCreateAgent?: () => void;
	/**
	 * Text-to-image generation. When provided, the composer's toolbar gains an
	 * image button (the SAME one ChatPage wires) that takes the composer text as
	 * the prompt, generates via Core's `/api/images/generate`, and clears the
	 * draft — the host surfaces the result inline. Omit to hide the button (e.g.
	 * builder panes, where free-form image-gen doesn't belong). Mirrors `voice`:
	 * the draft text is owned by the InputBar, so the host receives only the prompt.
	 */
	onGenerateImage?: (prompt: string) => void | Promise<void>;
	/** Handle a group pick. Omit to hide the picker's Groups section entirely. */
	onSelectTeam?: (teamId: string) => void;
	/** Composer placeholder override (builders use "Describe what to build…"). */
	placeholder?: string;
	/** Plugin-registered toggle rows for this composer. */
	pluginControls?: PluginComposerControlRow[];
	/** Browser model-selection namespace for this shared composer surface. */
	surface?: BrowserSurface;
	/** Node target for voice STT + realtime voice mode. */
	target: ApiTarget;
	/** The picked team, when the surface can target one instead of an agent. */
	teamId?: string | null;
	/** Live groups for the picker's Groups section. */
	teams?: Team[];
}

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
	} = options;
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

	// Staged image attachments (the composer "+"). Data URL for the model turn;
	// also persisted into the Uploads system space (best-effort), matching ChatPage.
	const [images, setImages] = useState<AttachedImage[]>([]);
	const addImages = useCallback(
		(files: File[]) => {
			const imageFiles = files.filter((f) => f.type.startsWith("image/"));
			for (const file of imageFiles) {
				void stageImageUpload(target, file).then(({ dataUrl, upload }) => {
					setImages((prev) => [
						...prev,
						{
							id: upload?.id ?? `img-${Date.now()}-${Math.random()}`,
							filename: file.name,
							url: dataUrl,
							mimeType: file.type,
							size: file.size,
						},
					]);
				});
			}
		},
		[target]
	);
	const onAttach = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
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
	const transcribe = useCallback(
		(audio: Blob) => transcribeAudio(targetRef.current, audio),
		[]
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
	});
	const composerShortcuts = useComposerShortcutBindings();

	// Every injected prop rides one ref so the memoized slot identity stays stable.
	const liveRef = useRef<{
		compact: boolean;
		ghost?: GhostControls;
		left: ReactNode;
		minimal: boolean;
		onGenerateImage?: (prompt: string) => void | Promise<void>;
		onStartVoiceMode: () => void;
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
		onStartVoiceMode: voiceModeState.start,
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
		onStartVoiceMode: voiceModeState.start,
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
							live.minimal ? undefined : { onStart: live.onStartVoiceMode }
						}
					/>
				);
			},
		[transcribe]
	);

	const voiceMode: ChatVoiceMode = voiceModeState.active
		? {
				active: true,
				render: (composer) => (
					<VoiceModeSurface composer={composer} voice={voiceModeState} />
				),
			}
		: { active: false };

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
