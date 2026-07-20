"use client";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { CopilotPlugin } from "@platejs/ai/react";
import { serializeMd, stripMarkdown } from "@platejs/markdown";
import { GhostText } from "@ryu/ui/components/editor/ui/ghost-text.tsx";
import { getEditorAiConfig } from "@ryu/ui/lib/editor-ai.ts";
import { generateText } from "ai";
import type { TElement } from "platejs";

import { MarkdownKit } from "./markdown-kit.tsx";

// The copilot autocomplete system prompt. Kept here (not only in the request
// body) so the Gateway-routed path below can fall back to it when a request
// omits one.
const COPILOT_SYSTEM = `You are an advanced AI writing assistant, similar to VSCode Copilot but for general text. Your task is to predict and generate the next part of the text based on the given context.

Rules:
- Continue the text naturally up to the next punctuation mark (., ,, ;, :, ?, or !).
- Maintain style and tone. Don't repeat given text.
- For unclear context, provide the most likely continuation.
- Handle code snippets, lists, or structured text if needed.
- Don't include """ in your response.
- CRITICAL: Always end with a punctuation mark.
- CRITICAL: Avoid starting a new block. Do not use block formatting like >, #, 1., 2., -, etc. The suggestion should continue in the same block as the context.
- If no context is provided or you can't generate a continuation, return "0" without explanation.`;

// Cap the autocomplete to a short continuation — ghost text is a clause, not an
// essay. Mirrors the maxOutputTokens the Plate reference API route uses.
const COPILOT_MAX_TOKENS = 64;

/**
 * Custom transport for the copilot completion. Routes the request through Ryu's
 * Gateway (OpenAI-compatible) with the host-configured model + agent, exactly
 * like the editor's Cmd+J menu (`use-chat.ts`). The copilot endpoint is
 * non-streaming: the response is plain JSON (`{ text }`) that the plugin reads
 * in `onFinish`.
 *
 * It fails CLOSED. When the editor AI is unconfigured — or the Gateway call
 * fails — this throws; `callCompletionApi` records the error on the plugin's
 * `error` option and no ghost text is offered. It never fabricates a suggestion:
 * ghost text is Tab-acceptable straight into the user's document, so inventing
 * one would silently write fiction into their file.
 */
const copilotFetch = (async (_input, init) => {
	const aiCfg = getEditorAiConfig();

	if (!(aiCfg.enabled && aiCfg.baseUrl && aiCfg.model)) {
		throw new Error(
			"Editor AI is not configured. Turn it on in Settings → Editor and pick a model."
		);
	}

	const raw = typeof init?.body === "string" ? init.body : "{}";
	const body = JSON.parse(raw) as { prompt?: string; system?: string };
	const prompt = body.prompt ?? "";
	const system = body.system ?? COPILOT_SYSTEM;

	const headers = aiCfg.agentId
		? { ...aiCfg.headers, "x-ryu-agent-id": aiCfg.agentId }
		: aiCfg.headers;

	const provider = createOpenAICompatible({
		name: "ryu-gateway",
		baseURL: aiCfg.baseUrl,
		apiKey: aiCfg.apiKey ?? "sk-noauth",
		headers,
	});

	const result = await generateText({
		abortSignal: init?.signal ?? undefined,
		maxOutputTokens: COPILOT_MAX_TOKENS,
		model: provider(aiCfg.model),
		prompt,
		system,
		temperature: 0.7,
	});

	return Response.json({ text: result.text });
}) as typeof fetch;

export const CopilotKit = [
	...MarkdownKit,
	CopilotPlugin.configure(({ api }) => ({
		options: {
			completeOptions: {
				// Never actually fetched: `copilotFetch` ignores the URL and calls the
				// Gateway provider directly. Kept only to satisfy callCompletionApi.
				api: "/api/ai/copilot",
				body: {
					system: COPILOT_SYSTEM,
				},
				fetch: copilotFetch,
				// No onError handler: a failed completion must leave the ghost text
				// empty. The plugin already records the error on its `error` option;
				// there is nothing honest to show inline for a passive suggestion.
				onFinish: (_, completion) => {
					if (completion === "0") {
						return;
					}

					api.copilot.setBlockSuggestion({
						text: stripMarkdown(completion),
					});
				},
			},
			debounceDelay: 500,
			renderGhostText: GhostText,
			getPrompt: ({ editor }) => {
				const contextEntry = editor.api.block({ highest: true });

				if (!contextEntry) {
					return "";
				}

				const prompt = serializeMd(editor, {
					value: [contextEntry[0] as TElement],
				});

				return `Continue the text up to the next punctuation mark:
  """
  ${prompt}
  """`;
			},
		},
		shortcuts: {
			accept: {
				keys: "tab",
			},
			acceptNextWord: {
				keys: "mod+right",
			},
			reject: {
				keys: "escape",
			},
			triggerSuggestion: {
				keys: "ctrl+space",
			},
		},
	})),
];
