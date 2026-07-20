"use client";

import { Button } from "@ryu/ui/components/button";
import { Wave } from "@ryu/ui/components/wave";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconLayersSubtract,
	IconLoader2,
	IconMicrophone,
	IconPlayerStopFilled,
} from "@tabler/icons-react";
import type { ContextUsage } from "../context-usage.tsx";
import { AttachmentButton } from "./attachment-button.tsx";
import { ContextMeter } from "./context-meter.tsx";
import {
	type DoubleCheckControls,
	type GhostControls,
	type GoalControls,
	GoalPlusButton,
	type MediaGenControls,
	type PluginComposerControlRow,
} from "./goal-plus-button.tsx";
import { SendButton } from "./send-button.tsx";

export interface ComposerToolbarProps {
	/** Render the attachment button on the right of the toolbar instead of the left. */
	attachRight: boolean;

	/**
	 * When true, an "Add to queue" button appears next to the Stop button so the
	 * user can stash the typed message while a run is in flight. Driven by the
	 * host's `enableQueue` + streaming + has-input state.
	 */
	canQueue?: boolean;

	/**
	 * The composer's textarea, rendered BETWEEN the left ("+") and right
	 * (model/mic/send) clusters when {@link compact} is on. Omit for the stacked
	 * layout (textarea above, this toolbar below).
	 */
	center?: React.ReactNode;

	/**
	 * Single-row "compact" layout: the "+" sits to the left of the textarea
	 * ({@link center}), which flexes to fill, and the trailing controls (model
	 * selector, mic, send) sit to its right — the whole composer on one line.
	 * Used on the chat page once a conversation has history. Defaults to the
	 * stacked layout (textarea above, controls row below).
	 */
	compact?: boolean;

	/**
	 * Context-window usage for the persistent composer meter (a donut ring +
	 * used-percentage shown left of the model selector). Omit to hide the meter;
	 * the `ContextMeter` also self-hides when the window size or usage is unknown.
	 */
	contextMeter?: ContextUsage;
	disabled?: boolean;

	/**
	 * Double-check (`/double-check`) affordances. When provided alongside
	 * `goalControls`, the "+" dropdown gains a "Double-check" toggle row.
	 */
	doubleCheckControls?: DoubleCheckControls;

	/**
	 * Temporary-chat (`ghost`) affordance. When provided, the "+" dropdown gains a
	 * "Temporary chat" toggle row. Omit to hide it.
	 */
	ghostControls?: GhostControls;

	/**
	 * Goal (`/goal`) affordances. When provided, the left "+" becomes a dropdown
	 * (Add photos & files | Pursue goal) and an active-goal chip renders beside it.
	 */
	goalControls?: GoalControls;

	/** When true, the "Generate image" button is rendered beside the mic. */
	hasImageGen?: boolean;
	hasInput: boolean;

	/** When true, the "Generate video" button is rendered beside image gen. */
	hasVideoGen?: boolean;

	/** When true, the microphone button + live waveform are rendered. */
	hasVoice: boolean;
	/** True while an image is being generated — disables the button + shows a spinner. */
	isGeneratingImage?: boolean;
	/** True while a video is being generated — disables the button + shows a spinner. */
	isGeneratingVideo?: boolean;
	isRecording: boolean;

	isStreaming: boolean;
	isTranscribing: boolean;

	/** Content rendered on the left, next to the attachment button. */
	leftActions?: React.ReactNode;
	onAttach?: () => void;
	/** Generate an image from the current composer text. */
	onGenerateImage?: () => void;
	/** Generate a video from the current composer text. */
	onGenerateVideo?: () => void;
	onStartVoice: () => void;
	onStop: () => void;
	onStopVoice: () => void;
	onSubmit: () => void;
	/** Plugin-contributed composer toggles, rendered in the "+" dropdown. */
	pluginControls?: PluginComposerControlRow[];
	/** Content rendered on the right, before the send button. */
	rightActions?: React.ReactNode;
	/** Whether the attachment button is shown at all. */
	showAttach: boolean;
	voiceDisabled?: boolean;

	/**
	 * Live voice-mode (realtime conversation) entry. When provided, the trailing
	 * button's empty state becomes the voice-mode waveform, and STT dictation
	 * (`hasVoice`) relocates to its own small mic button in this row.
	 */
	voiceMode?: { disabled?: boolean; onStart: () => void };
}

