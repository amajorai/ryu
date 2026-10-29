// The live voice call, morphed into the chat composer. Instead of a full-screen
// call card stacked on top of a second text composer, the composer card itself
// becomes the call: the text field turns into the call identity, timer, and live
// caption; Send/model controls turn into the call controls; and the "+" menu
// stays where it was. The card wears the voice glow on its bottom edge (the
// exact libraries.dev `voice-glow` beam, via `VoiceGlow`), reacting to the mic and
// sweeping while the assistant is thinking. Finished call turns
// stream into the transcript as normal chat messages, driven by the "Show
// transcript in voice mode" desktop setting (`ryu:voice-show-transcript`,
// default ON), so the composer never needs its own transcript panel.

import { CallDisabled02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatVoiceMode } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { VoiceGlow } from "@ryu/ui/components/voice-glow.tsx";
import type { UIMessage } from "ai";
import { Mic, MicOff, Square } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { widgetDefinition } from "@/src/components/dashboard/widgets/registry.tsx";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import type { VoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { VOICE_SHOW_TRANSCRIPT_KEY } from "@/src/lib/voice-prefs.ts";
import { formatVoiceCallDuration, getVoiceCallInitials } from "./voice-call.ts";
import { extractVoiceWidgets } from "./voice-widgets.ts";

const PHASE_DETAIL = {
	connecting: "Connecting…",
	idle: "Waiting for you to speak",
	listening: "Listening for your voice",
	thinking: "Preparing a response",
	speaking: "Speaking to you",
} satisfies Record<VoiceMode["phase"], string>;

/**
 * Morph the chat composer into the live call while `voice` is active. Hosts
 * pass the result straight to `AgentChat`'s `voiceMode` (or the composer slot).
 */
export function useVoiceLiveCall(voice: VoiceMode): ChatVoiceMode {
	const [showTranscript] = usePersistedToggle(VOICE_SHOW_TRANSCRIPT_KEY, true);
	const messages = useMemo(() => voiceTurnMessages(voice.turns), [voice.turns]);
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
	if (!voice.active) {
		return { active: false };
	}
	return {
		active: true,
		liveCall: {
			actions: <VoiceCallActions voice={voice} />,
			frame: (card) => <VoiceCallGlow voice={voice}>{card}</VoiceCallGlow>,
			content: <VoiceCallContent voice={voice} />,
			header:
				showTranscript && widgets.length > 0 ? (
					<VoiceCallWidgets widgets={widgets} />
				) : null,
		},
		messages: showTranscript ? messages : undefined,
	};
}

/**
 * The call's finished turns as read-only chat messages, appended to the
 * transcript live. Once the call ends the host reloads persisted history, which
 * replaces these with Core's stored rows.
 */
export function voiceTurnMessages(turns: VoiceMode["turns"]): UIMessage[] {
	const messages: UIMessage[] = [];
	for (const turn of turns) {
		const text = displayText(turn.text);
		if (text.length === 0) {
			continue;
		}
		messages.push({
			id: `voice-call-${turn.id}`,
			// Never persisted under this id (Core stores its own rows), so the
			// transcript must not offer edit/branch/regenerate/reaction actions.
			metadata: { ryuEphemeral: true },
			parts: [{ text, type: "text" }],
			role: turn.role,
		});
	}
	return messages;
}

/**
 * The libraries.dev voice glow wrapped around the composer card: it rises with
 * the mic and gathers into a sweeping beam while the assistant is thinking.
 */
export function VoiceCallGlow({
	children,
	voice,
}: {
	children: ReactNode;
	voice: VoiceMode;
}) {
	const processing = voice.phase === "thinking";
	return (
		<VoiceGlow
			active={voice.phase !== "connecting" && (processing || !voice.muted)}
			levels={voice.levels}
			processing={processing}
		>
			{children}
		</VoiceGlow>
	);
}

/** Call identity, timer, and live caption — sits where the text field was. */
export function VoiceCallContent({ voice }: { voice: VoiceMode }) {
	const tl = useLiteralMessages();
	const liveText =
		voice.phase === "listening"
			? voice.transcript.trim()
			: voice.phase === "speaking"
				? voice.caption.trim()
				: "";
	const detailText = voice.muted
		? "Microphone muted"
		: voice.phase === "idle" || voice.phase === "listening"
			? ""
			: PHASE_DETAIL[voice.phase];

	return (
		<section
			aria-label={tl("Voice call with {agentName}", {
				agentName: voice.agentName,
			})}
			className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-1"
			data-testid="voice-call-screen"
		>
			<span
				aria-hidden="true"
				className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 font-medium text-primary text-xs"
			>
				{getVoiceCallInitials(voice.agentName)}
			</span>
			<div className="min-w-0 flex-1 leading-tight">
				<div className="flex min-w-0 items-baseline gap-2">
					<span
						className="truncate font-medium text-sm tracking-tight"
						title={voice.agentName}
					>
						{voice.agentName}
					</span>
					<span
						aria-label="Call duration"
						className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums"
						data-testid="voice-call-duration"
					>
						{formatVoiceCallDuration(voice.elapsedSeconds)}
					</span>
				</div>
				{voice.error ? (
					<p
						className="truncate text-status-destructive text-xs"
						role="alert"
						title={voice.error}
					>
						{voice.error}
					</p>
				) : (
					<p
						aria-live="polite"
						className="truncate text-muted-foreground text-xs empty:hidden"
					>
						{liveText.length > 0 ? (
							<span className="text-foreground">“{liveText}”</span>
						) : (
							detailText
						)}
					</p>
				)}
			</div>
		</section>
	);
}

/** Call controls — replace the model selector and Send button. */
export function VoiceCallActions({ voice }: { voice: VoiceMode }) {
	const canInterrupt = voice.phase === "speaking" || voice.phase === "thinking";
	return (
		<>
			<Button
				appearance={voice.muted ? "voice-call-muted" : undefined}
				aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
				aria-pressed={voice.muted}
				className="size-8"
				onClick={voice.toggleMute}
				size="icon"
				title={voice.muted ? "Unmute" : "Mute"}
				type="button"
				variant="ghost-muted"
			>
				{voice.muted ? (
					<MicOff className="size-4" />
				) : (
					<Mic className="size-4" />
				)}
			</Button>
			{canInterrupt && (
				<Button
					aria-label="Interrupt response"
					className="size-8"
					onClick={voice.interrupt}
					size="icon"
					title="Interrupt"
					type="button"
					variant="ghost-muted"
				>
					<Square className="size-3.5 fill-current" />
				</Button>
			)}
			<Button
				appearance="voice-call-end"
				aria-label="End call"
				data-testid="voice-call-end"
				onClick={voice.stop}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-4"
					icon={CallDisabled02Icon}
				/>
				<span>End</span>
			</Button>
		</>
	);
}

/** UI cards the assistant emitted during the call (` ```ryu-widget ` blocks). */
export function VoiceCallWidgets({
	widgets,
}: {
	widgets: ReturnType<typeof extractVoiceWidgets>;
}) {
	return (
		<div
			className="scroll-fade grid max-h-56 gap-3 overflow-y-auto px-3 pt-3 sm:grid-cols-2"
			data-testid="voice-call-widgets"
		>
			{widgets.map((item) => (
				<div
					className="min-h-24 overflow-hidden rounded-xl border border-border/60 bg-background p-3"
					key={item.id}
				>
					{item.widget.title && (
						<div
							className="mb-2 truncate font-medium text-sm tracking-tight"
							title={item.widget.title}
						>
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
	);
}

/** Hide raw ```ryu-widget JSON from chat bubbles; the block renders as a card. */
const WIDGET_BLOCK_RE = /```ryu-widget[\s\S]*?```/g;

function displayText(text: string): string {
	return text.replace(WIDGET_BLOCK_RE, "").trim();
}
