import {
	ArrowUp02Icon,
	CallIcon,
	Mic01Icon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";

/**
 * Voice controls handed to the trailing button. When present and the composer is
 * empty (`state === "idle"`), the single trailing button *becomes* the dictation
 * trigger — so an empty composer shows one mic button, and it morphs into the send
 * arrow the moment the user types. Hosts with live voice mode pass no `voice`
 * here: dictation then has its own mic button and Send keeps its slot.
 */
export interface SendButtonVoice {
	disabled?: boolean;
	isRecording: boolean;
	isTranscribing: boolean;
	onStart: () => void;
	onStop: () => void;
}

/**
 * Live voice-mode entry. It no longer owns the send slot: it is its own quiet
 * `ghost-muted` icon button beside the mic (see {@link VoiceCallButton}), so Send
 * always stays where the eye expects it.
 */
export interface SendButtonVoiceMode {
	disabled?: boolean;
	onStart: () => void;
}

export interface SendButtonProps {
	onClick?: () => void;
	state: "idle" | "typing" | "streaming";
	/**
	 * When supplied, the empty-composer state renders the mic (dictation) in the
	 * send button's slot instead of a dimmed arrow.
	 */
	voice?: SendButtonVoice;
}

/** Every trailing composer action shares one 32px round footprint. */
const SLOT = "size-8";

/** The realtime voice-call entry: a quiet icon button, never the send slot. */
export function VoiceCallButton({ disabled, onStart }: SendButtonVoiceMode) {
	return (
		<Button
			aria-label="Start voice call"
			disabled={disabled}
			onClick={onStart}
			size="icon-sm"
			title="Start voice call"
			type="button"
			variant="ghost-muted"
		>
			<HugeiconsIcon className="size-4" icon={CallIcon} />
		</Button>
	);
}

export function SendButton({ state, onClick, voice }: SendButtonProps) {
	const isStreaming = state === "streaming";
	const isTyping = state === "typing";

	// Run in flight — stop the stream. Highest priority.
	if (isStreaming) {
		return (
			<Button
				appearance="composer-stop"
				aria-label="Stop"
				className={SLOT}
				onClick={onClick}
				size="icon"
				type="button"
			>
				<HugeiconsIcon className="size-3.5" icon={StopIcon} />
			</Button>
		);
	}

	// Dictation owns the empty-composer slot when the host has no voice mode.
	// Recording / transcribing are only reachable from empty (typing hides the
	// mic), so they live here too.
	if (voice && !isTyping) {
		if (voice.isRecording) {
			return (
				<Button
					appearance="composer-recording"
					aria-label="Stop recording"
					className={SLOT}
					onClick={voice.onStop}
					size="icon"
					title="Stop recording"
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={StopIcon} />
				</Button>
			);
		}
		if (voice.isTranscribing) {
			return (
				<Button
					appearance="composer-pending"
					aria-label="Transcribing"
					className={SLOT}
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
				className={SLOT}
				disabled={voice.disabled}
				onClick={voice.onStart}
				size="icon"
				title="Voice input"
				type="button"
			>
				<HugeiconsIcon className="size-4" icon={Mic01Icon} />
			</Button>
		);
	}

	// Send keeps its slot: the accent circle, dimmed to 30% while there is
	// nothing to send.
	return (
		<Button
			appearance="composer-send"
			aria-label="Send"
			className={isTyping ? SLOT : `${SLOT} disabled:opacity-30`}
			disabled={!isTyping}
			onClick={onClick}
			size="icon"
			type="button"
		>
			<HugeiconsIcon className="size-4" icon={ArrowUp02Icon} />
		</Button>
	);
}
