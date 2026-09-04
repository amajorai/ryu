"use client";

import { ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Wave } from "@ryu/ui/components/wave";
import type { ContextUsage } from "../context-usage.tsx";
import type { ComposerMenuGroup, ComposerMenuItem } from "./composer-menu.tsx";
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
import { VoiceInputButton } from "./voice-input-button.tsx";

export interface ComposerToolbarProps {
	/** Textarea content placed between the control clusters in compact mode. */
	center?: React.ReactNode;
	/**
	 * Single-row layout for a compact one-line composer. Also keeps dictation in a
	 * dedicated control so the trailing action remains Send.
	 */
	compact?: boolean;
	/**
	 * Context-window usage for the persistent composer meter (a donut ring +
	 * used-percentage shown left of the model selector). Omit to hide the meter;
	 * the `ContextMeter` also self-hides when the window size or usage is unknown.
	 */
	contextMeter?: ContextUsage;
	/**
	 * Open the full context breakdown (the workspace Context tab). Omit and the
	 * meter stays a read-only ring — surfaces without workspace docks pass
	 * nothing.
	 */
	contextMeterOnOpen?: () => void;
	directoryGroups?: ComposerMenuGroup[];
	directoryQuery?: string;
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
	onDirectorySelect?: (item: ComposerMenuItem) => void;
	/** Open the larger dialog composer when the host feature is enabled. */
	onExpand?: () => void;
	/** Generate an image from the current composer text. */
	onGenerateImage?: () => void;
	/** Generate a video from the current composer text. */
	onGenerateVideo?: () => void;
	onMenuOpenChange?: (open: boolean) => void;
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
		| "showAttach"
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
		// Attach alone is enough to open the menu. Gating the dropdown on the
		// *optional* rows made the "+" mean two different things depending on the
		// surface: a dropdown on the chat page (goal/ghost/plugins/gen wired) but a
		// bare file dialog on the launchpad and the builder panes, which wire none
		// of them. The affordance is shared, so it must not degrade per host.
		showPlusMenu: Boolean(
			p.showAttach ||
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
 * send / stop / voice-mode button. Extracted from `input-bar.tsx` so the bar is
 * reusable and the input component stays focused on the textarea.
 */
export function ComposerToolbar({
	showAttach,
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
	directoryGroups,
	directoryQuery,
	onDirectorySelect,
	onExpand,
	onMenuOpenChange,
	isStreaming,
	hasInput,
	disabled,
	onStop,
	onSubmit,
	contextMeter,
	contextMeterOnOpen,
	voiceMode,
	compact = false,
	center,
}: ComposerToolbarProps) {
	// The primary action always reflects what the user can do next: a typed
	// message sends (and the host queues it when a turn is active), while Stop
	// appears only for an active turn with an empty composer. The idle empty state
	// is voice mode through SendButton's `voiceMode` prop.
	let sendState: "idle" | "typing" | "streaming" = "idle";
	if (hasInput && !disabled) {
		sendState = "typing";
	} else if (isStreaming) {
		sendState = "streaming";
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
		showAttach,
	});
	const showDirectory = Boolean(
		directoryGroups?.some((group) => group.items.length > 0)
	);

	const leftCluster = (
		<div
			className={
				compact
					? "flex shrink-0 items-center gap-1"
					: "flex min-w-0 items-center gap-1"
			}
		>
			{(showPlusMenu || showDirectory) && (
				<GoalPlusButton
					directoryGroups={directoryGroups}
					directoryQuery={directoryQuery}
					disabled={disabled}
					doubleCheck={doubleCheckControls}
					ghost={ghostControls}
					goal={goalControls}
					imageGen={imageGen}
					onAttach={showAttach ? onAttach : undefined}
					onDirectorySelect={onDirectorySelect}
					onMenuOpenChange={onMenuOpenChange}
					pluginControls={pluginControls}
					videoGen={videoGen}
				/>
			)}
			{leftActions}
		</div>
	);

	const rightCluster = (
		<div
			className={
				compact ? "flex shrink-0 items-center gap-1" : "flex items-center gap-1"
			}
		>
			{/* Context-window meter sits leftmost in the trailing cluster, just
			    before the model selector — the window is a model attribute. */}
			{contextMeter ? (
				<ContextMeter onOpen={contextMeterOnOpen} usage={contextMeter} />
			) : null}
			{/* Model selector (host-supplied) sits to the left of the mic. */}
			{rightActions}
			{onExpand && (
				<Button
					aria-label="Expand composer"
					className="size-8 text-muted-foreground hover:text-foreground"
					disabled={disabled}
					onClick={onExpand}
					size="icon"
					title="Expand composer"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={ExpandIcon} />
				</Button>
			)}
			{/* Recording is shown as the full-width waveform that replaces the
			    textarea (see input-bar). Here we only surface the transcribing
			    spinner-wave, so the two waveforms never render at once. */}
			{hasVoice && isTranscribing && (
				<Wave aria-label="Transcribing" className="h-4 w-7 text-primary" />
			)}
			{/* A right-side attach button used to live here, guarded on `!goalControls`
			    — one of several menu triggers, so it could render alongside the "+"
			    popover. It is unreachable now that attach alone opens the menu
			    (`showAttach` implies `showPlusMenu`), so the "+" dropdown is now the
			    attach affordance on every surface. */}
			{/* When live voice-mode owns the trailing slot, STT dictation moves to
				    its own small mic button here (left of the trailing waveform).
				    Hidden while a run streams — the trailing slot is Stop then, and a
				    mic beside it invites dictating into a composer that can't send. An
				    in-flight recording keeps its control so it can still be stopped. */}
			{hasVoice &&
				(compact || voiceMode) &&
				(!isStreaming || isRecording || isTranscribing) && (
					<VoiceInputButton
						disabled={voiceDisabled}
						isRecording={isRecording}
						isTranscribing={isTranscribing}
						onStart={onStartVoice}
						onStop={onStopVoice}
					/>
				)}
			{/* Trailing action: Send whenever text is present, Stop only for an
			    active turn with an empty composer, otherwise live voice mode (or STT). */}
			<SendButton
				onClick={() => {
					if (hasInput) {
						onSubmit();
					} else if (isStreaming) {
						onStop();
					}
				}}
				state={sendState}
				voice={
					hasVoice && !voiceMode && !compact
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

	if (compact) {
		return (
			<div
				className="flex min-h-12 items-center gap-2 px-3 py-2.5"
				data-composer-layout="compact"
			>
				{leftCluster}
				{center}
				{rightCluster}
			</div>
		);
	}

	// Full layout: leading and trailing controls share the row below the editor.
	return (
		<div
			className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-2"
			data-composer-layout="full"
		>
			{leftCluster}
			{rightCluster}
		</div>
	);
}
