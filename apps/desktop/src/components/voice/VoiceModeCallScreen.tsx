import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { VoiceActivityBeam } from "@ryu/ui/components/voice-activity-beam.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ChevronDown, Mic, MicOff, PhoneOff, Square, X } from "lucide-react";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { widgetDefinition } from "@/src/components/dashboard/widgets/registry.tsx";
import type { VoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { formatVoiceCallDuration, getVoiceCallInitials } from "./voice-call.ts";
import { extractVoiceWidgets } from "./voice-widgets.ts";

interface VoicePhaseMeta {
	detail: string;
}

const PHASE_META: Record<VoiceMode["phase"], VoicePhaseMeta> = {
	connecting: {
		detail: "Starting your microphone",
	},
	idle: {
		detail: "Waiting for you to speak",
	},
	listening: {
		detail: "Listening for your voice",
	},
	thinking: {
		detail: "Preparing a response",
	},
	speaking: {
		detail: "Speaking to you",
	},
};

interface VoiceModeCallScreenProps {
	composer?: ReactNode;
	onShowTranscriptChange?: (show: boolean) => void;
	showTranscript: boolean;
	voice: VoiceMode;
}

export function VoiceModeCallScreen({
	composer,
	onShowTranscriptChange,
	showTranscript,
	voice,
}: VoiceModeCallScreenProps) {
	const [transcriptOpen, setTranscriptOpen] = useState(showTranscript);
	const meta = PHASE_META[voice.phase];
	const canInterrupt = voice.phase === "speaking" || voice.phase === "thinking";
	const { resolvedTheme } = useTheme();
	const beamTheme = resolvedTheme === "light" ? "light" : "dark";

	useEffect(() => {
		setTranscriptOpen(showTranscript);
	}, [showTranscript]);

	const assistantText = useMemo(
		() =>
			voice.turns
				.filter((turn) => turn.role === "assistant")
				.map((turn) => turn.text)
				.join("\n\n"),
		[voice.turns]
	);
	const widgets = useMemo(
		() => extractVoiceWidgets(assistantText),
		[assistantText]
	);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keep the newest call activity in view
	useEffect(() => {
		const element = scrollRef.current;
		if (element) {
			element.scrollTop = element.scrollHeight;
		}
	}, [voice.turns, voice.caption]);

	const liveText =
		voice.phase === "listening"
			? voice.transcript.trim()
			: voice.phase === "speaking"
				? voice.caption.trim()
				: "";
	const detailText =
		voice.muted || (voice.phase !== "idle" && voice.phase !== "listening")
			? voice.muted
				? "Microphone muted"
				: meta.detail
			: "";
	const showActivityText = liveText.length > 0 || detailText.length > 0;
	const hasTurns = voice.turns.length > 0;
	const avatarLabel = getVoiceCallInitials(voice.agentName);
	const hasComposer = composer !== undefined;

	return (
		<div
			className={cn(
				"fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto px-4 py-5",
				hasComposer ? "gap-2" : "gap-3"
			)}
		>
			<section
				aria-label={`Voice call with ${voice.agentName}`}
				className={cn(
					"flex w-full max-w-md shrink-0 flex-col",
					!hasComposer && "max-h-[calc(100vh-2.5rem)]"
				)}
				data-testid="voice-call-screen"
			>
				<header className="relative flex items-start justify-center px-5 pt-4">
					<div className="text-center">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
							Voice call
						</p>
						<p
							aria-label="Call duration"
							className="mt-1 text-center font-mono text-muted-foreground text-sm tabular-nums"
							data-testid="voice-call-duration"
						>
							{formatVoiceCallDuration(voice.elapsedSeconds)}
						</p>
					</div>
					<button
						aria-label="Exit voice mode"
						className="absolute top-3 right-3 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={voice.stop}
						type="button"
					>
						<X className="size-4" />
					</button>
				</header>

				<div
					className={cn(
						"flex min-h-0 flex-col items-center",
						hasComposer ? "px-5 pt-4 pb-3" : "px-6 pt-7 pb-5"
					)}
				>
					<div
						aria-hidden="true"
						className={cn(
							"flex items-center justify-center rounded-full bg-primary/15 font-semibold text-primary ring-primary/5",
							hasComposer ? "size-16 text-lg ring-6" : "size-20 text-xl ring-8"
						)}
					>
						{avatarLabel}
					</div>
					<h1
						className={cn(
							"mt-1 text-center font-medium tracking-tight",
							hasComposer ? "text-xl" : "text-2xl"
						)}
					>
						{voice.agentName}
					</h1>
					<VoiceActivityBeam
						active={voice.phase !== "connecting" && !voice.muted}
						className={cn("w-56", hasComposer ? "mt-4 h-8" : "mt-6 h-11")}
						levels={voice.levels}
						theme={beamTheme}
					/>

					{showActivityText ? (
						<div
							aria-live="polite"
							className={cn(
								"min-h-10 text-center text-muted-foreground text-sm",
								hasComposer ? "mt-2 min-h-8" : "mt-4"
							)}
						>
							{liveText.length > 0 ? (
								<span className="text-foreground">“{liveText}”</span>
							) : (
								<span>{detailText}</span>
							)}
						</div>
					) : null}

					{voice.error && (
						<p
							className="mt-2 text-center text-destructive text-sm"
							role="alert"
						>
							{voice.error}
						</p>
					)}
				</div>

				<Collapsible
					className="min-h-0"
					onOpenChange={(open) => {
						setTranscriptOpen(open);
						onShowTranscriptChange?.(open);
					}}
					open={transcriptOpen}
				>
					<div className="flex justify-center px-4">
						<CollapsibleTrigger
							aria-label={`${transcriptOpen ? "Hide" : "Show"} text history`}
							className="group flex items-center gap-1.5 py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							data-testid="voice-call-transcript-toggle"
						>
							<span>Text history</span>
							<ChevronDown
								aria-hidden="true"
								className={cn(
									"size-3.5 transition-transform",
									transcriptOpen && "rotate-180"
								)}
							/>
						</CollapsibleTrigger>
					</div>

					<CollapsibleContent className="overflow-hidden">
						{transcriptOpen && (
							<div
								aria-label="Call transcript"
								className={cn(
									"scroll-fade space-y-3 overflow-y-auto",
									hasComposer
										? "max-h-36 min-h-16 space-y-2 px-4 py-2"
										: "max-h-52 min-h-20 px-5 py-4"
								)}
								data-testid="voice-call-transcript"
								id="voice-call-transcript"
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
												className={cn(
													"max-w-[86%] whitespace-pre-wrap rounded-2xl text-sm leading-relaxed",
													hasComposer ? "px-3 py-1.5" : "px-3.5 py-2",
													turn.role === "user"
														? "bg-primary text-primary-foreground"
														: "bg-muted text-foreground"
												)}
											>
												{displayText(turn.text)}
											</div>
										</div>
									))
								) : (
									<div className="flex items-center justify-center gap-2 py-3 text-muted-foreground text-sm">
										<Mic className="size-4" />
										Start speaking — your conversation shows here.
									</div>
								)}
								{widgets.length > 0 && (
									<div className="grid gap-3 pt-1 sm:grid-cols-2">
										{widgets.map((item) => (
											<div
												className="min-h-24 overflow-hidden rounded-xl border border-border/60 bg-background p-3"
												key={item.id}
											>
												{item.widget.title && (
													<div className="mb-2 truncate font-semibold text-sm tracking-tight">
														{item.widget.title}
													</div>
												)}
												{widgetDefinition(item.widget.kind)?.render({
													widget: item.widget,
													value: item.value,
												}) ?? null}
											</div>
										))}
									</div>
								)}
							</div>
						)}
					</CollapsibleContent>
				</Collapsible>

				<footer
					className={cn(
						"flex flex-wrap items-center justify-center gap-3",
						hasComposer ? "px-4 py-3" : "px-5 py-4"
					)}
				>
					<button
						aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
						aria-pressed={voice.muted}
						className={cn(
							"flex min-w-24 items-center justify-center gap-2 rounded-full px-4 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							hasComposer ? "py-2" : "py-2.5",
							voice.muted
								? "bg-destructive/15 text-destructive hover:bg-destructive/20"
								: "bg-muted text-foreground hover:bg-muted/70"
						)}
						onClick={voice.toggleMute}
						type="button"
					>
						{voice.muted ? (
							<MicOff className="size-4" />
						) : (
							<Mic className="size-4" />
						)}
						<span>{voice.muted ? "Unmute" : "Mute"}</span>
					</button>
					{canInterrupt && (
						<button
							aria-label="Interrupt response"
							className={cn(
								"flex min-w-24 items-center justify-center gap-2 rounded-full bg-muted px-4 font-medium text-foreground text-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								hasComposer ? "py-2" : "py-2.5"
							)}
							onClick={voice.interrupt}
							type="button"
						>
							<Square className="size-3.5 fill-current" />
							<span>Interrupt</span>
						</button>
					)}
					<button
						aria-label="End call"
						className={cn(
							"flex min-w-28 items-center justify-center gap-2 rounded-full bg-destructive px-5 font-medium text-destructive-foreground text-sm transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
							hasComposer ? "py-2" : "py-2.5"
						)}
						data-testid="voice-call-end"
						onClick={voice.stop}
						type="button"
					>
						<PhoneOff className="size-4" />
						<span>End call</span>
					</button>
				</footer>
			</section>
			{composer ? (
				<section
					aria-label="Text chat composer"
					className="w-full max-w-md shrink-0"
					data-testid="voice-call-composer"
				>
					{composer}
				</section>
			) : null}
		</div>
	);
}

/** Hide raw ```ryu-widget JSON from transcript bubbles; the block renders as a card. */
const WIDGET_BLOCK_RE = /```ryu-widget[\s\S]*?```/g;

function displayText(text: string): string {
	return text.replace(WIDGET_BLOCK_RE, "").trim();
}
