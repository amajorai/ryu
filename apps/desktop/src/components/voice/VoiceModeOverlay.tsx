// Full-screen voice-mode overlay: a central state orb (idle/listening/thinking/
// speaking), the live user transcript + streaming assistant caption, and controls
// to interrupt (barge-in) or close. Driven entirely by the `useVoiceMode` hook's
// state — no logic here beyond presentation.

import { Mic, Square, X } from "lucide-react";
import type { VoiceMode } from "@/src/hooks/useVoiceMode.ts";

/** Human label + orb treatment per phase. */
const PHASE_META: Record<
	VoiceMode["phase"],
	{ label: string; ring: string; pulse: boolean }
> = {
	connecting: { label: "Connecting…", ring: "bg-muted", pulse: false },
	idle: { label: "Listening…", ring: "bg-info/70", pulse: true },
	listening: { label: "Listening…", ring: "bg-info", pulse: true },
	thinking: { label: "Thinking…", ring: "bg-warning", pulse: true },
	speaking: { label: "Speaking…", ring: "bg-success", pulse: true },
};

interface VoiceModeOverlayProps {
	voice: VoiceMode;
}

export function VoiceModeOverlay({ voice }: VoiceModeOverlayProps) {
	const meta = PHASE_META[voice.phase];
	const canInterrupt = voice.phase === "speaking" || voice.phase === "thinking";

	return (
		<div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-10 bg-background/80 backdrop-blur-xl">
			{/* Close */}
			<button
				aria-label="Exit voice mode"
				className="absolute top-6 right-6 rounded-full p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
				onClick={voice.stop}
				type="button"
			>
				<X className="size-5" />
			</button>

			{/* Orb */}
			<div className="relative flex size-40 items-center justify-center">
				<div
					className={`absolute inset-0 rounded-full ${meta.ring} opacity-30 ${
						meta.pulse ? "animate-ping" : ""
					}`}
				/>
				<div
					className={`absolute inset-4 rounded-full ${meta.ring} opacity-60 transition-all`}
				/>
				<Mic className="relative size-10 text-white" />
			</div>

			<p className="font-medium text-lg text-muted-foreground">{meta.label}</p>

			{/* Transcript + caption */}
			<div className="flex min-h-24 w-full max-w-xl flex-col gap-3 px-6 text-center">
				{voice.transcript.length > 0 && (
					<p className="text-muted-foreground text-sm">“{voice.transcript}”</p>
				)}
				{voice.caption.length > 0 && (
					<p className="text-balance text-foreground text-lg leading-relaxed">
						{voice.caption}
					</p>
				)}
				{voice.error && (
					<p className="text-destructive text-sm">{voice.error}</p>
				)}
			</div>

			{/* Interrupt */}
			{canInterrupt && (
				<button
					className="flex items-center gap-2 rounded-full bg-muted px-5 py-2.5 font-medium text-foreground text-sm transition hover:bg-muted/70"
					onClick={voice.interrupt}
					type="button"
				>
					<Square className="size-4 fill-current" />
					Interrupt
				</button>
			)}
		</div>
	);
}
