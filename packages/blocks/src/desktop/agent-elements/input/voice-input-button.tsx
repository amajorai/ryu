import { Mic01Icon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";

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
				className={cn("size-8", className)}
				loading
				size="icon-sm"
				title="Transcribing…"
				type="button"
				variant="ghost-muted"
			/>
		);
	}
	if (isRecording) {
		return (
			<Button
				appearance="dictation-recording"
				aria-label="Stop recording"
				className={cn("size-8", className)}
				onClick={onStop}
				size="icon-sm"
				title="Stop recording"
				type="button"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-3.5" icon={StopIcon} />
			</Button>
		);
	}
	return (
		<Button
			appearance="dictation-ready"
			aria-label="Start voice input"
			className={cn("size-8", className)}
			disabled={disabled}
			onClick={onStart}
			size="icon-sm"
			title="Voice input"
			type="button"
			variant="ghost-muted"
		>
			<HugeiconsIcon className="size-4" icon={Mic01Icon} />
		</Button>
	);
}