/**
 * The small push-to-talk STT (dictation) button. Only rendered when live
 * voice-mode owns the trailing slot — otherwise STT stays in the trailing
 * SendButton slot (see `SendButton`'s `voice` branch). Morphs mic → stop →
 * spinner across idle / recording / transcribing.
 */
function VoiceInputButton({
	disabled,
	isRecording,
	isTranscribing,
	onStart,
	onStop,
}: {
	disabled?: boolean;
	isRecording: boolean;
	isTranscribing: boolean;
	onStart: () => void;
	onStop: () => void;
}) {
	if (isTranscribing) {
		return (
			<Button
				aria-label="Transcribing"
				className="size-7 text-muted-foreground"
				disabled
				size="icon"
				title="Transcribing…"
				type="button"
				variant="ghost"
			>
				<IconLoader2 className="size-4 animate-spin" />
			</Button>
		);
	}
	if (isRecording) {
		return (
			<Button
				aria-label="Stop recording"
				className="size-7 text-destructive hover:text-destructive"
				onClick={onStop}
				size="icon"
				title="Stop recording"
				type="button"
				variant="ghost"
			>
				<IconPlayerStopFilled className="size-3.5" />
			</Button>
		);
	}
	return (
		<Button
			aria-label="Start voice input"
			className="size-7 text-muted-foreground hover:text-foreground"
			disabled={disabled}
			onClick={onStart}
			size="icon"
			title="Voice input"
			type="button"
			variant="ghost"
		>
			<IconMicrophone className="size-4" />
		</Button>
	);
}

/**
 * Build the `MediaGenControls` for a "+" dropdown gen row, or `undefined` when
 * the feature isn't wired.
 */
function buildMediaGen(
	enabled: boolean | undefined,
	onGenerate: (() => void) | undefined,
	generating: boolean | undefined,
	disabled: boolean
): MediaGenControls | undefined {
	if (!(enabled && onGenerate)) {
		return undefined;
	}
	return { onGenerate, generating: Boolean(generating), disabled };
}

/**
 * Resolve the "+" dropdown's media-generation rows and whether the menu should
 * render at all. Kept out of the component body so its boolean chains don't
 * inflate the toolbar's cognitive complexity.
 */
function resolvePlusMenu(
	p: Pick<
		ComposerToolbarProps,
		| "disabled"
		| "isStreaming"
		| "hasInput"
		| "goalControls"
		| "ghostControls"
		| "pluginControls"
		| "hasImageGen"
		| "onGenerateImage"
		| "isGeneratingImage"
		| "hasVideoGen"
		| "onGenerateVideo"
		| "isGeneratingVideo"
	>
): {
	imageGen: MediaGenControls | undefined;
	videoGen: MediaGenControls | undefined;
	showPlusMenu: boolean;
} {
	// Disable a gen row while a run is streaming or the composer is empty —
	// there'd be no prompt to generate from.
	const genDisabled = Boolean(p.disabled) || p.isStreaming || !p.hasInput;
	const imageGen = buildMediaGen(
		p.hasImageGen,
		p.onGenerateImage,
		p.isGeneratingImage,
		genDisabled
	);
	const videoGen = buildMediaGen(
		p.hasVideoGen,
		p.onGenerateVideo,
		p.isGeneratingVideo,
		genDisabled
	);
	return {
		imageGen,
		videoGen,
		showPlusMenu: Boolean(
			p.goalControls ||
				p.ghostControls ||
				p.pluginControls?.length ||
				imageGen ||
				videoGen
		),
	};
}

/**
 * The composer's controls row — rendered INSIDE the textarea card (Codex-style),
 * directly under the textarea and sharing its rounded background. Holds the
 * attachment / "+" button, model selector (rightActions), voice controls, and the
 * send / stop / queue button. Extracted from `input-bar.tsx` so the bar is
 * reusable and the input component stays focused on the textarea.
 */
