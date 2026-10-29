import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { IconMicrophone, IconPlayerStopFilled } from "@tabler/icons-react";

export interface VoiceInputButtonProps {
	className?: string;
	disabled?: boolean;
	isRecording: boolean;
	isTranscribing: boolean;
	onStart: () => void;
	onStop: () => void;
}

/** Compact dictation control shared by the composer and composer prompts. */
export function VoiceInputButton({
	disabled,
	isRecording,
	isTranscribing,
	onStart,
	onStop,
	className,
}: VoiceInputButtonProps) {
	if (isTranscribing) {
		return (
			<Button
				appearance="dictation-pending"
				aria-label="Transcribing"
				className={cn(className)}
				loading
				size="icon"
				title="Transcribing…"
				type="button"
				variant="ghost"
			/>
		);
	}
	if (isRecording) {
		return (
			<Button
				appearance="dictation-recording"
				aria-label="Stop recording"
				className={cn(className)}
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
			appearance="dictation-ready"
			aria-label="Start voice input"
			className={cn(className)}
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
