// ChatGPT-style voice mode with the transcript visible. Instead of hiding the
// conversation behind a full-screen orb, this docks a compact panel that keeps
// the running transcript readable like normal chat and renders any UI components
// the assistant emits (```ryu-widget blocks) on the blank canvas beside it. The
// classic orb screen is still available via the "Show transcript" setting
// (see VoiceModeSurface); this is the default.

import { Mic, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { widgetDefinition } from "@/src/components/dashboard/widgets/registry.tsx";
import type { VoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { extractVoiceWidgets } from "./voice-widgets.ts";

/** Small status dot + label per phase (mirrors the orb overlay's phases). */
const PHASE_META: Record<
	VoiceMode["phase"],
	{ label: string; dot: string; pulse: boolean }
> = {
	connecting: {
		label: "Connecting…",
		dot: "bg-muted-foreground",
		pulse: false,
	},
	idle: { label: "Listening…", dot: "bg-info", pulse: true },
	listening: { label: "Listening…", dot: "bg-info", pulse: true },
	thinking: { label: "Thinking…", dot: "bg-warning", pulse: true },
	speaking: { label: "Speaking…", dot: "bg-success", pulse: true },
};

interface VoiceModePanelProps {
	voice: VoiceMode;
}

export function VoiceModePanel({ voice }: VoiceModePanelProps) {
	const meta = PHASE_META[voice.phase];
	const canInterrupt = voice.phase === "speaking" || voice.phase === "thinking";

	// Widgets are parsed from all assistant transcript text. Recompute only when
	// the assistant text changes (not on every user line).
	const assistantText = useMemo(
		() =>
			voice.turns
				.filter((t) => t.role === "assistant")
				.map((t) => t.text)
				.join("\n\n"),
		[voice.turns]
	);
	const widgets = useMemo(
		() => extractVoiceWidgets(assistantText),
		[assistantText]
	);

	// Keep the transcript scrolled to the latest line as turns stream in.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new turns/caption
	useEffect(() => {
		const el = scrollRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [voice.turns, voice.caption]);

	// The last assistant line may still be streaming — strip widget blocks from its
	// displayed caption so raw JSON never shows as text.
	const hasTurns = voice.turns.length > 0;

	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4">
			<div className="pointer-events-auto flex max-h-[70vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-2xl backdrop-blur-xl">
				{/* Header: status + close */}
				<div className="flex items-center gap-2 border-b px-4 py-2.5">
					<span className="relative flex size-2.5 items-center justify-center">
						<span
							className={`absolute inline-flex size-full rounded-full ${meta.dot} opacity-60 ${
								meta.pulse ? "animate-ping" : ""
							}`}
						/>
						<span
							className={`relative inline-flex size-2 rounded-full ${meta.dot}`}
						/>
					</span>
					<span className="font-medium text-muted-foreground text-sm">
						{meta.label}
					</span>
					<span className="flex-1" />
					{canInterrupt && (
						<button
							className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 font-medium text-foreground text-xs transition hover:bg-muted/70"
							onClick={voice.interrupt}
							type="button"
						>
							<Square className="size-3 fill-current" />
							Interrupt
						</button>
					)}
					<button
						aria-label="Exit voice mode"
						className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
						onClick={voice.stop}
						type="button"
					>
						<X className="size-4" />
					</button>
				</div>

				{/* Canvas: assistant-emitted UI components */}
				{widgets.length > 0 && (
					<div className="grid gap-3 border-b bg-muted/10 p-4 sm:grid-cols-2">
						{widgets.map((w) => (
							<div
								className="min-h-32 overflow-hidden rounded-xl border border-border/60 bg-background p-3"
								key={w.id}
							>
								{w.widget.title && (
									<div className="mb-2 truncate font-semibold text-sm tracking-tight">
										{w.widget.title}
									</div>
								)}
								{widgetDefinition(w.widget.kind)?.render({
									widget: w.widget,
									value: w.value,
								}) ?? null}
							</div>
						))}
					</div>
				)}

				{/* Transcript: chat-style log */}
				<div
					className="min-h-24 flex-1 space-y-3 overflow-y-auto px-4 py-4"
					ref={scrollRef}
				>
					{hasTurns ? (
						voice.turns.map((turn) => (
							<div
								className={
									turn.role === "user"
										? "flex justify-end"
										: "flex justify-start"
								}
								key={turn.id}
							>
								<div
									className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
										turn.role === "user"
											? "bg-primary text-primary-foreground"
											: "bg-muted text-foreground"
									}`}
								>
									{displayText(turn.text)}
								</div>
							</div>
						))
					) : (
						<div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
							<Mic className="size-4" />
							Start speaking — your conversation shows here.
						</div>
					)}
					{voice.error && (
						<p className="text-center text-destructive text-sm">
							{voice.error}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

/** Hide raw ```ryu-widget JSON from the transcript bubble (it renders as a card). */
const WIDGET_BLOCK_RE = /```ryu-widget[\s\S]*?```/g;
function displayText(text: string): string {
	return text.replace(WIDGET_BLOCK_RE, "").trim();
}