export function ComposerToolbar({
	showAttach,
	attachRight,
	onAttach,
	goalControls,
	ghostControls,
	doubleCheckControls,
	pluginControls,
	leftActions,
	rightActions,
	hasVoice,
	isRecording,
	isTranscribing,
	onStartVoice,
	onStopVoice,
	voiceDisabled,
	hasImageGen,
	isGeneratingImage,
	onGenerateImage,
	hasVideoGen,
	isGeneratingVideo,
	onGenerateVideo,
	isStreaming,
	hasInput,
	disabled,
	onStop,
	onSubmit,
	canQueue,
	contextMeter,
	voiceMode,
	compact,
	center,
}: ComposerToolbarProps) {
	let sendState: "idle" | "typing" | "streaming" = "idle";
	if (isStreaming) {
		sendState = "streaming";
	} else if (hasInput && !disabled) {
		sendState = "typing";
	}

	// Media generation lives in the "+" dropdown (alongside Goal / Double-check),
	// not as standalone buttons. The rows + visibility are resolved in a helper to
	// keep this component's complexity in check.
	const { imageGen, videoGen, showPlusMenu } = resolvePlusMenu({
		disabled,
		isStreaming,
		hasInput,
		goalControls,
		ghostControls,
		pluginControls,
		hasImageGen,
		onGenerateImage,
		isGeneratingImage,
		hasVideoGen,
		onGenerateVideo,
		isGeneratingVideo,
	});

	const leftCluster = (
		<div
			className={cn(
				"flex items-center gap-1",
				compact ? "shrink-0" : "min-w-0"
			)}
		>
			{showPlusMenu ? (
				<GoalPlusButton
					disabled={disabled}
					doubleCheck={doubleCheckControls}
					ghost={ghostControls}
					goal={goalControls}
					imageGen={imageGen}
					onAttach={showAttach ? onAttach : undefined}
					pluginControls={pluginControls}
					videoGen={videoGen}
				/>
			) : (
				!attachRight &&
				showAttach &&
				onAttach && <AttachmentButton onClick={onAttach} />
			)}
			{leftActions}
		</div>
	);

	const rightCluster = (
		<div className={cn("flex items-center gap-1", compact && "shrink-0")}>
			{/* Context-window meter sits leftmost in the trailing cluster, just
			    before the model selector — the window is a model attribute. */}
			{contextMeter ? <ContextMeter usage={contextMeter} /> : null}
			{/* Model selector (host-supplied) sits to the left of the mic. */}
			{rightActions}
			{/* Recording is shown as the full-width waveform that replaces the
			    textarea (see input-bar). Here we only surface the transcribing
			    spinner-wave, so the two waveforms never render at once. */}
			{hasVoice && isTranscribing && (
				<Wave aria-label="Transcribing" className="h-4 w-7 text-primary" />
			)}
			{!goalControls && attachRight && showAttach && onAttach && (
				<AttachmentButton onClick={onAttach} />
			)}
			{/* While a run is streaming and the user has typed, offer an explicit
				    "queue" affordance alongside the Stop button so the behaviour is
				    discoverable (Enter also queues). */}
			{canQueue && (
				<Button
					aria-label="Add message to queue"
					className="size-7 shrink-0 text-muted-foreground/80 hover:text-foreground"
					onClick={onSubmit}
					size="icon"
					title="Queue this message — sends when the current run finishes"
					type="button"
					variant="ghost"
				>
					<IconLayersSubtract className="size-4" />
				</Button>
			)}
			{/* When live voice-mode owns the trailing slot, STT dictation moves to
				    its own small mic button here (left of the trailing waveform). */}
			{hasVoice && voiceMode && (
				<VoiceInputButton
					disabled={voiceDisabled}
					isRecording={isRecording}
					isTranscribing={isTranscribing}
					onStart={onStartVoice}
					onStop={onStopVoice}
				/>
			)}
			{/* Trailing action: live voice-mode waveform when the composer is empty
				    (or the STT mic when no voice-mode is wired), morphing into Send once
				    the user types, or Stop while streaming. */}
			<SendButton
				onClick={() => {
					if (isStreaming) {
						onStop();
					} else if (hasInput) {
						onSubmit();
					}
				}}
				state={sendState}
				voice={
					hasVoice && !voiceMode
						? {
								isRecording,
								isTranscribing,
								disabled: voiceDisabled,
								onStart: onStartVoice,
								onStop: onStopVoice,
							}
						: undefined
				}
				voiceMode={voiceMode}
			/>
		</div>
	);

	// Compact single-row layout: "+" · textarea (flexes) · model/mic/send, all on
	// one line. `items-end` keeps the "+" and send pinned to the bottom as the
	// textarea grows past one row (ChatGPT/Claude-style).
	if (compact) {
		return (
			<div className="flex items-end gap-1.5 px-2 py-2">
				{leftCluster}
				{center}
				{rightCluster}
			</div>
		);
	}

	// Stacked layout (default): controls row beneath the textarea.
	return (
		<div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-2">
			{leftCluster}
			{rightCluster}
		</div>
	);
}
