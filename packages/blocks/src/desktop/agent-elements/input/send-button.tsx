import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconArrowUp,
	IconLoader2,
	IconMicrophone,
	IconPlayerStopFilled,
} from "@tabler/icons-react";
import { AudioLines } from "lucide-react";

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
 * trigger (opens the full-screen voice overlay) — the ChatGPT-style continuous
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

const CIRCLE = "size-7 rounded-full disabled:opacity-100";

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
				aria-label="Stop"
				className={cn(
					CIRCLE,
					"bg-foreground text-background hover:bg-foreground/90"
				)}
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
				aria-label="Start voice mode"
				className={cn(
					CIRCLE,
					"bg-primary text-primary-foreground hover:bg-primary/90"
				)}
				disabled={voiceMode.disabled}
				onClick={voiceMode.onStart}
				size="icon"
				title="Voice mode"
				type="button"
			>
				<AudioLines className="size-4" />
			</Button>
		);
	}

	// Voice mode owns the empty-composer slot. Recording / transcribing are only
	// reachable from empty (typing hides the mic), so they live here too.
	if (voice && !isTyping) {
		if (voice.isRecording) {
			return (
				<Button
					aria-label="Stop recording"
					className={cn(
						CIRCLE,
						"bg-destructive text-destructive-foreground hover:bg-destructive/90"
					)}
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
					aria-label="Transcribing"
					className={cn(CIRCLE, "bg-muted text-muted-foreground")}
					disabled
					size="icon"
					title="Transcribing…"
					type="button"
				>
					<IconLoader2 className="size-4 animate-spin" />
				</Button>
			);
		}
		return (
			<Button
				aria-label="Start voice input"
				className={cn(CIRCLE, "bg-muted text-foreground hover:bg-muted/70")}
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
			aria-label="Send"
			className={cn(
				CIRCLE,
				isTyping
					? "bg-primary text-primary-foreground"
					: "bg-muted text-muted-foreground"
			)}
			disabled={!isTyping}
			onClick={onClick}
			size="icon"
			type="button"
		>
			<IconArrowUp className="size-4" />
		</Button>
	);
}
