"use client";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type UseChatHelpers, useChat as useBaseChat } from "@ai-sdk/react";
import { AIChatPlugin } from "@platejs/ai/react";
import { aiChatPlugin } from "@ryu/ui/components/editor/plugins/ai-kit.tsx";
import { getEditorAiConfig } from "@ryu/ui/lib/editor-ai.ts";
import {
	convertToModelMessages,
	DefaultChatTransport,
	streamText,
	type UIMessage,
} from "ai";
import type { PlateEditor } from "platejs/react";
import { useEditorRef, usePluginOption } from "platejs/react";
import { useEffect, useMemo } from "react";

// System prompt for the editor's inline AI. Keep outputs as clean Markdown the
// editor can splice in directly — no preamble, no fences around the whole reply.
const EDITOR_AI_SYSTEM =
	"You are an inline writing assistant embedded in a Markdown document editor. " +
	"Follow the user instruction precisely (continue writing, improve, fix grammar, " +
	"summarize, change tone, rewrite, etc.). Return ONLY the resulting Markdown " +
	"content with no preamble, explanation, or surrounding code fences.";

/**
 * Surfaced to the user (via `chat.error`) when the host app has not registered a
 * Gateway-backed editor AI. The editor fails CLOSED: it never fabricates output.
 */
export const EDITOR_AI_UNCONFIGURED_ERROR =
	"Editor AI is not configured. Turn it on in Settings → Editor and pick a model.";

export type ToolName = "comment" | "edit" | "generate";

// biome-ignore lint/style/useConsistentTypeDefinitions: must be a type alias, not an interface — ai@6's `UIDataTypes` is `Record<string, unknown>` and an interface has no implicit index signature, so an interface here fails the UIMessage constraint (TS2344).
export type MessageDataPart = {
	toolName: ToolName;
};

export type Chat = UseChatHelpers<ChatMessage>;

export type ChatMessage = UIMessage<{}, MessageDataPart>;

/**
 * Unmask the real failure. `toUIMessageStreamResponse` defaults to
 * `() => 'An error occurred.'`, which would hide a Gateway 4xx / budget block /
 * firewall block from the user.
 */
const toErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

function createChatTransport({
	api,
	editor,
}: {
	api: string;
	editor: PlateEditor;
}) {
	return new DefaultChatTransport<ChatMessage>({
		api,
		// Every editor model call routes through Ryu's Gateway (the moat: routing /
		// firewall / budgets / audit) using the host-configured, swappable model.
		// There is no local `/api/*` AI route and no mock: if the editor AI is not
		// configured, or the Gateway call fails, the error propagates to the user.
		fetch: (async (_input, init) => {
			const aiCfg = getEditorAiConfig();

			if (!(aiCfg.enabled && aiCfg.baseUrl && aiCfg.model)) {
				throw new Error(EDITOR_AI_UNCONFIGURED_ERROR);
			}

			const bodyOptions = editor.getOptions(aiChatPlugin).chatOptions?.body;
			const initBody = JSON.parse((init?.body as string) ?? "{}") as {
				messages?: ChatMessage[];
			};

			const body = {
				...initBody,
				...bodyOptions,
			};

			// Forward the chosen agent id so the Gateway can apply per-agent
			// routing / budgets / audit. The agent's model is already resolved into
			// aiCfg.model by the host app.
			const headers = aiCfg.agentId
				? { ...aiCfg.headers, "x-ryu-agent-id": aiCfg.agentId }
				: aiCfg.headers;

			const provider = createOpenAICompatible({
				name: "ryu-gateway",
				baseURL: aiCfg.baseUrl,
				apiKey: aiCfg.apiKey ?? "sk-noauth",
				headers,
			});

			// `convertToModelMessages` is async in ai@6 — the pre-mock-removal code
			// passed the un-awaited Promise straight to `streamText`, which threw and
			// was swallowed into the fake stream. That is how a broken real path went
			// unnoticed for so long: never swallow, and never fabricate.
			const messages = await convertToModelMessages(body.messages ?? []);

			const result = streamText({
				abortSignal: init?.signal ?? undefined,
				model: provider(aiCfg.model),
				system: EDITOR_AI_SYSTEM,
				messages,
			});

			return result.toUIMessageStreamResponse({ onError: toErrorMessage });
		}) as typeof fetch,
	});
}

export const useChat = () => {
	const editor = useEditorRef();
	const options = usePluginOption(aiChatPlugin, "chatOptions");

	const transport = useMemo(
		() =>
			createChatTransport({
				api: options.api || "/api/ai/command",
				editor,
			}),
		[editor, options.api]
	);

	const chat = useBaseChat<ChatMessage>({
		id: "editor",
		transport,
		...options,
	});

	// Push the latest chat helpers into the plugin option whenever the chat's
	// observable state changes. `chat` itself is a fresh object every render, and
	// `editor.setOption` re-renders this hook's subtree — so depending on `chat`'s
	// identity here would re-fire the effect on its own update and loop forever
	// ("Maximum update depth exceeded"). Depend only on the values that actually
	// change; `chat` is read fresh inside without being a dependency.
	useEffect(() => {
		editor.setOption(AIChatPlugin, "chat", chat as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chat.status, chat.messages, chat.error, editor.setOption, chat]);

	return chat;
};
