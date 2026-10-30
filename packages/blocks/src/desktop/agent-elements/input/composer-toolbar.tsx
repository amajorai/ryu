"use client";

import { ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Wave } from "@ryu/ui/components/wave";
import { motion, type Transition } from "motion/react";
import type { ContextUsage } from "../context-usage.tsx";
import type { ComposerMenuGroup, ComposerMenuItem } from "./composer-menu.tsx";
import { ContextMeter } from "./context-meter.tsx";
import {
	type ComposerDraftMenu,
	type DoubleCheckControls,
	type GhostControls,
	type GoalControls,
	GoalPlusButton,
	type PluginComposerControlRow,
} from "./goal-plus-button.tsx";
import { SendButton, VoiceCallButton } from "./send-button.tsx";
import { VoiceInputButton } from "./voice-input-button.tsx";

export interface ComposerToolbarProps {
	/** Editor content kept in one stable slot across compact and full layouts. */
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
	/** "Save draft" and the saved drafts, offered in the "+" dropdown. */
	drafts?: ComposerDraftMenu;

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
	/**
	 * Live-call controls. When set, the row collapses to a single line of "+",
	 * the call (`center`), and these controls; host left/right actions, voice
	 * input, and Send are hidden because the call owns the composer. The "+"
	 * menu also drops its image/video generation and @ directory rows, which
	 * would read or rewrite the hidden draft.
	 */
	liveCallActions?: React.ReactNode;
	/** Whether the shared-layout morph is enabled for this toolbar. */
	motionEnabled?: boolean;
	onAttach?: () => void;
	onDirectorySelect?: (item: ComposerMenuItem) => void;
	/** Open the larger dialog composer when the host feature is enabled. */
	onExpand?: () => void;
	/** Generate an image from the current composer text. */
	onGenerateImage?: () => void;
	/** Generate a video from the current composer text. */
	onGenerateVideo?: () => void;
	onMenuOpenChange?: (open: boolean) => void;
	/** Open the app-owned sketch dialog. */
	onSketch?: () => void;
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
	/** Motion transition used for the compact/full layout handoff. */
	transition?: Transition;
	voiceDisabled?: boolean;

