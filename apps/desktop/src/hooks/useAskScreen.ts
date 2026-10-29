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

import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelChat, chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ShadowContext } from "@/src/lib/api/shadow.ts";
import { responseModeForInterface } from "@/src/lib/chat-routing.ts";
import { readInterfaceLevel } from "@/src/lib/interface-level.ts";
import { readUiMessageText } from "@/src/lib/ui-message-text-stream.ts";
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
function untrustedCtx(ctx: ShadowContext | null) {
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
const PROMPT_TEMPLATES = {
	explain: explainPrompt,
	summarize: summarizePrompt,
	translate: translatePrompt,
} satisfies Record<AskIntent, (ctx: ShadowContext | null) => string>;

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

	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const abortRef = useRef<AbortController | null>(null);
	// The Core turn of the answer still streaming. Core keeps a turn running after
	// its request is aborted, so discarding an answer must also cancel it there.
	const liveTurnRef = useRef<{
		conversationId: string;
		target: ApiTarget;
	} | null>(null);
	const stopInFlight = useCallback(() => {
		abortRef.current?.abort();
		const live = liveTurnRef.current;
		liveTurnRef.current = null;
		if (live) {
			cancelChat(live.target, live.conversationId).catch(() => {
				// No live turn, or Core is unreachable; the abort above still stands.
			});
		}
	}, []);
	useEffect(() => {
		stopInFlight();
		setState({ loading: false, answer: null, error: null });
		return stopInFlight;
	}, [stopInFlight, target.url, target.token, target.userJwt]);

	const ask = useCallback(
		async (intent: AskIntent, context: ShadowContext | null) => {
			stopInFlight();
			const controller = new AbortController();
			abortRef.current = controller;

			setState({ loading: true, answer: null, error: null });

			const prompt = PROMPT_TEMPLATES[intent](context);
			// A transient conversation_id scoped to this invocation only — not
			// registered in the sidebar or persisted across restarts.
			const conversationId = `companion-${crypto.randomUUID()}`;
			const liveTurn = { conversationId, target };
			liveTurnRef.current = liveTurn;
			const settle = () => {
				if (liveTurnRef.current === liveTurn) {
					liveTurnRef.current = null;
				}
			};

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
						response_mode: responseModeForInterface(readInterfaceLevel()),
						enable_long_term: false,
						// Tag this as companion-sourced egress (screen context) so the
						// Gateway applies unconditional DLP/PII redaction, matching what
						// the island companion sets (use-island-chat.ts). Without it the
						// overlay's screen-derived prompt bypasses companion DLP.
						companion_source: true,
					}),
					signal: controller.signal,
				});

				if (controller.signal.aborted) {
					return;
				}
				if (!resp.ok) {
					const text = await resp.text().catch(() => resp.statusText);
					setState({
						loading: false,
						answer: null,
						error: tlRef.current("Core returned {status}: {text}", {
							status: resp.status,
							text,
						}),
					});
					return;
				}

				if (!resp.body) {
					setState({
						loading: false,
						answer: null,
						error: "No response body from Core.",
					});
					return;
				}

				const { text, error } = await readUiMessageText(
					resp.body,
					(partial) => {
						if (!controller.signal.aborted) {
							setState((prev) => ({ ...prev, answer: partial }));
						}
					}
				);
				if (controller.signal.aborted) {
					return;
				}
				settle();
				// An empty answer is reported, never shown as nothing at all.
				setState({
					loading: false,
					answer: text || null,
					error: error ?? (text ? null : "Core returned an empty answer."),
				});
			} catch (err) {
				if (controller.signal.aborted) {
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				setState({
					loading: false,
					answer: null,
					error: tlRef.current("Request failed: {message}", { message }),
				});
			}
		},
		[stopInFlight, target]
	);

	const reset = useCallback(() => {
		stopInFlight();
		setState({ loading: false, answer: null, error: null });
	}, [stopInFlight]);

	return { ...state, ask, reset };
}
