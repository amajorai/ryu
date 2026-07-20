// The continuous voice-mode surface, shown as the island's `expanded` view when
// `expandedView === "voice"`. A compact orb + phase label, the live user
// transcript and streaming assistant caption, and Interrupt / Close controls.
// Driven entirely by the `useVoiceMode` hook state — no logic here.

import { motion } from "motion/react";
import type { VoiceMode } from "../hooks/use-voice-mode.ts";

/** Label + orb tint per phase. */
const PHASE_META: Record<VoiceMode["phase"], { label: string; tint: string }> =
	{
		connecting: { label: "Connecting…", tint: "bg-neutral-500" },
		idle: { label: "Listening…", tint: "bg-sky-400" },
		listening: { label: "Listening…", tint: "bg-sky-400" },
		thinking: { label: "Thinking…", tint: "bg-amber-400" },
		speaking: { label: "Speaking…", tint: "bg-emerald-400" },
	};

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

	return (
		<div className="flex h-full w-full flex-col items-center gap-4 px-5 py-4 text-neutral-100">
			{composerControls ? (
				<div className="w-full shrink-0">{composerControls}</div>
			) : null}
			{/* Orb + phase */}
			<div className="flex flex-col items-center gap-2">
				<div className="relative flex size-16 items-center justify-center">
					<motion.div
						animate={{ scale: [1, 1.25, 1], opacity: [0.5, 0.15, 0.5] }}
						className={`absolute inset-0 rounded-full ${meta.tint}`}
						transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY }}
					/>
					<div className={`size-8 rounded-full ${meta.tint}`} />
				</div>
				<p className="font-medium text-neutral-300 text-sm">{meta.label}</p>
			</div>

			{/* Transcript + caption */}
			<div className="flex min-h-16 w-full flex-col gap-2 overflow-y-auto text-center">
				{voice.transcript.length > 0 && (
					<p className="text-neutral-400 text-xs">“{voice.transcript}”</p>
				)}
				{voice.caption.length > 0 && (
					<p className="text-balance text-neutral-100 text-sm leading-relaxed">
						{voice.caption}
					</p>
				)}
				{voice.error && <p className="text-red-400 text-xs">{voice.error}</p>}
			</div>

			{/* Controls */}
			<div className="mt-auto flex items-center gap-2">
				{canInterrupt && (
					<button
						className="rounded-full bg-white/10 px-4 py-1.5 font-medium text-neutral-100 text-xs transition hover:bg-white/20"
						onClick={voice.interrupt}
						type="button"
					>
						Interrupt
					</button>
				)}
				<button
					className="rounded-full bg-white/10 px-4 py-1.5 font-medium text-neutral-100 text-xs transition hover:bg-white/20"
					onClick={onClose}
					type="button"
				>
					End
				</button>
			</div>
		</div>
	);
}
