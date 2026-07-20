"use client";

// Storyboard/preview wrapper around the REAL desktop chat surface
// (`agent-elements/agent-chat`). The live app renders `AgentChat` with a
// `useChat` transport and real handlers; this wrapper supplies static
// `UIMessage[]` plus no-op handlers so the same component renders in a
// server-driven storyboard panel (only serializable `variant` crosses the
// boundary; the no-op handlers live inside this client component).

import type { ChatStatus, UIMessage } from "ai";
import { AgentChat } from "./agent-elements/agent-chat.tsx";
import { InputBar } from "./agent-elements/input-bar.tsx";
import { MessageList } from "./agent-elements/message-list.tsx";

export type ChatPreviewVariant =
	| "empty"
	| "streaming"
	| "idle"
	| "tool"
	| "error"
	| "goal"
	| "queue"
	| "voice"
	| "attach"
	| "context"
	| "offline";

// Context-window meter demo: a finished assistant turn carrying a
// `data-ryu-stats` part (as Core streams) plus a known context window, so the
// composer's context ring fills to ~73% (amber warning band) with a full token
// breakdown on hover.
const CONTEXT_DEMO_WINDOW = 12_000;
const statsMessage = (): UIMessage =>
	({
		id: "assistant-1",
		role: "assistant",
		parts: [
			{ type: "text", text: `${ASSISTANT_INTRO}\n\n${ASSISTANT_DONE}` },
			{
				type: "data-ryu-stats",
				data: {
					tokensPerSecond: 47.3,
					promptTokens: 8200,
					cachedTokens: 4096,
					completionTokens: 512,
					reasoningTokens: 128,
					totalTokens: 8712,
				},
			},
		],
	}) as unknown as UIMessage;

const noop = () => {
	// Storyboard preview: the composer is inert.
};
const noopTranscribe = async (): Promise<string> => "";

const textMessage = (
	id: string,
	role: "user" | "assistant",
	text: string
): UIMessage =>
	({
		id,
		role,
		parts: [{ type: "text", text }],
	}) as unknown as UIMessage;

const REFACTOR_PROMPT = "Can you refactor the auth flow to use device codes?";

const ASSISTANT_INTRO =
	"Sure. I'll start by reading the current auth client, then add a device-code grant alongside the existing OAuth path.";

const ASSISTANT_DONE =
	"The new flow polls `/device/token` until the user approves. I've kept OAuth as the default, so existing sign-ins are untouched.";

const toolMessage = (): UIMessage =>
	({
		id: "assistant-tool",
		role: "assistant",
		parts: [
			{ type: "text", text: ASSISTANT_INTRO },
			{
				type: "tool-Read",
				toolCallId: "call_read_1",
				state: "output-available",
				input: { file_path: "src/lib/auth-client.ts" },
				output: { content: "export async function signIn() { /* … */ }" },
			},
			{
				type: "tool-Edit",
				toolCallId: "call_edit_1",
				state: "input-available",
				input: {
					file_path: "src/lib/auth-client.ts",
					old_string: "// oauth only",
					new_string: "// oauth + device code",
				},
			},
		],
	}) as unknown as UIMessage;

const conversationFor = (variant: ChatPreviewVariant): UIMessage[] => {
	if (variant === "empty" || variant === "offline") {
		return [];
	}
	const user = textMessage("user-1", "user", REFACTOR_PROMPT);
	if (variant === "context") {
		return [user, statsMessage()];
	}
	if (variant === "tool") {
		return [user, toolMessage()];
	}
	if (variant === "streaming" || variant === "goal" || variant === "queue") {
		return [user, textMessage("assistant-1", "assistant", ASSISTANT_INTRO)];
	}
	return [
		user,
		textMessage(
			"assistant-1",
			"assistant",
			`${ASSISTANT_INTRO}\n\n${ASSISTANT_DONE}`
		),
	];
};

const statusFor = (variant: ChatPreviewVariant): ChatStatus => {
	if (variant === "streaming" || variant === "goal" || variant === "queue") {
		return "streaming";
	}
	return "ready";
};

export function DesktopChatPreview({
	variant = "idle",
}: {
	variant?: ChatPreviewVariant;
}) {
	const messages = conversationFor(variant);
	const status = statusFor(variant);
	const error =
		variant === "error"
			? new Error("Stream interrupted: engine returned 503.")
			: undefined;

	const isEmptyHome = variant === "empty";

	// The voice variant exercises the real composer's microphone affordance,
	// which lives on `InputBar` (not exposed through `AgentChat`). Compose the
	// real `MessageList` + real `InputBar` so the mic + waveform render.
	if (variant === "voice") {
		return (
			<div className="flex h-full min-h-0 flex-col">
				<MessageList messages={messages} status={status} />
				<InputBar
					onSend={noop}
					onStop={noop}
					status={status}
					voice={{ transcribe: noopTranscribe }}
				/>
			</div>
		);
	}

	return (
		<AgentChat
			attachments={
				variant === "attach"
					? {
							images: [
								{
									id: "img-1",
									filename: "screenshot.png",
									url: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
								},
							],
							files: [{ id: "file-1", filename: "report.pdf", size: 248_000 }],
						}
					: undefined
			}
			contextSize={variant === "context" ? CONTEXT_DEMO_WINDOW : undefined}
			emptyStateHeader={
				isEmptyHome ? (
					<div className="mb-5 flex flex-col items-center gap-3 text-center">
						<span className="flex size-12 items-center justify-center rounded-2xl bg-primary font-bold text-primary-foreground text-xl">
							R
						</span>
						<h2 className="font-semibold text-xl">How can I help today?</h2>
					</div>
				) : undefined
			}
			emptyStatePosition={isEmptyHome ? "center" : "default"}
			error={error}
			messages={messages}
			onSend={noop}
			onStop={noop}
			status={status}
		/>
	);
}
