// The continuous voice-mode surface, shown as the island's `expanded` view when
// `expandedView === "voice"`. One monochrome orb whose scale follows the live
// level, a phase label, the live user transcript and streaming assistant
// caption, and Interrupt / End controls. The orb is the only animated element:
// no edge glow and no pulse ring. Driven entirely by the `useVoiceMode` hook
// state — no logic here.

import { useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { motion } from "motion/react";
import { useReducedMotion } from "../hooks/use-reduced-motion.ts";
import type { VoiceMode } from "../hooks/use-voice-mode.ts";

const PHASE_LABEL = {
	connecting: { key: "island.voice.connecting", fallback: "Connecting…" },
	idle: { key: "island.voice.listening", fallback: "Listening…" },
	listening: { key: "island.voice.listening", fallback: "Listening…" },
	thinking: { key: "island.voice.thinking", fallback: "Thinking…" },
	speaking: { key: "island.voice.speaking", fallback: "Speaking…" },
} satisfies Record<VoiceMode["phase"], { key: string; fallback: string }>;

/** The orb grows with the mean level, up to this much over its rest size. */
const ORB_LEVEL_GAIN = 0.35;

function meanLevel(levels: readonly number[]): number {
	if (levels.length === 0) {
		return 0;
	}
	let total = 0;
	for (const level of levels) {
		total += Math.min(1, Math.max(0, level));
	}
	return total / levels.length;
}

function copyDetails(details: string): void {
	navigator.clipboard?.writeText(details).catch(() => {
		// Clipboard access can be refused; the details stay in the tooltip.
	});
}

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
	// Optional so the panel also renders in standalone proofs without a provider.
	const i18n = useOptionalI18n();
	const t = (key: string, fallback: string) =>
		i18n ? i18n.t(key, undefined, fallback) : fallback;
	const phase = PHASE_LABEL[voice.phase];
	const canInterrupt = voice.phase === "speaking" || voice.phase === "thinking";
	const reducedMotion = useReducedMotion();
	const live = voice.phase !== "connecting";
	const scale =
		reducedMotion || !live ? 1 : 1 + meanLevel(voice.levels) * ORB_LEVEL_GAIN;

	return (
		<div className="flex h-full w-full flex-col items-center gap-4 px-6 py-4 text-foreground">
			{composerControls ? (
				<div className="w-full shrink-0">{composerControls}</div>
			) : null}
			<div className="flex flex-col items-center gap-3">
				<div className="flex size-16 items-center justify-center">
					<motion.div
						animate={{ scale }}
						className={`size-8 rounded-full bg-foreground ${live ? "" : "opacity-40"}`}
						transition={{ duration: 0.15, ease: "easeOut" }}
					/>
				</div>
				<p aria-live="polite" className="text-muted-foreground text-sm">
					{t(phase.key, phase.fallback)}
				</p>
			</div>
			<div
				aria-live="polite"
				className="flex min-h-16 w-full flex-col gap-2 overflow-y-auto text-center"
			>
				{voice.transcript.length > 0 && (
					<p className="text-detail text-muted-foreground">
						“{voice.transcript}”
					</p>
				)}
				{voice.caption.length > 0 && (
					<p className="text-balance text-comfortable text-foreground">
						{voice.caption}
					</p>
				)}
			</div>
			{voice.error ? (
				<div className="flex items-center gap-2" role="alert">
					<p className="text-sm text-status-destructive">
						{t("island.voice.failed", "Voice mode stopped.")}
					</p>
					<Button onClick={voice.start} size="xs" variant="ghost-muted">
						{t("common.retry", "Retry")}
					</Button>
					<Button
						onClick={() => copyDetails(voice.error ?? "")}
						size="xs"
						title={voice.error}
						variant="ghost-muted"
					>
						{t("island.copy-details", "Copy details")}
					</Button>
				</div>
			) : null}
			<div className="mt-auto flex items-center gap-2">
				{canInterrupt ? (
					<Button onClick={voice.interrupt} size="sm" variant="outline">
						{t("island.voice.interrupt", "Interrupt")}
					</Button>
				) : null}
				<Button onClick={onClose} size="sm" variant="outline">
					{t("island.voice.end", "End")}
				</Button>
			</div>
		</div>
	);
}