	/**
	 * Live voice-mode (realtime conversation) entry. When provided, a quiet call
	 * button sits beside the mic, STT dictation (`hasVoice`) has its own small mic
	 * button in this row, and Send keeps the trailing slot.
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
) {
	if (!(enabled && onGenerate)) {
		return undefined;
	}
	return { onGenerate, generating: Boolean(generating), disabled };
}

/**
 * Resolve the "+" dropdown's media-generation and directory rows and whether the
 * menu should render at all. Kept out of the component body so its boolean
 * chains don't inflate the toolbar's cognitive complexity.
 *
 * A live call hides the typed draft (it comes back when the call ends), so the
 * rows that read or rewrite that draft — image/video generation and the @
 * directory — are withheld while the call owns the composer; attach, sketch,
 * goal, and plugin rows stay.
 */
export function resolvePlusMenu(
	p: Pick<
		ComposerToolbarProps,
		| "directoryGroups"
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
		| "onSketch"
		| "drafts"
	> & { inLiveCall?: boolean }
) {
	// A gen row generates from the composer text, so it is hidden while the
	// composer is empty (there is no prompt yet) and disabled while a run streams.
	const genDisabled = Boolean(p.disabled) || p.isStreaming;
	const genAvailable = !p.inLiveCall && p.hasInput;
	const imageGen = buildMediaGen(
		genAvailable ? p.hasImageGen : false,
		p.onGenerateImage,
		p.isGeneratingImage,
		genDisabled
	);
	const videoGen = buildMediaGen(
		genAvailable ? p.hasVideoGen : false,
		p.onGenerateVideo,
		p.isGeneratingVideo,
		genDisabled
	);
	const directoryGroups = p.inLiveCall ? undefined : p.directoryGroups;
	return {
		directoryGroups,
		imageGen,
		videoGen,
		showDirectory: Boolean(
			directoryGroups?.some((group) => group.items.length > 0)
		),
		// Attach alone is enough to open the menu. Gating the dropdown on the
		// *optional* rows made the "+" mean two different things depending on the
		// surface: a dropdown on the chat page (goal/ghost/plugins/gen wired) but a
		// bare file dialog on the launchpad and the builder panes, which wire none
		// of them. The affordance is shared, so it must not degrade per host.
		showPlusMenu: Boolean(
			p.showAttach ||
				p.onSketch ||
				p.goalControls ||
				p.ghostControls ||
				p.pluginControls?.length ||
				p.drafts ||
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
	onSketch,
	goalControls,
	ghostControls,
	doubleCheckControls,
	pluginControls,
	leftActions,
	liveCallActions,
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
	drafts,
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
	compact: compactLayout = false,
	center,
	motionEnabled = true,
	transition,
}: ComposerToolbarProps) {
	// The primary action always reflects what the user can do next: a typed
	// message sends (and the host queues it when a turn is active), while Stop
	// appears only for an active turn with an empty composer. The idle empty state
	// is a dimmed Send (or STT dictation when the host has no voice mode).
	const inLiveCall = liveCallActions !== undefined;
	const compact = compactLayout || inLiveCall;
	let sendState: "idle" | "typing" | "streaming" = "idle";
	if (hasInput && !disabled) {
		sendState = "typing";
	} else if (isStreaming) {
		sendState = "streaming";
	}

	// Media generation lives in the "+" dropdown (alongside Goal / Double-check),
	// not as standalone buttons. The rows + visibility are resolved in a helper to
	// keep this component's complexity in check (including what a live call
	// withholds).
	const {
		directoryGroups: menuDirectoryGroups,
		imageGen,
		videoGen,
		showDirectory,
		showPlusMenu,
	} = resolvePlusMenu({
		directoryGroups,
		disabled,
		isStreaming,
		hasInput,
		goalControls,
		ghostControls,
		inLiveCall,
		pluginControls,
		hasImageGen,
		onGenerateImage,
		isGeneratingImage,
		hasVideoGen,
		onGenerateVideo,
		isGeneratingVideo,
		showAttach,
		onSketch,
		drafts,
	});

	const leftCluster = (
		<motion.div
			className={
				compact
					? "col-start-1 row-start-1 flex shrink-0 items-center gap-1"
					: "flex min-w-0 items-center gap-1"
			}
			layout={motionEnabled ? "position" : false}
			transition={transition}
		>
			{(showPlusMenu || showDirectory) && (
				<GoalPlusButton
					directoryGroups={menuDirectoryGroups}
					directoryQuery={directoryQuery}
					disabled={disabled}
					doubleCheck={doubleCheckControls}
					drafts={inLiveCall ? undefined : drafts}
					ghost={ghostControls}
					goal={goalControls}
					imageGen={imageGen}
					onAttach={showAttach ? onAttach : undefined}
					onDirectorySelect={onDirectorySelect}
					onMenuOpenChange={onMenuOpenChange}
					onSketch={onSketch}
					pluginControls={pluginControls}
					videoGen={videoGen}
				/>
			)}
			{inLiveCall ? null : leftActions}
		</motion.div>
	);

	const rightCluster = inLiveCall ? (
		<motion.div
			className="col-start-3 row-start-1 flex shrink-0 items-center gap-1"
			data-slot="composer-live-call-actions"
			layout={motionEnabled ? "position" : false}
			transition={transition}
		>
			{liveCallActions}
		</motion.div>
	) : (
		<motion.div
			className={
				compact
					? "col-start-3 row-start-1 flex shrink-0 items-center gap-1"
					: "flex items-center gap-1"
			}
			layout={motionEnabled ? "position" : false}
			transition={transition}
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
					disabled={disabled}
					onClick={onExpand}
					size="icon-sm"
					title="Expand composer"
					type="button"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={ExpandIcon} />
				</Button>
			)}
			{/* Recording is shown as the full-width waveform that replaces the
			    textarea (see input-bar). Here we only surface the transcribing
			    spinner-wave, so the two waveforms never render at once. */}
			{hasVoice && isTranscribing && (
				<span className="inline-flex h-4 w-8 text-muted-foreground">
					<Wave aria-label="Transcribing" className="h-4 w-8" />
				</span>
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
			{/* Live voice mode is its own quiet button beside the mic; it never
			    takes the send slot, so Send is always in the same place. */}
			{voiceMode && !isStreaming ? (
				<VoiceCallButton
					disabled={voiceMode.disabled}
					onStart={voiceMode.onStart}
				/>
			) : null}
			{/* Trailing action: Send (dimmed when empty), Stop for an active turn
			    with an empty composer, or STT dictation when there is no voice mode. */}
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
			/>
		</motion.div>
	);

	const actionRow = (
		<div
			className={
				compact
					? "contents"
					: "order-2 flex items-center justify-between gap-2 px-2 pt-0.5 pb-2"
			}
		>
			{leftCluster}
			{rightCluster}
		</div>
	);

	return (
		<motion.div
			className={
				compact
					? "grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"
					: "flex flex-col gap-0"
			}
			data-composer-layout={compact ? "compact" : "full"}
			data-composer-motion={motionEnabled ? "on" : "off"}
			layout={motionEnabled}
			transition={transition}
		>
			<motion.div
				className={
					compact
						? "col-start-2 row-start-1 flex min-w-0 flex-1 items-center"
						: "order-1 w-full"
				}
				layout={motionEnabled}
				transition={transition}
			>
				{center}
			</motion.div>
			{actionRow}
		</motion.div>
	);
}
