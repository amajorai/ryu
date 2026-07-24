// apps/desktop/src/hooks/useAskScreen.ts
//
// One-shot "ask about my screen" hook for the companion overlay. Composes a
// prompt from the current screen context and streams the answer from Core
// /api/chat/stream (-> Gateway -> engine). No conversation is persisted in the
// sidebar; the conversation_id is a transient UUID scoped to each invocation.
//
// Three fixed intents are supported (explain / summarize / translate). The
// prompt templates are intentionally literal — they describe user intent, not
// provider/model config, so this is not a "hardcoded model" violation.

import { useCallback, useRef, useState } from "react";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ShadowContext } from "@/src/lib/api/shadow.ts";
import {
	neutralize,
	stripTemplateTokens,
	UNTRUSTED_NOTICE,
} from "@/src/lib/untrusted.ts";

export type AskIntent = "explain" | "summarize" | "translate";

export interface AskScreenState {
	/** The streamed answer so far (partial while loading). */
	answer: string | null;
	/** Inline error message when Core or Shadow is unavailable. */
	error: string | null;
	/** Whether a request is currently streaming. */
	loading: boolean;
}

// ---------------------------------------------------------------------------
// Prompt templates (module-level — not inside the hook or callbacks)
// ---------------------------------------------------------------------------

/**
 * The captured selection/screen text (and even the reported app name) come
 * from whatever is on screen — attacker-controlled when that is a web page or
 * document. Each captured blob is neutralized (template tokens + forged
 * boundary markers stripped, then wrapped in `<untrusted-screen-content>`
 * markers) and the prompt carries the notice so the model treats it as data,
 * never as instructions.
 */
function untrustedCtx(ctx: ShadowContext | null): {
	app: string;
	selection: string | undefined;
	screenText: string | undefined;
} {
	return {
		app: stripTemplateTokens(ctx?.active_app ?? "the current window"),
		selection: ctx?.selected_text?.trim() || undefined,
		screenText: ctx?.screen_text?.trim() || undefined,
	};
}

function explainPrompt(ctx: ShadowContext | null): string {
	const { app, selection, screenText } = untrustedCtx(ctx);
	if (selection) {
		return `Explain the following text from ${app} in plain language. ${UNTRUSTED_NOTICE}\n\n${neutralize(selection)}`;
	}
	if (screenText) {
		return `Explain what is shown on screen in ${app} in plain language. ${UNTRUSTED_NOTICE}\n\n${neutralize(screenText)}`;
	}
	return `Explain the current context in ${app} in plain language.`;
}

function summarizePrompt(ctx: ShadowContext | null): string {
	const { app, selection, screenText } = untrustedCtx(ctx);
	if (selection) {
		return `Summarize the following text from ${app} concisely. ${UNTRUSTED_NOTICE}\n\n${neutralize(selection)}`;
	}
	if (screenText) {
		return `Summarize what is visible on screen in ${app} in a few sentences. ${UNTRUSTED_NOTICE}\n\n${neutralize(screenText)}`;
	}
	return `Summarize the current context in ${app} in a few sentences.`;
}

function translatePrompt(ctx: ShadowContext | null): string {
	const { app, selection, screenText } = untrustedCtx(ctx);
	if (selection) {
		return `Translate the following text from ${app} to English. ${UNTRUSTED_NOTICE}\n\n${neutralize(selection)}`;
	}
	if (screenText) {
		return `Translate the visible text on screen in ${app} to English. ${UNTRUSTED_NOTICE}\n\n${neutralize(screenText)}`;
	}
	return `Translate the current content in ${app} to English.`;
}

/** Distinct prompt templates for each intent. */
const PROMPT_TEMPLATES: Record<
	AskIntent,
	(ctx: ShadowContext | null) => string
> = {
	explain: explainPrompt,
	summarize: summarizePrompt,
	translate: translatePrompt,
};

// ---------------------------------------------------------------------------
// Stream reader helper (module-level to reduce callback complexity)
// ---------------------------------------------------------------------------

type SetState = (updater: (prev: AskScreenState) => AskScreenState) => void;

/** Read an AI SDK Vercel stream and accumulate text deltas into state. */
async function readAiStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	setState: SetState
): Promise<string> {
	const decoder = new TextDecoder();
	let accumulated = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		const chunk = decoder.decode(value, { stream: true });
		// The AI SDK stream emits lines like `0:"token"` for text deltas.
		for (const line of chunk.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("0:")) {
				try {
					const token = JSON.parse(trimmed.slice(2)) as string;
					accumulated += token;
					setState((prev) => ({ ...prev, answer: accumulated }));
				} catch {
					// Non-JSON lines (e.g. metadata chunks) are safe to skip.
				}
			}
		}
	}
	return accumulated;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Streams a one-shot ask-about-my-screen answer from Core.
 *
 * The caller passes the pre-fetched `context` (may be `null` when Shadow is
 * down) so the hook composes the prompt from whatever is available.
 */
export function useAskScreen(target: ApiTarget) {
	const [state, setState] = useState<AskScreenState>({
		loading: false,
		answer: null,
		error: null,
	});

	const abortRef = useRef<AbortController | null>(null);

	const ask = useCallback(
		async (intent: AskIntent, context: ShadowContext | null) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			setState({ loading: true, answer: null, error: null });

			const prompt = PROMPT_TEMPLATES[intent](context);
			// A transient conversation_id scoped to this invocation only — not
			// registered in the sidebar or persisted across restarts.
			const conversationId = `companion-${crypto.randomUUID()}`;

			try {
				const resp = await fetch(chatStreamUrl(target), {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...chatHeaders(target),
					},
					body: JSON.stringify({
						conversation_id: conversationId,
						messages: [{ role: "user", content: prompt }],
						enable_long_term: false,
						// Tag this as companion-sourced egress (screen context) so the
						// Gateway applies unconditional DLP/PII redaction, matching what
						// the island companion sets (use-island-chat.ts). Without it the
						// overlay's screen-derived prompt bypasses companion DLP.
						companion_source: true,
					}),
					signal: controller.signal,
				});

				if (!resp.ok) {
					const text = await resp.text().catch(() => resp.statusText);
					setState({
						loading: false,
						answer: null,
						error: `Core returned ${resp.status}: ${text}`,
					});
					return;
				}

				const reader = resp.body?.getReader();
				if (!reader) {
					setState({
						loading: false,
						answer: null,
						error: "No response body from Core.",
					});
					return;
				}

				const accumulated = await readAiStream(reader, setState);
				setState({ loading: false, answer: accumulated || null, error: null });
			} catch (err) {
				if ((err as { name?: string }).name === "AbortError") {
					setState({ loading: false, answer: null, error: null });
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				setState({
					loading: false,
					answer: null,
					error: `Request failed: ${message}`,
				});
			}
		},
		[target]
	);

	const reset = useCallback(() => {
		abortRef.current?.abort();
		setState({ loading: false, answer: null, error: null });
	}, []);

	return { ...state, ask, reset };
}
