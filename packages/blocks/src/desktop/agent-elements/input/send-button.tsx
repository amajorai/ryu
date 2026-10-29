import { CallIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	IconArrowUp,
	IconMicrophone,
	IconPlayerStopFilled,
} from "@tabler/icons-react";

/**
 * Voice controls handed to the trailing button. When present and the composer is
 * empty (`state === "idle"`), the single trailing button *becomes* the voice-mode
 * trigger — so an empty composer shows one mic button, and it morphs into the send
 * arrow the moment the user types. This keeps the toolbar to a single trailing
 * action instead of a separate mic + send pair.
 */
export interface SendButtonVoice {
	disabled?: boolean;
	isRecording: boolean;
	isTranscribing: boolean;
	onStart: () => void;
	onStop: () => void;
}

/**
 * Live voice-mode entry handed to the trailing button. When present and the
 * composer is empty, the trailing button *becomes* the realtime voice-mode
 * trigger (opens the compact voice call surface) — the ChatGPT-style continuous
 * loop, distinct from `voice` (push-to-talk STT dictation, which relocates to
 * its own small toolbar button when this owns the trailing slot).
 */
export interface SendButtonVoiceMode {
	disabled?: boolean;
	onStart: () => void;
}

export interface SendButtonProps {
	onClick?: () => void;
	state: "idle" | "typing" | "streaming";
	/**
	 * When supplied, the empty-composer state renders the mic (voice mode) in the
	 * send button's slot instead of a disabled arrow.
	 */
	voice?: SendButtonVoice;
	/**
	 * When supplied, the empty-composer state renders the live voice-mode waveform
	 * in the send button's slot. Takes precedence over `voice` for that slot.
	 */
	voiceMode?: SendButtonVoiceMode;
}

export function SendButton({
	state,
	onClick,
	voice,
	voiceMode,
}: SendButtonProps) {
	const isStreaming = state === "streaming";
	const isTyping = state === "typing";

	// Run in flight — stop the stream. Highest priority.
	if (isStreaming) {
		return (
			<Button
				appearance="composer-stop"
				aria-label="Stop"
				onClick={onClick}
				size="icon"
				type="button"
			>
				<IconPlayerStopFilled className="size-4" />
			</Button>
		);
	}

	// Live voice-mode entry owns the empty-composer slot when wired — a mode
	// trigger that opens the realtime overlay, not STT dictation. STT (`voice`)
	// relocates to its own small toolbar button when this holds the slot.
	if (voiceMode && !isTyping) {
		return (
			<Button
				appearance="composer-call"
				aria-label="Start voice call"
				disabled={voiceMode.disabled}
				onClick={voiceMode.onStart}
				size="icon"
				title="Start voice call"
				type="button"
			>
				<HugeiconsIcon className="size-4" icon={CallIcon} />
			</Button>
		);
	}

	// Voice mode owns the empty-composer slot. Recording / transcribing are only
	// reachable from empty (typing hides the mic), so they live here too.
	if (voice && !isTyping) {
		if (voice.isRecording) {
			return (
				<Button
					appearance="composer-recording"
					aria-label="Stop recording"
					onClick={voice.onStop}
					size="icon"
					title="Stop recording"
					type="button"
				>
					<IconPlayerStopFilled className="size-3.5" />
				</Button>
			);
		}
		if (voice.isTranscribing) {
			return (
				<Button
					appearance="composer-pending"
					aria-label="Transcribing"
					loading
					size="icon"
					title="Transcribing…"
					type="button"
				/>
			);
		}
		return (
			<Button
				appearance="composer-dictation"
				aria-label="Start voice input"
				disabled={voice.disabled}
				onClick={voice.onStart}
				size="icon"
				title="Voice input"
				type="button"
			>
				<IconMicrophone className="size-4" />
			</Button>
		);
	}

	// Send: bright when there's text to send, muted+disabled when empty (no voice).
	return (
		<Button
			appearance={isTyping ? "composer-send" : "composer-pending"}
			aria-label="Send"
			disabled={!isTyping}
			onClick={onClick}
			size="icon"
			type="button"
		>
			{isTyping ? (
				<IconArrowUp className="size-4" />
			) : (
				<IconArrowUp className="size-4" />
			)}
		</Button>
	);
}
