// The continuous voice-mode surface, shown as the island's `expanded` view when
// `expandedView === "voice"`. A compact orb + phase label, the live user
// transcript and streaming assistant caption, and Interrupt / Close controls,
// wrapped in the libraries.dev voice glow (`voice-glow`) along the panel's edge.
// Driven entirely by the `useVoiceMode` hook state — no logic here.

import { VoiceGlow } from "@ryu/ui/components/voice-glow.tsx";
import { motion } from "motion/react";
import { useReducedMotion } from "../hooks/use-reduced-motion.ts";
import type { VoiceMode } from "../hooks/use-voice-mode.ts";

/** Label + orb tint per phase. */
const PHASE_META = {
	connecting: { label: "Connecting…", tint: "bg-muted-foreground" },
	idle: { label: "Listening…", tint: "bg-info" },
	listening: { label: "Listening…", tint: "bg-info" },
	thinking: { label: "Thinking…", tint: "bg-warning" },
	speaking: { label: "Speaking…", tint: "bg-success" },
} satisfies Record<VoiceMode["phase"], { label: string; tint: string }>;

interface VoiceModePanelProps {
	composerControls?: React.ReactNode;
	onClose: () => void;
	voice: VoiceMode;
}

export function VoiceModePanel({
	voice,
	onClose,
	composerControls,
}: VoiceModePanelProps) {
	const meta = PHASE_META[voice.phase];
	const canInterrupt = voice.phase === "speaking" || voice.phase === "thinking";
	const reducedMotion = useReducedMotion();

	return (
		<VoiceGlow
			active={voice.phase !== "connecting"}
			className="h-full w-full"
			levels={voice.levels}
			processing={voice.phase === "thinking"}
		>
			<div className="flex h-full w-full flex-col items-center gap-4 rounded-[inherit] px-5 py-4 text-foreground">
				{composerControls ? (
					<div className="w-full shrink-0">{composerControls}</div>
				) : null}
				{/* Orb + phase */}
				<div className="flex flex-col items-center gap-2">
					<div className="relative flex size-16 items-center justify-center">
						<motion.div
							animate={
								reducedMotion
									? { scale: 1, opacity: 0.35 }
									: { scale: [1, 1.25, 1], opacity: [0.5, 0.15, 0.5] }
							}
							className={`absolute inset-0 rounded-full ${meta.tint}`}
							transition={
								reducedMotion
									? { duration: 0 }
									: { duration: 1.6, repeat: Number.POSITIVE_INFINITY }
							}
						/>
						<div className={`size-8 rounded-full ${meta.tint}`} />
					</div>
					<p className="font-medium text-muted-foreground text-sm">
						{meta.label}
					</p>
				</div>
				{/* Transcript + caption */}
				<div className="flex min-h-16 w-full flex-col gap-2 overflow-y-auto text-center">
					{voice.transcript.length > 0 && (
						<p className="text-muted-foreground text-xs">
							“{voice.transcript}”
						</p>
					)}
					{voice.caption.length > 0 && (
						<p className="text-balance text-foreground text-sm leading-relaxed">
							{voice.caption}
						</p>
					)}
					{voice.error && (
						<p className="text-status-destructive text-xs">{voice.error}</p>
					)}
				</div>

				{/* Controls */}
				<div className="mt-auto flex items-center gap-2">
					{canInterrupt && (
						<button
							className="rounded-full bg-muted px-4 py-1.5 font-medium text-foreground text-xs transition hover:bg-accent"
							onClick={voice.interrupt}
							type="button"
						>
							Interrupt
						</button>
					)}
					<button
						className="rounded-full bg-muted px-4 py-1.5 font-medium text-foreground text-xs transition hover:bg-accent"
						onClick={onClose}
						type="button"
					>
						End
					</button>
				</div>
			</div>
		</VoiceGlow>
	);
}
