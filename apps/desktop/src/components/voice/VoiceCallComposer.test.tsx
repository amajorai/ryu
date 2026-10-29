import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceMode } from "@/src/hooks/useVoiceMode.ts";
import {
	VoiceCallActions,
	VoiceCallContent,
	VoiceCallGlow,
	voiceTurnMessages,
} from "./VoiceCallComposer.tsx";

const VOICE: VoiceMode = {
	agentName: "Nova Assistant",
	active: true,
	caption: "I found the next step.",
	error: "",
	elapsedSeconds: 83,
	interrupt: () => undefined,
	levels: [0.2, 0.7, 0.4],
	muted: false,
	phase: "speaking",
	start: () => undefined,
	stop: () => undefined,
	toggleMute: () => undefined,
	transcript: "What should I do next?",
	turns: [
		{ id: "u-1", role: "user", text: "What should I do next?" },
		{ id: "a-1", role: "assistant", text: "I found the next step." },
	],
};

function actions(voice: VoiceMode) {
	return renderToStaticMarkup(<VoiceCallActions voice={voice} />);
}

test("renders the call identity, timer, and live caption", () => {
	const markup = renderToStaticMarkup(<VoiceCallContent voice={VOICE} />);

	expect(markup).toContain('data-testid="voice-call-screen"');
	expect(markup).toContain('aria-label="Voice call with Nova Assistant"');
	expect(markup).toContain("Nova Assistant");
	expect(markup).toContain('data-testid="voice-call-duration">01:23');
	expect(markup).toContain("I found the next step.");
});

test("wraps the card in the libraries.dev voice glow", () => {
	const markup = renderToStaticMarkup(
		<VoiceCallGlow voice={VOICE}>
			<div className="rounded-2xl">card</div>
		</VoiceCallGlow>
	);

	expect(markup).toContain("data-voice-beam=");
	expect(markup).toContain('data-processing="false"');
	expect(markup).toContain("card");
	expect(markup).not.toContain("aurora");
});

test("renders call controls in place of the send button", () => {
	const markup = actions(VOICE);

	expect(markup).not.toContain("text history");
	expect(markup).toContain('aria-label="Mute microphone"');
	expect(markup).toContain('aria-label="Interrupt response"');
	expect(markup).toContain('aria-label="End call"');
	expect(markup).not.toContain("lucide-phone-off");
});

test("only offers Interrupt while the assistant responds", () => {
	const markup = actions({ ...VOICE, phase: "listening" });

	expect(markup).not.toContain('aria-label="Interrupt response"');
});

test("keeps errors visible in the call row", () => {
	const markup = renderToStaticMarkup(
		<VoiceCallContent
			voice={{ ...VOICE, error: "Microphone permission is required." }}
		/>
	);

	expect(markup).toContain('role="alert"');
	expect(markup).toContain("Microphone permission is required.");
});

test("gathers the voice glow into a beam while the assistant is thinking", () => {
	const voice: VoiceMode = { ...VOICE, phase: "thinking" };
	const glow = renderToStaticMarkup(
		<VoiceCallGlow voice={voice}>
			<div />
		</VoiceCallGlow>
	);
	const content = renderToStaticMarkup(<VoiceCallContent voice={voice} />);

	expect(glow).toContain('data-processing="true"');
	expect(content).toContain("Preparing a response");
});

test("does not repeat connected or listening labels beside the visualizer", () => {
	const markup = renderToStaticMarkup(
		<VoiceCallContent
			voice={{ ...VOICE, phase: "listening", transcript: "" }}
		/>
	);

	expect(markup).not.toContain("Connected to");
	expect(markup).not.toContain("Listening");
	expect(markup).not.toContain('role="status"');
});

test("turns call turns into chat messages without raw widget blocks", () => {
	const messages = voiceTurnMessages([
		...VOICE.turns,
		{
			id: "a-2",
			role: "assistant",
			text: 'Here you go.\n```ryu-widget\n{"kind":"nope"}\n```',
		},
		{ id: "a-3", role: "assistant", text: '```ryu-widget\n{"kind":"x"}\n```' },
	]);

	expect(messages.map((message) => message.id)).toEqual([
		"voice-call-u-1",
		"voice-call-a-1",
		"voice-call-a-2",
	]);
	expect(messages[0]?.role).toBe("user");
	expect(messages[2]?.parts).toEqual([{ text: "Here you go.", type: "text" }]);
	// Synthetic call ids are never persisted, so they are marked read-only.
	expect(messages.every((message) => message.metadata)).toBe(true);
	expect(messages[0]?.metadata).toEqual({ ryuEphemeral: true });
});
